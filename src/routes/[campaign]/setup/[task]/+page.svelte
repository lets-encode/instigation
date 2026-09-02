<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result, FacsimileTaskData, CampaignTables } from "$lib/commands.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import { elapsed } from "$lib/campaign-board.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { readSidePanel, writeSidePanel } from "$lib/side-panels.ts";
  import { buildBlankScoreMei } from "$lib/mei-facsimile.ts";
  import type { ScoreDefModel, StaffModel, StaffGroupModel } from "$lib/mei-facsimile.ts";
  import { getVerovio, loadSnippet, renderPage } from "$lib/verovio-render.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import PanelIcon from "$lib/components/PanelIcon.svelte";
  import PieceCommentsPanel from "$lib/components/PieceCommentsPanel.svelte";
  import ScorePreview from "$lib/components/ScorePreview.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import { CommandRunner, readForge, viewerId } from "$lib/command-runner.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { resolveCampaign, resolveFailureMessage } from "$lib/campaign-resolve.ts";
  import type { ResolvedCampaign } from "$lib/campaign-resolve.ts";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);
  let resolved = $state<ResolvedCampaign | null>(null);
  let resolving = $state(false);
  let notFound = $state(false);
  // The forge lookup of the registry's repo id failed (e.g. rate limit) — the
  // campaign exists but could not be loaded, which is not a "not found".
  let resolveError = $state<string | null>(null);
  const owner = $derived(resolved?.owner ?? "");
  const repo = $derived(resolved?.repo ?? "");
  const repoId = $derived(resolved?.repoId ?? 0);
  // The acting user's stable numeric id; login is display-only.
  const viewer = $derived(viewerId());

  // The clefs and staff kinds the form offers. Each option carries the staff
  // values it sets: clef shape, octave displacement and notation type as MEI
  // writes them, the shape's conventional line, and the staff's line count.
  // A modern (guitar) tablature staff shows the TAB lettering as its clef;
  // the lute kinds carry no clef.
  const CLEF_OPTIONS = [
    { value: "G", label: "G (treble)", clefShape: "G", clefDis: "", notationType: "", clefLine: 2, lines: 5 },
    { value: "G8", label: "G, octave down", clefShape: "G", clefDis: "8", notationType: "", clefLine: 2, lines: 5 },
    { value: "F", label: "F (bass)", clefShape: "F", clefDis: "", notationType: "", clefLine: 4, lines: 5 },
    { value: "C", label: "C (alto, tenor)", clefShape: "C", clefDis: "", notationType: "", clefLine: 3, lines: 5 },
    { value: "perc", label: "Percussion", clefShape: "perc", clefDis: "", notationType: "", clefLine: 3, lines: 5 },
    { value: "TAB", label: "Tablature, modern", clefShape: "TAB", clefDis: "", notationType: "tab.guitar", clefLine: 3, lines: 6 },
    { value: "TABfr", label: "Tablature, French", clefShape: "TAB", clefDis: "", notationType: "tab.lute.french", clefLine: 3, lines: 6 },
    { value: "TABit", label: "Tablature, Italian", clefShape: "TAB", clefDis: "", notationType: "tab.lute.italian", clefLine: 3, lines: 6 },
    { value: "TABde", label: "Tablature, German", clefShape: "TAB", clefDis: "", notationType: "tab.lute.german", clefLine: 3, lines: 6 },
  ] as const;
  // The option behind a staff's stored values; an unlisted combination falls
  // back to its shape.
  const clefKey = (staff: StaffModel): string => {
    const exact = CLEF_OPTIONS.find(
      (o) =>
        o.clefShape === staff.clefShape &&
        o.clefDis === staff.clefDis &&
        o.notationType === staff.notationType,
    );
    const byShape = CLEF_OPTIONS.find((o) => o.clefShape === staff.clefShape);
    return (exact ?? byShape ?? CLEF_OPTIONS[0]).value;
  };
  // The clef line is only meaningful on the pitched shapes.
  const clefLineFixed = (staff: StaffModel): boolean =>
    staff.clefShape === "perc" || staff.clefShape === "TAB";
  const CLEF_LINES = [1, 2, 3, 4, 5];
  // A percussion staff has up to 5 lines; a tablature one line (string or
  // course) per string, 4 to 8.
  const linesChoices = (staff: StaffModel): number[] =>
    staff.clefShape === "perc" ? [1, 2, 3, 4, 5] : [4, 5, 6, 7, 8];
  const KEY_SIGNATURES = [
    { value: "0", label: "No sharps or flats" },
    ...Array.from({ length: 7 }, (_, i) => ({
      value: `${i + 1}s`,
      label: `${i + 1} sharp${i === 0 ? "" : "s"}`,
    })),
    ...Array.from({ length: 7 }, (_, i) => ({
      value: `${i + 1}f`,
      label: `${i + 1} flat${i === 0 ? "" : "s"}`,
    })),
  ];
  const METER_UNITS = [1, 2, 4, 8, 16];
  const MAX_STAVES = 24;

  let loading = $state(false);
  // Whether a load has been attempted for the current params; a failed load
  // stays on its error banner instead of retrying.
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let data = $state<FacsimileTaskData | null>(null);
  // The campaign tables behind the comments panel; refreshed on their own so
  // a posted comment never reloads the form.
  let tables = $state<CampaignTables | null>(null);
  // The form's working copy of the score definition.
  let staves = $state<StaffModel[]>([]);
  let groups = $state<StaffGroupModel[]>([]);
  let keysig = $state("0");
  // The time signature: numbers (count over unit), or one of the two MEI
  // symbols — common time (C) and cut time (¢).
  let meterType = $state<"numeric" | "common" | "cut">("numeric");
  let meterCount = $state("4");
  let meterUnit = $state("4");

  const runner = new CommandRunner();

  const canEdit = $derived(
    Boolean(data?.holdsLock) && data?.status === "encoding_required",
  );

  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo });

  // A count of 0, a blank, or anything non-numeric would emit a meter no
  // renderer can read, so the submission waits for a whole number above zero.
  // A symbol signature carries no count to get wrong.
  const meterValid = $derived(
    meterType !== "numeric" || /^[1-9]\d*$/.test(meterCount.trim()),
  );

  // Groups must fit the staves and must not overlap one another.
  const groupsValid = $derived.by(() => {
    const sorted = [...groups].sort((a, b) => a.start - b.start);
    return sorted.every(
      (g, i) =>
        g.start >= 1 &&
        g.end >= g.start &&
        g.end <= staves.length &&
        (i === 0 || g.start > sorted[i - 1].end),
    );
  });

  // A symbol signature implies its numeric meter — common time is 4/4, cut
  // time 2/2 — matching what parseScoreDef reads back.
  const scoreDef = $derived<ScoreDefModel>({
    staves: staves.map((s) => ({ ...s, label: s.label.trim() })),
    groups: groups.map((g) => ({ ...g, label: g.label.trim() })),
    keysig,
    meterCount:
      meterType === "numeric" ? meterCount.trim() : meterType === "cut" ? "2" : "4",
    meterUnit: meterType === "numeric" ? meterUnit : meterType === "cut" ? "2" : "4",
    meterSym: meterType === "numeric" ? "" : meterType,
  });

  async function load() {
    const f = forge();
    if (!f) return;
    // Results for a task the page has since navigated away from are dropped.
    const task = taskId;
    const name = campaign;
    const stale = () => task !== taskId || name !== campaign;
    loading = true;
    loadError = null;
    try {
      const [d, t] = await Promise.all([
        invoke(commands.readFacsimile, { task_id: task }, ctx(f)),
        invoke(commands.readTables, {}, ctx(f)),
      ]);
      if (stale()) return;
      data = d;
      tables = t;
      staves = d.model.scoreDef.staves.map((s) => ({ ...s }));
      groups = d.model.scoreDef.groups.map((g) => ({ ...g }));
      keysig = d.model.scoreDef.keysig;
      meterType =
        d.model.scoreDef.meterSym === "" ? "numeric" : (d.model.scoreDef.meterSym as "common" | "cut");
      meterCount = d.model.scoreDef.meterCount;
      meterUnit = d.model.scoreDef.meterUnit;
    } catch (e) {
      if (!stale()) loadError = `Could not load ${task}: ${(e as Error).message}`;
    } finally {
      if (!stale()) loading = false;
    }
  }

  // A same-route navigation to another campaign or task starts over: the
  // resolved repo and the loaded task belong to the previous params.
  $effect(() => {
    void campaign;
    resolved = null;
    notFound = false;
    resolveError = null;
  });
  $effect(() => {
    void campaign;
    void taskId;
    data = null;
    staves = [];
    loadError = null;
    loaded = false;
  });

  // Resolve the campaign name to its repo first; the load effect is gated on
  // `owner`/`repo` so it waits for this.
  $effect(() => {
    if (auth.status === "loading" || resolved || notFound || resolveError || resolving)
      return;
    resolving = true;
    // A result for a name the page has since navigated away from is dropped.
    const name = campaign;
    resolveCampaign(readForge(), name)
      .then((r) => {
        if (name !== campaign) return;
        if (r) resolved = r;
        else notFound = true;
      })
      .catch((e) => {
        if (name === campaign) resolveError = resolveFailureMessage(e);
      })
      .finally(() => (resolving = false));
  });

  // One load per param set: a failed attempt renders the error banner (with
  // its manual retry) instead of looping.
  $effect(() => {
    if (auth.status === "authenticated" && owner && repo && taskId && !loaded) {
      loaded = true;
      load();
    }
  });

  async function run(
    command: (c: CommandContext) => Promise<Result>,
    opts: { overviewOnSuccess?: boolean } = {},
  ) {
    const f = forge();
    if (!f) return;
    await runner.run(
      () => command(ctx(f)),
      async (result) => {
        // A rejected command changed nothing worth reloading for — and a
        // reload would discard the values the volunteer may retry from.
        if (result.error) return;
        if (opts.overviewOnSuccess) {
          if (result.ok && !result.warn) await goto(`/${campaign}`);
          // Still processing (warn): keep the editor and its values as they are.
          return;
        }
        // A background command changed nothing yet — the settle listener
        // reloads when its verdict lands.
        if (result.background) return;
        runner.log.step("Reloading…");
        data = null;
        await load();
      },
    );
  }

  const claim = () =>
    run((c) => invoke(commands.claimTask, { task_id: taskId }, c));

  // Opening the editor claims the task, the same way opening a score in
  // mei-friend does — a read-only look is served by the console's score
  // preview, so reaching the editor means intent to edit. Fire once per task,
  // and only when the claim can actually be granted: never while someone else
  // holds the task or a dependency still blocks it — that PR would only come
  // back rejected.
  let autoClaimedFor = $state<string | null>(null);
  $effect(() => {
    if (
      data &&
      !runner.busy &&
      autoClaimedFor !== taskId &&
      data.status === "encoding_required" &&
      !data.holdsLock &&
      !data.encodingLockUser &&
      !data.blockedBy
    ) {
      autoClaimedFor = taskId;
      claim();
    }
  });

  // The review happens here too: the same claim/pass/fail the console offers,
  // against the task's validation subtask.
  const validation = $derived(data?.validation ?? null);
  // A verdict already submitted here and still being processed: the verdict
  // controls hold until it lands — a repeat would only be rejected.
  const verdictPending = $derived(
    !!validation &&
      pendingVerdicts.isProcessing(`validate:${taskId}/${validation.subtask_id}`),
  );
  // A settled background verdict changed the tables; reload the read-only
  // view so it shows the recorded state. An edit session only refreshes the
  // tables — a reload would discard the volunteer's unsubmitted work.
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (runner.busy) return;
      if (!canEdit) {
        data = null;
        loaded = false;
      } else {
        refreshTables();
      }
    }),
  );
  const submitted = $derived(
    data?.status === "validation_required" || data?.status === "completed",
  );
  const holdsValidation = $derived(
    viewer !== "" && validation?.lockUser === viewer,
  );
  const selfValidation = $derived(
    !!data && data.encoder !== "" && data.encoder === viewer && !data.allowSelfValidation,
  );
  // One verdict per person: a validator who already recorded pass/fail here
  // cannot claim another slot (matching the campaign automation's rule).
  const alreadyValidated = $derived(
    !!data &&
      !data.allowSelfValidation &&
      (validation?.verdicts ?? []).some((v) => v.user === viewer),
  );
  const canClaimValidation = $derived(
    !!validation &&
      validation.status === "validation_required" &&
      validation.openSlots > 0 &&
      !validation.lockUser &&
      !selfValidation &&
      !alreadyValidated &&
      !verdictPending,
  );
  const failComments = $derived(data?.failComments ?? []);
  const failedVerdicts = $derived(
    (validation?.verdicts ?? []).filter((v) => v.verdict === "fail"),
  );
  // Sending a failed task back is open to a failing validator or push access —
  // the same rule the automation enforces.
  const canSendBack = $derived(
    viewer !== "" &&
      data?.status === "validation_required" &&
      failedVerdicts.length > 0 &&
      (data.canPush || failedVerdicts.some((v) => v.user === viewer)),
  );
  const sendBack = () =>
    run((c) => invoke(commands.sendBack, { task_id: taskId }, c));
  // Same hold for a send-back already on its way.
  const sendBackPending = $derived(
    pendingVerdicts.isProcessing(`sendback:${taskId}`),
  );

  // ------------------------------------------------------------- comments
  // The piece's comments panel beside the tool. Posting and resolving refresh
  // the tables only: a full reload would discard unsubmitted form values.
  let commentsPanel = $state(readSidePanel("comments"));
  async function refreshTables() {
    const f = forge();
    if (!f) return;
    try {
      tables = await invoke(commands.readTables, {}, ctx(f));
    } catch {
      /* the next full load refreshes the tables */
    }
  }
  const afterComment = async (result: Result) => {
    if (result.error || result.background) return;
    runner.log.step("Refreshing comments…");
    await refreshTables();
  };
  async function postComment(
    task_id: string,
    kind: string,
    body: string,
    parent_id: string,
  ) {
    const f = forge();
    if (!f) return;
    await runner.run(
      () =>
        invoke(
          commands.submitComment,
          {
            task_id,
            subtask_id: "",
            kind,
            body,
            page: "",
            measure_start: "",
            measure_end: "",
            parent_id,
          },
          ctx(f),
        ),
      afterComment,
    );
  }
  async function resolveCommentRow(comment_id: string) {
    const f = forge();
    if (!f) return;
    await runner.run(
      () => invoke(commands.resolveComment, { comment_id }, ctx(f)),
      afterComment,
    );
  }
  // A comment anchor turns the reference score to its page and highlights the
  // range; the measure zones show so the range is visible.
  let refPreview = $state<ReturnType<typeof ScorePreview>>();
  let anchor = $state<{ page: number; m1: number; m2: number } | null>(null);
  function showAnchorFor(c: CommentRow) {
    const m1 = Number(c.measure_start);
    const m2 = Number(c.measure_end || c.measure_start);
    anchor = {
      page: Number(c.page),
      m1: Number.isFinite(m1) ? m1 : 0,
      m2: Number.isFinite(m2) ? m2 : 0,
    };
    refPreview?.setZones(true);
    if (anchor.page) refPreview?.showPage(anchor.page - 1);
  }

  // Logins for verdict authors, fail-comment authors and the encoding lock
  // holder (id → login, display).
  let logins = $state<Record<string, string>>({});
  $effect(() => {
    const ids = new Set<string>();
    for (const v of data?.validation?.verdicts ?? []) if (v.user) ids.add(v.user);
    for (const c of data?.failComments ?? []) if (c.author_id) ids.add(c.author_id);
    if (data?.encodingLockUser) ids.add(data.encodingLockUser);
    for (const id of ids) {
      if (logins[id]) continue;
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) continue;
      readForge()
        .getUserLogin(n)
        .then((login) => {
          if (login) logins[id] = login;
        })
        .catch(() => {});
    }
  });
  // Login for the reviewer holding the validation lock (id → login, display).
  let lockUserLogin = $state("");
  $effect(() => {
    const id = Number(data?.validation?.lockUser);
    if (!Number.isInteger(id) || id <= 0) {
      lockUserLogin = data?.validation?.lockUser ?? "";
      return;
    }
    readForge()
      .getUserLogin(id)
      .then((login) => (lockUserLogin = login ?? String(id)))
      .catch(() => (lockUserLogin = String(id)));
  });
  const claimValidation = () =>
    run((c) =>
      invoke(
        commands.claimValidation,
        { task_id: taskId, subtask_id: validation!.subtask_id },
        c,
      ),
    );
  // A fail carries a mandatory comment row; pass submits bare.
  let failOpen = $state(false);
  let failText = $state("");
  const validate = (verdict: string) =>
    run(
      (c) =>
        invoke(
          commands.submitValidation,
          {
            task_id: taskId,
            subtask_id: validation!.subtask_id,
            verdict,
            ...(verdict === "fail"
              ? {
                  comment: {
                    body: failText,
                    page: "",
                    measure_start: "",
                    measure_end: "",
                  },
                }
              : {}),
          },
          c,
        ),
      { overviewOnSuccess: true },
    ).then(() => {
      // A failed submission keeps the typed comment for the retry.
      if (runner.result?.ok) {
        failOpen = false;
        failText = "";
      }
    });

  const submit = () =>
    run(
      (c) => invoke(commands.submitScoreSetup, { task_id: taskId, scoreDef }, c),
      { overviewOnSuccess: true },
    );


  // ------------------------------------------------------------------------
  // The form

  function addStaff() {
    if (staves.length >= MAX_STAVES) return;
    staves = [
      ...staves,
      {
        clefShape: "G",
        clefLine: 2,
        clefDis: "",
        clefDisPlace: "",
        lines: 5,
        notationType: "",
        label: "",
      },
    ];
  }
  function addGroup() {
    groups = [
      ...groups,
      { start: 1, end: Math.min(2, staves.length), symbol: "brace", label: "" },
    ];
  }
  function removeGroup(i: number) {
    groups = groups.filter((_, n) => n !== i);
  }
  function setClef(staff: StaffModel, key: string) {
    const option = CLEF_OPTIONS.find((o) => o.value === key) ?? CLEF_OPTIONS[0];
    staff.clefShape = option.clefShape;
    staff.clefDis = option.clefDis;
    staff.clefDisPlace = option.clefDis ? "below" : "";
    staff.notationType = option.notationType;
    staff.clefLine = option.clefLine;
    staff.lines = option.lines;
  }
  function removeStaff(i: number) {
    if (staves.length <= 1) return;
    staves = staves.filter((_, n) => n !== i);
  }
  function moveStaff(i: number, delta: number) {
    const j = i + delta;
    if (j < 0 || j >= staves.length) return;
    const next = [...staves];
    [next[i], next[j]] = [next[j], next[i]];
    staves = next;
  }

  // ------------------------------------------------------------------------
  // Preview
  //
  // The opening of the score with the values on screen, rendered as one seed
  // measure so the staves, clefs, key signature and meter can be read back
  // before they are submitted. A one-measure blank score rather than the full
  // rebuild: a facsimile piece has no measures to render before its measure
  // correction runs.
  let previewSvg = $state("");
  let previewError = $state("");
  $effect(() => {
    const model = scoreDef;
    if (!data || !meterValid || !groupsValid) return;
    const mei = buildBlankScoreMei(data.model.headXml, 0, model);
    let dropped = false;
    getVerovio()
      .then((tk) => {
        if (dropped) return;
        if (!loadSnippet(tk, mei)) throw new Error("the score could not be rendered.");
        previewSvg = renderPage(tk, 1);
        previewError = "";
      })
      .catch((e: Error) => {
        if (!dropped) previewError = `No preview: ${e.message}`;
      });
    return () => (dropped = true);
  });
</script>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="corrector">
  {#if resolveError}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {resolveError}
          <button type="button" class="linkish" onclick={() => (resolveError = null)}
            >Try again</button
          >
        </span>
      </div>
    </div>
  {:else if notFound}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          No campaign called <code>{campaign}</code> was found.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    </div>
  {:else if auth.status === "loading" || (!resolved && !notFound)}
    <div class="deskwrap"><p class="muted">Loading…</p></div>
  {:else if !auth.user}
    <div class="deskwrap">
      <div class="banner warn">
        <span>
          Please <button type="button" class="linkish" onclick={() => login()}>log in with GitHub</button>
          to work on this task.
        </span>
      </div>
    </div>
  {:else if loading}
    <div class="deskwrap"><p class="muted">Loading the score…</p></div>
  {:else if loadError}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {loadError}
          <button type="button" class="linkish" onclick={() => load()}>Try again</button>
        </span>
      </div>
    </div>
  {:else if data}
    <div class="main">
      {#if runner.result && runner.result.error}
        <div class="banner err bar">
          <span>
            {runner.result.error}
            {#if runner.result.prUrl}<a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
          </span>
        </div>
      {:else if runner.result && runner.result.ok && !runner.result.background}
        <div class="banner {runner.result.warn ? 'warn' : 'ok'} bar">
          <span>
            {runner.result.message}
            {#if runner.result.prUrl}<a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
          </span>
        </div>
      {/if}
      <TaskRunState task={taskId} bar />

      <div class="desk">
        <div class="formcol">
        <form class="setup" onsubmit={(e) => e.preventDefault()}>
          <fieldset disabled={!canEdit}>
            <p class="grouphead">Staves</p>
            <ol class="staves">
              {#each staves as staff, i (i)}
                <li class="staffrow">
                  <span class="staffno">{i + 1}</span>
                  <label class="field">
                    <span>Clef</span>
                    <select
                      value={clefKey(staff)}
                      onchange={(e) =>
                        setClef(staff, (e.target as HTMLSelectElement).value)}
                      title="The clef this staff opens with. Picking one sets its usual line."
                    >
                      {#each CLEF_OPTIONS as option (option.value)}
                        <option value={option.value}>{option.label}</option>
                      {/each}
                    </select>
                  </label>
                  {#if staff.notationType === "tab.lute.german"}
                    <label class="field narrow">
                      <span>Lines</span>
                      <select disabled title="German tablature is written in letters, without staff lines.">
                        <option>—</option>
                      </select>
                    </label>
                  {:else if clefLineFixed(staff)}
                    <label class="field narrow">
                      <span>Lines</span>
                      <select
                        value={String(staff.lines)}
                        onchange={(e) => {
                          staff.lines = Number(
                            (e.target as HTMLSelectElement).value,
                          );
                          // Keep the clef on the staff: centred on the lines
                          // it actually has.
                          staff.clefLine = Math.ceil(staff.lines / 2);
                        }}
                        title="How many lines the staff has — one per string for a tablature, up to five for percussion."
                      >
                        {#each linesChoices(staff) as count (count)}
                          <option value={String(count)}>{count}</option>
                        {/each}
                      </select>
                    </label>
                  {:else}
                    <label class="field narrow">
                      <span>Line</span>
                      <select
                        value={String(staff.clefLine)}
                        onchange={(e) =>
                          (staff.clefLine = Number(
                            (e.target as HTMLSelectElement).value,
                          ))}
                        title="The staff line the clef sits on, counted from the bottom line up."
                      >
                        {#each CLEF_LINES as line (line)}
                          <option value={String(line)}>{line}</option>
                        {/each}
                      </select>
                    </label>
                  {/if}
                  <label class="field wide">
                    <span>Instrument</span>
                    <input
                      type="text"
                      bind:value={staff.label}
                      placeholder="optional"
                      title="The instrument or voice name printed in front of this staff. Leave empty for none."
                    />
                  </label>
                  <div class="rowbtns">
                    <button
                      type="button"
                      class="btn btn-icon"
                      onclick={() => moveStaff(i, -1)}
                      disabled={i === 0}
                      aria-label={`Move staff ${i + 1} up`}
                      title="Move this staff up">↑</button
                    >
                    <button
                      type="button"
                      class="btn btn-icon"
                      onclick={() => moveStaff(i, 1)}
                      disabled={i === staves.length - 1}
                      aria-label={`Move staff ${i + 1} down`}
                      title="Move this staff down">↓</button
                    >
                    <button
                      type="button"
                      class="btn btn-icon"
                      onclick={() => removeStaff(i)}
                      disabled={staves.length <= 1}
                      aria-label={`Remove staff ${i + 1}`}
                      title="Remove this staff">✕</button
                    >
                  </div>
                </li>
              {/each}
            </ol>
            <button
              type="button"
              class="btn addbtn"
              onclick={() => addStaff()}
              disabled={staves.length >= MAX_STAVES}
              title="Add a staff below the last one."
              >Add staff</button
            >

            {#if staves.length > 1 || groups.length > 0}
              <p class="grouphead sub">Groups</p>
              {#each groups as group, i (i)}
                <div class="grouprow">
                  <label class="field">
                    <span>Symbol</span>
                    <select
                      bind:value={group.symbol}
                      title="A brace joins the staves of one instrument, like a piano. A bracket joins a section, like the strings."
                    >
                      <option value="brace">Brace (one instrument)</option>
                      <option value="bracket">Bracket (section)</option>
                    </select>
                  </label>
                  <label class="field narrow">
                    <span>From staff</span>
                    <select bind:value={group.start} title="The group's first staff.">
                      {#each staves as _, n (n)}
                        <option value={n + 1}>{n + 1}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="field narrow">
                    <span>To staff</span>
                    <select bind:value={group.end} title="The group's last staff.">
                      {#each staves as _, n (n)}
                        <option value={n + 1}>{n + 1}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="field grow">
                    <span>Label</span>
                    <input
                      type="text"
                      bind:value={group.label}
                      placeholder="optional"
                      title="The name printed in front of the group, like Piano or Violini. Leave empty for none."
                    />
                  </label>
                  <div class="rowbtns">
                    <button
                      type="button"
                      class="btn btn-icon"
                      onclick={() => removeGroup(i)}
                      aria-label={`Remove group ${i + 1}`}
                      title="Remove this group">✕</button
                    >
                  </div>
                </div>
              {/each}
              <button
                type="button"
                class="btn addbtn"
                onclick={() => addGroup()}
                title="Join a run of staves with a brace or bracket."
                >Add group</button
              >
              {#if !groupsValid}
                <p class="groupwarn">
                  Groups must fit the staves and must not overlap.
                </p>
              {/if}
            {/if}
          </fieldset>

          <fieldset disabled={!canEdit}>
            <p class="grouphead">Key signature and meter</p>
            <div class="pair">
              <label class="field">
                <span>Key signature</span>
                <select
                  bind:value={keysig}
                  title="The accidentals the score opens with, on every staff."
                >
                  {#each KEY_SIGNATURES as key (key.value)}
                    <option value={key.value}>{key.label}</option>
                  {/each}
                </select>
              </label>
              <label class="field">
                <span>Time signature</span>
                <select
                  bind:value={meterType}
                  title="Numbers (beats over a beat unit), or a symbol: common time (C) or cut time (¢)."
                >
                  <option value="numeric">Numbers</option>
                  <option value="common">Common time (C)</option>
                  <option value="cut">Cut time (¢)</option>
                </select>
              </label>
              {#if meterType === "numeric"}
                <label class="field narrow">
                  <span>Beats</span>
                  <input
                    type="text"
                    inputmode="numeric"
                    bind:value={meterCount}
                    class:bad={!meterValid}
                    title="The number of beats in a bar — the upper number of the time signature."
                  />
                </label>
                <label class="field narrow">
                  <span>Beat unit</span>
                  <select
                    bind:value={meterUnit}
                    title="The note value that counts as one beat — the lower number of the time signature."
                  >
                    {#each METER_UNITS as unit (unit)}
                      <option value={String(unit)}>{unit}</option>
                    {/each}
                  </select>
                </label>
              {/if}
            </div>
          </fieldset>

          <section class="previewbox">
            <span class="sb-label">Preview</span>
            {#if !meterValid}
              <p class="muted">Enter a whole number of beats to see the preview.</p>
            {:else if !groupsValid}
              <p class="muted">Fix the staff groups to see the preview.</p>
            {:else if previewError}
              <p class="muted">{previewError}</p>
            {:else if previewSvg}
              <!-- Rendered by Verovio and sanitised in verovio-render.ts. -->
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <div class="sheet">{@html previewSvg}</div>
            {:else}
              <p class="muted">Rendering…</p>
            {/if}
          </section>
        </form>
        </div>

        <!-- The piece's committed score beside the form — the same viewer the
             console uses, so the source pages can be read while the staves,
             clefs, key signature and meter are entered. Opens on the facsimile
             with the measure zones hidden: the setup is read off the source
             image, not the measure grid. -->
        <div class="refcol">
          <ScorePreview
            bind:this={refPreview}
            {owner}
            {repo}
            fragment={data.fragment}
            initialPane="facs"
            initialZones={false}
            {anchor}
          >
            {#snippet trailing()}
              {#if !commentsPanel.open}
                <button
                  type="button"
                  class="btn"
                  title="Show the comments panel with the task's controls"
                  onclick={() => {
                    commentsPanel.open = true;
                    writeSidePanel("comments", { ...commentsPanel });
                  }}
                >
                  <PanelIcon />
                  Comments
                </button>
              {/if}
            {/snippet}
          </ScorePreview>
        </div>
      </div>
    </div>

    {#snippet taskBox()}
      <!-- The snippet renders only while `data` is loaded (see its host). -->
      {@const d = data!}
      <div class="taskbox">
        <div
          class="tbhead"
          title="Every encoding task of this piece waits for this setup."
        >
          <span class="abtitle">Score setup</span>
          <code class="taskchip">{taskId}</code>
        </div>
        <div class="tbsection">
        <span class="abcount">
          {staves.length} stave{staves.length === 1 ? "" : "s"}
          · {meterType === "numeric"
            ? `${meterCount}/${meterUnit}`
            : meterType === "common"
              ? "common time"
              : "cut time"}
        </span>
        {#if canEdit}
          <span class="lockpill ok">you hold this task</span>
        {:else if d.status === "completed"}
          <span class="lockpill grey">completed — read-only</span>
        {:else if d.status !== "encoding_required"}
          {#if failedVerdicts.length > 0 && validation?.openSlots === 0}
            <span class="lockpill red">validation failed — read-only</span>
          {:else}
            <span class="lockpill amber">submitted — awaiting validation, read-only</span>
          {/if}
        {:else if d.blockedBy}
          <span class="lockpill grey">waits for {d.blockedBy} — read-only</span>
        {:else if d.encodingLockUser}
          <span class="lockpill amber"
            >claimed by @{handle(logins, d.encodingLockUser)} — read-only</span
          >
        {:else}
          <span class="lockpill amber">unclaimed — read-only</span>
          <button type="button" class="btn" onclick={() => claim()} disabled={runner.busy}>Claim task</button>
        {/if}
        <button
          type="button"
          class="btn btn-primary submitbtn"
          onclick={() => submit()}
          disabled={runner.busy || !canEdit || !meterValid || !groupsValid}
          title="Submit the staves, clefs, key signature and meter for validation"
        >
          Submit setup
        </button>
      </div>

      {#if failComments.length > 0}
        <div class="tbsection">
          <span class="sb-label">Fail comments</span>
          {#each failComments as c (c.comment_id)}
            <div class="failnote" class:resolved={c.resolved === "true"}>
              <span class="failwho"
                >@{handle(logins, c.author_id)} · {elapsed(c.timestamp)}{c.resolved ===
                "true"
                  ? " · resolved"
                  : ""}</span
              >
              <div class="failtext">“{c.body}”</div>
            </div>
          {/each}
        </div>
      {/if}

      {#if validation && submitted}
        <div class="tbsection sb-validation">
          <span class="sb-label">Validation</span>
          <span class="vstatus">
            {#if validation.status === "completed"}
              Validation complete
            {:else if verdictPending}
              Your verdict is being processed…
            {:else if validation.lockUser}
              {holdsValidation ? "You are validating" : `@${lockUserLogin || validation.lockUser} validating`}
            {:else if failedVerdicts.length > 0 && validation.openSlots === 0}
              Failed — send it back to redo the setup
            {:else if selfValidation}
              Your own submission
            {:else if alreadyValidated}
              You validated this — another volunteer is needed
            {:else}
              Awaiting validation
            {/if}
          </span>
          {#each validation.verdicts as v, i (i)}
            <span class="vrow {v.verdict}"
              >{#if v.verdict === "pass"}<img
                  class="hand-pass"
                  src="/green-hand.svg"
                  alt=""
                /> pass{:else}✗ fail{/if} · @{handle(logins, v.user)} · {elapsed(
                v.ts,
              )}</span
            >
          {/each}
          {#if validation.status !== "completed" && validation.openSlots > 0}
            <div class="sb-row three">
              <button type="button" class="btn" onclick={() => claimValidation()} disabled={runner.busy || !canClaimValidation}
                title={data?.allowSelfValidation
                  ? "Reserve this subtask for validation."
                  : "Reserve this subtask for validation. Encoders cannot validate their own work."}>Claim</button>
              <button type="button" class="btn btn-primary btn-finish" onclick={() => validate("pass")} disabled={runner.busy || !holdsValidation || verdictPending}
                title="Record a passing verdict.">Pass</button>
              <button type="button" class="btn btn-danger vfail" class:on={failOpen} onclick={() => (failOpen = !failOpen)} disabled={runner.busy || !holdsValidation || verdictPending}
                title="Record a failing verdict — a fail carries a comment saying why.">Fail</button>
            </div>
          {/if}
          {#if failOpen && holdsValidation}
            <input
              class="fail-note"
              bind:value={failText}
              placeholder="Why does this fail?"
              onkeydown={(e) => {
                if (e.key === "Enter" && failText.trim()) validate("fail");
              }}
            />
            <div class="sb-row one">
              <button
                type="button"
                class="btn btn-danger"
                onclick={() => validate("fail")}
                disabled={runner.busy || !failText.trim() || verdictPending}
                title="Submit the failing verdict with this comment."
                >Submit fail</button
              >
            </div>
          {/if}
          {#if canSendBack}
            <button
              type="button"
              class="btn btn-danger sendbackbtn"
              onclick={() => sendBack()}
              disabled={runner.busy || sendBackPending}
              title="Return the task to score setup: attribution and validations reset."
              >Send back to score setup</button
            >
          {/if}
        </div>
      {/if}
      </div>
    {/snippet}

    {#if tables}
      <PieceCommentsPanel
        {tables}
        {taskId}
        {viewer}
        {runner}
        bind:panel={commentsPanel}
        header={taskBox}
        onanchor={showAnchorFor}
        oncomment={postComment}
        onresolve={resolveCommentRow}
      />
    {/if}
  {/if}
</div>

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }
  .linkish {
    font: inherit;
    font-weight: 600;
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .linkish:hover {
    text-decoration: underline;
  }

  /* The whole tool: the form and its preview on the desk, with the comments
     panel — carrying the task box — beside it. The app's navigation bar and
     footer come from the layout, as on every other page. */
  .corrector {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--desk);
    box-shadow: var(--shadow-inset);
  }
  /* The comments panel brings no outer spacing of its own; the score view's
     host row provides it there. */
  .corrector > :global(.cpwrap) {
    margin: 12px 16px 12px 0;
  }
  .deskwrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1.25rem 2rem;
    box-sizing: border-box;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .desk {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 24px;
    padding: 16px 24px;
    box-sizing: border-box;
    overflow: hidden;
  }
  /* The form and the source pages scroll independently, so a page far down
     the piece can be read next to the form. */
  .formcol {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  .refcol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--card);
    overflow: hidden;
  }
  /* Banner styles are shared app-wide in ui.css. */

  /* ------------------------------------------------------------------- form */
  .setup {
    max-width: 780px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .setup fieldset {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--card);
    padding: 12px 14px 14px;
    margin: 0;
    min-width: 0;
  }
  .setup fieldset:disabled {
    opacity: 0.6;
  }
  .grouphead {
    margin: 0 0 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .grouphead.sub {
    margin-top: 16px;
  }
  .grouprow {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin-bottom: 8px;
  }
  .grouprow .field {
    flex: none;
    width: 180px;
  }
  .grouprow .field.narrow {
    width: 88px;
  }
  .grouprow .field.grow {
    flex: 1;
    width: auto;
    min-width: 120px;
  }
  .groupwarn {
    margin: 8px 0 0;
    font-size: 12.5px;
    color: var(--danger);
  }
  .staves {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .staffrow {
    display: flex;
    align-items: flex-end;
    gap: 10px;
  }
  .staffno {
    flex: none;
    width: 22px;
    padding-bottom: 7px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .pair {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }
  /* Fixed widths: showing or hiding the beats and unit fields must not
     resize the selects beside them. */
  .pair .field {
    flex: none;
    width: 180px;
  }
  .pair .field.narrow {
    width: 88px;
  }
  .field {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field.narrow {
    flex: none;
    width: 88px;
  }
  .field.wide {
    flex: 2;
  }
  .field span {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .field select,
  .field input {
    font: inherit;
    font-size: 13px;
    width: 100%;
    box-sizing: border-box;
    padding: 6px 10px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
  }
  .field input.bad {
    border-color: var(--danger-line);
  }
  .field select:disabled,
  .field input:disabled {
    color: var(--ink-faint);
    background: var(--bg-tint);
    cursor: not-allowed;
  }
  .rowbtns {
    flex: none;
    display: flex;
    gap: 4px;
  }
  .addbtn {
    align-self: flex-start;
  }
  .previewbox {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sheet {
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 8px;
    overflow: auto;
  }
  .sheet :global(svg) {
    display: block;
    width: 100%;
    height: auto;
  }

  /* --------------------------------------------------------------- task box
     The task's status, actions and validation controls, pinned at the top of
     the comments panel. The tint follows the panel's piece colour (--zone). */
  .taskbox {
    background: var(--card);
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    overflow: hidden;
    box-shadow: var(--shadow-sm);
  }
  .tbhead {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    background: color-mix(in srgb, var(--zone) 10%, var(--card));
    border-bottom: 1px solid color-mix(in srgb, var(--zone) 25%, var(--line));
    padding: 9px 12px;
  }
  .tbsection {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
  }
  .tbsection + .tbsection {
    border-top: 1px solid var(--line);
  }
  .sb-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .abtitle {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .taskchip {
    font-size: 12px;
    font-family: ui-monospace, Menlo, monospace;
    background: var(--bg-tint);
    border-radius: 5px;
    padding: 2px 7px;
  }
  .abcount {
    font-size: 12.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .lockpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 10px;
  }
  .lockpill.ok {
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .lockpill.amber {
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
  }
  .lockpill.grey {
    color: var(--ink-faint);
    background: var(--bg-tint);
    border: 1px solid var(--line);
  }
  .lockpill.red {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
  .submitbtn {
    align-self: stretch;
  }

  /* A control row filling the sidebar's width; .one/.three divide it into
     that many equal cells. */
  .sb-row {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sb-row.one,
  .sb-row.three {
    display: grid;
    grid-template-columns: repeat(var(--cells), 1fr);
  }
  .sb-row.one {
    --cells: 1;
  }
  .sb-row.three {
    --cells: 3;
  }
  .failnote {
    align-self: stretch;
    border: 1px solid var(--danger-line);
    border-radius: 8px;
    background: var(--danger-wash);
    padding: 8px 10px;
  }
  .failnote.resolved {
    opacity: 0.55;
  }
  .failwho {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--danger);
  }
  .failtext {
    font-size: 12.5px;
    color: var(--ink);
    margin-top: 4px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .sb-validation .vstatus {
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  /* The armed Fail button: still an outline, tinted while its comment box
     is open. */
  .sb-validation .vfail.on {
    background: var(--danger-bg);
  }
  .sb-validation .vrow {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  /* The green thumbs-up hand marks a passed verdict. */
  .sb-validation .hand-pass {
    height: 14px;
    flex: none;
  }
  .sb-validation .vrow.pass {
    color: var(--ok);
  }
  .sb-validation .vrow.fail {
    color: var(--danger);
  }
  .sb-validation .fail-note {
    font: inherit;
    font-size: 12.5px;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 10px;
    border: 1px solid var(--danger-line);
    border-radius: 999px;
    background: var(--card);
    color: var(--ink);
  }
  .sendbackbtn {
    align-self: stretch;
  }
</style>
