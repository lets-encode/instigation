<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import { createForge } from "$lib/forge/index.ts";
  import { meiFriendUrl } from "$lib/forge/config.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { lookupSlug, resolveCampaign } from "$lib/campaign-resolve.ts";
  import type { ResolvedCampaign } from "$lib/campaign-resolve.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type {
    TaskRow,
    StateRow,
    LockRow,
    HistoryRow,
    CommentRow,
  } from "$lib/campaign-tables.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result, FailComment } from "$lib/commands.ts";
  import { statusPill, isPreTask } from "$lib/campaign-graph.ts";
  import {
    buildBoard,
    buildRecord,
    buildThreads,
    elapsed,
  } from "$lib/campaign-board.ts";
  import type { BoardCard, ColumnKey } from "$lib/campaign-board.ts";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import { parseMeiHeader } from "$lib/mei-header.ts";
  import type { MeiHeader } from "$lib/mei-header.ts";
  import { resolveFacsimileImageUrls } from "$lib/facsimile-images.ts";
  import type { MeasureBox } from "$lib/mei-facsimile.ts";
  import { buildSpreads } from "$lib/page-spreads.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import PlanEditor from "$lib/components/PlanEditor.svelte";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";

  // The URL carries only the campaign name; the repo it addresses is resolved
  // from it (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  let resolved = $state<ResolvedCampaign | null>(null);
  let resolving = $state(false);
  let notFound = $state(false);
  // A name that is not (yet) a campaign: held by a setup in progress, reserved
  // for the app's own routes, or blocked. A free name never renders here — it
  // forwards to the wizard.
  let slugState = $state<"pending" | "reserved" | "tombstoned" | null>(null);
  const owner = $derived(resolved?.owner ?? "");
  const repo = $derived(resolved?.repo ?? "");
  const repoId = $derived(resolved?.repoId ?? 0);
  // The acting user's stable numeric id (written to the tables); login is display-only.
  const viewer = $derived(auth.user?.id != null ? String(auth.user.id) : "");
  const viewerLogin = $derived(auth.user?.login ?? "");

  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notInitialised = $state(false);
  let isPrivate = $state(false);
  let canPush = $state(false);
  let taskDefs = $state<TaskRow[]>([]);
  let rows = $state<StateRow[]>([]);
  let validationColumns = $state<string[]>([]);
  let locks = $state<LockRow[]>([]);
  let history = $state<HistoryRow[]>([]);
  let comments = $state<CommentRow[]>([]);
  // Numeric user id → login, for displaying the people the tables reference.
  let logins = $state<Record<string, string>>({});
  let title = $state("");
  let description = $state("");
  let license = $state("");
  let passThreshold = $state(1);

  let busy = $state(false);
  const busyLog = new ProgressLog();
  let result = $state<Result | null>(null);

  // UI-only state: everything else derives from the tracking tables.
  let view = $state<"board" | "tables">("board");
  // Plan mode: task.csv as an editable table over the board's place (owners).
  let planEditing = $state(false);
  let showInfo = $state(false);
  // Columns the viewer expanded past the card cap.
  let expanded = $state<Partial<Record<ColumnKey, boolean>>>({});
  const CARD_CAP = 5;

  // The score's <meiHead> fields, fetched on first open of the info panel.
  let scoreHead = $state<MeiHeader | null>(null);
  let scoreHeadState = $state<"idle" | "loading" | "done" | "error">("idle");
  async function loadScoreHead() {
    if (scoreHeadState !== "idle") return;
    scoreHeadState = "loading";
    try {
      const f = readForge();
      // The first task's fragment is the piece the campaign opens on; the
      // fixed path is where a single-source campaign kept its only score.
      const mei =
        (taskDefs[0]?.fragment
          ? await f.getRepoFile(owner, repo, taskDefs[0].fragment)
          : null) ?? (await f.getRepoFile(owner, repo, "sources/score.mei"));
      scoreHead = mei ? parseMeiHeader(mei) : null;
      scoreHeadState = mei ? "done" : "error";
    } catch {
      scoreHeadState = "error";
    }
  }

  // Everyone the campaign history records as having acted on the score.
  const workedOn = $derived(
    [...new Set(history.map((h) => h.user_id))].filter(Boolean),
  );

  const graphData = $derived({
    taskDefs,
    rows,
    validationColumns,
    locks,
    passThreshold,
  });
  const board = $derived(
    buildBoard(graphData, comments, history, viewer, logins),
  );
  const allCards = $derived(board.columns.flatMap((c) => c.cards));
  const nextCard = $derived(
    board.nextUp
      ? (allCards.find((c) => c.task === board.nextUp) ?? null)
      : null,
  );

  // ------------------------------------------------------------ the overlay
  // Task preview overlay: opens from a board card; the board stays behind it.
  let overlayTask = $state<string | null>(null);
  const overlayCard = $derived(
    overlayTask ? (allCards.find((c) => c.task === overlayTask) ?? null) : null,
  );
  const record = $derived(
    overlayCard ? buildRecord(overlayCard, comments, viewer, logins) : [],
  );
  const threads = $derived(
    overlayTask ? buildThreads(comments, overlayTask) : [],
  );
  const mineEncoding = $derived(
    overlayTask != null &&
      viewer !== "" &&
      locks.some(
        (l) =>
          l.task_id === overlayTask &&
          l.subtask_id === "" &&
          l.kind === "encoding" &&
          l.user_id === viewer,
      ),
  );

  // The measure range a fail refers to, highlighted in both preview panes.
  let anchor = $state<{ page: number; m1: number; m2: number } | null>(null);
  // The inline form a fail verdict fills in (its mandatory comment).
  let failForm = $state<{
    sub: string;
    body: string;
    page: string;
    m1: string;
    m2: string;
  } | null>(null);
  // Composer state for the discussion thread.
  let composerText = $state("");
  let composerKind = $state<"question" | "addition">("question");
  let replyTo = $state<CommentRow | null>(null);

  function openOverlay(task: string) {
    overlayTask = task;
    anchor = null;
    failForm = null;
    replyTo = null;
    composerText = "";
    // A per-page task opens on its page; whole-file tasks open on page 1.
    const locator = findRow(taskDefs, task, "")?.locator ?? "";
    const pg = /^surface-(\d+)$/.exec(locator);
    const startPage = pg ? Number(pg[1]) - 1 : 0;
    if (preview?.taskId !== task) {
      loadPreview(task, startPage);
    } else {
      pvFirstVisible = Math.min(startPage, Math.max(0, pvPageTotal - 1));
      renderSpread();
    }
  }
  function closeOverlay() {
    overlayTask = null;
    preview = null;
    anchor = null;
    failForm = null;
    replyTo = null;
  }

  function showAnchorFor(c: CommentRow) {
    const m1 = Number(c.measure_start);
    const m2 = Number(c.measure_end || c.measure_start);
    anchor = {
      page: Number(c.page),
      m1: Number.isFinite(m1) ? m1 : 0,
      m2: Number.isFinite(m2) ? m2 : 0,
    };
    showZones = true;
    if (anchor.page >= 1 && anchor.page <= pvPageTotal) {
      pvFirstVisible = anchor.page - 1;
      renderSpread();
    }
  }
  const anchorLabel = (c: CommentRow): string => {
    const range =
      c.measure_end && c.measure_end !== c.measure_start
        ? `m. ${c.measure_start}–${c.measure_end}`
        : `m. ${c.measure_start}`;
    return `${c.page ? `p. ${c.page} · ` : ""}${range}`;
  };
  const hasAnchor = (c: CommentRow): boolean =>
    c.measure_start !== "" || c.page !== "";

  // Whether a facsimile zone falls in the anchored measure range (zone labels
  // carry the measure numbers).
  function zoneFlagged(label: string): boolean {
    if (!anchor) return false;
    const a = anchor;
    return (label.match(/\d+/g) ?? []).some((s) => {
      const n = Number(s);
      return n >= a.m1 && n <= a.m2;
    });
  }
  // Mark the anchored measures in a rendered encoding page (Verovio writes the
  // measure number as data-n — see svgAdditionalAttribute below).
  function flagSvg(svg: string): string {
    if (!anchor || !svg) return svg;
    const a = anchor;
    try {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      for (const g of doc.querySelectorAll("g.measure")) {
        const n = Number(g.getAttribute("data-n"));
        if (Number.isFinite(n) && n >= a.m1 && n <= a.m2)
          g.classList.add("m-flag");
      }
      return new XMLSerializer().serializeToString(doc);
    } catch {
      return svg;
    }
  }

  /** One facsimile page in the preview: image plus its measure zones. */
  type PreviewPage = {
    url: string;
    w: number;
    h: number;
    zones: { box: MeasureBox; label: string }[];
  };
  let preview = $state<{
    taskId: string;
    loading: boolean;
    error?: string;
    /** The facsimile pages, when the score references any. */
    facs?: PreviewPage[];
    /** Verovio page count; 0 = nothing to render yet. */
    pageCount: number;
    /** Rendered encoding pages, filled lazily per spread (1-based). */
    svgs: Record<number, string>;
  } | null>(null);

  // Preview display state: book-style paging shared by both panes, one zoom
  // for both, and the zone overlay toggle.
  let pvView = $state<"single" | "double">("single");
  let pvFirstOnRight = $state(true);
  let pvFirstVisible = $state(0);
  let pvZoom = $state(1);
  let showZones = $state(true);
  const PV_ZOOM_MIN = 0.5;
  const PV_ZOOM_MAX = 4;
  const pvZoomBy = (step: number) =>
    (pvZoom = Math.min(
      PV_ZOOM_MAX,
      Math.max(PV_ZOOM_MIN, Math.round((pvZoom + step) * 100) / 100),
    ));

  const pvPageTotal = $derived(
    preview ? Math.max(preview.facs?.length ?? 0, preview.pageCount) : 0,
  );
  const pvSpreads = $derived(buildSpreads(pvPageTotal, pvView, pvFirstOnRight));
  const pvSpreadIndex = $derived(
    Math.max(
      0,
      pvSpreads.findIndex((sp) => sp.pages.includes(pvFirstVisible)),
    ),
  );
  const pvSpread = $derived(pvSpreads[pvSpreadIndex] ?? { pages: [] });
  const pvSpreadLabel = $derived(
    pvSpread.pages.length === 2
      ? `Pages ${pvSpread.pages[0] + 1}–${pvSpread.pages[1] + 1} of ${pvPageTotal}`
      : `Page ${(pvSpread.pages[0] ?? 0) + 1} of ${pvPageTotal}`,
  );

  // Render the encoding pages the current spread needs (kept for later visits).
  function renderSpread() {
    if (!preview || preview.loading || !verovio || preview.pageCount === 0)
      return;
    let changed = false;
    const svgs = { ...preview.svgs };
    for (const p of pvSpread.pages) {
      const n = p + 1;
      if (n <= preview.pageCount && !svgs[n]) {
        svgs[n] = verovio.renderToSVG(n);
        changed = true;
      }
    }
    if (changed) preview = { ...preview, svgs };
  }
  function pvGo(delta: number) {
    const next = pvSpreads[pvSpreadIndex + delta];
    if (!next) return;
    pvFirstVisible = next.pages[0];
    renderSpread();
  }
  function pvSetView(v: "single" | "double") {
    pvView = v;
    renderSpread();
  }
  function pvSetFirstOnRight(on: boolean) {
    pvFirstOnRight = on;
    renderSpread();
  }

  // Drag-resize state for the info panel's width.
  let infoW = $state(300);
  let resizing = $state<"info" | null>(null);
  function resizeMove(e: PointerEvent) {
    if (resizing === "info") {
      infoW = Math.min(520, Math.max(220, e.clientX));
    }
  }

  // Verovio is a ~2 MB WASM module — loaded on first preview, then reused.
  let verovio: import("verovio/esm").VerovioToolkit | null = null;
  async function getVerovio() {
    if (!verovio) {
      const [{ default: createVerovioModule }, { VerovioToolkit }] =
        await Promise.all([import("verovio/wasm"), import("verovio/esm")]);
      verovio = new VerovioToolkit(await createVerovioModule());
      verovio.setOptions({
        pageWidth: 2100,
        pageHeight: 2970,
        adjustPageHeight: true,
        scale: 40,
        footer: "none",
        svgViewBox: true,
        // Render every movement — without this only the first <mdiv> paginates.
        mdivAll: true,
        // Write each measure's number as data-n, so a fail's measure range can
        // be highlighted in the rendered encoding.
        svgAdditionalAttribute: ["measure@n"],
      });
    }
    return verovio;
  }

  // Preview both sides of the score: the facsimile pages (when the score
  // references any) and the rendered encoding (when it holds measures).
  async function loadPreview(task_id: string, startPage = 0) {
    const f = readForge();
    preview = { taskId: task_id, loading: true, pageCount: 0, svgs: {} };
    pvFirstVisible = 0;
    try {
      const fragment = fragmentOf(task_id);
      if (!fragment) throw new Error(`Unknown task ${task_id}.`);
      const mei = await f.getRepoFile(owner, repo, fragment);
      if (mei == null) throw new Error(`Could not read ${fragment}.`);
      const parsed = parseFacsimileMei(mei);

      let facs: PreviewPage[] | undefined;
      if (parsed.pages.length) {
        const urls = await resolveFacsimileImageUrls(
          f,
          owner,
          repo,
          fragment,
          parsed.pages.map((page) => page.image),
        );
        // A facsimile whose images are all unreachable (an encoding uploaded
        // without its page images) gets no facsimile pane — there is nothing
        // to show on it.
        if (urls.some((url) => url)) {
          facs = parsed.pages.map((pg, index) => ({
            url: urls[index],
            w: pg.width,
            h: pg.height,
            zones: pg.zones.map((z) => ({ box: z.box, label: z.label })),
          }));
        }
      }

      // A score without facsimile pages is rendered as-is; a facsimile score
      // only once its measures exist (stage A has nothing to render). With
      // encoded breaks Verovio paginates on the <pb/> elements, so encoding
      // pages line up with the facsimile pages.
      let pageCount = 0;
      if (!parsed.pages.length || parsed.hasMeasures) {
        const tk = await getVerovio();
        tk.setOptions({ breaks: parsed.hasBreaks ? "encoded" : "auto" });
        if (!tk.loadData(mei))
          throw new Error(`Verovio could not parse ${fragment}.`);
        pageCount = tk.getPageCount();
      }

      if (preview?.taskId === task_id) {
        preview = {
          taskId: task_id,
          loading: false,
          facs,
          pageCount,
          svgs: {},
        };
        const total = Math.max(facs?.length ?? 0, pageCount);
        pvFirstVisible = Math.min(startPage, Math.max(0, total - 1));
        renderSpread();
      }
    } catch (e) {
      if (preview?.taskId === task_id)
        preview = {
          taskId: task_id,
          loading: false,
          error: `Preview failed: ${(e as Error).message}`,
          pageCount: 0,
          svgs: {},
        };
    }
  }

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});

  const fragmentOf = (taskId: string) =>
    findRow(taskDefs, taskId, "")?.fragment;

  const readForge = () => forge() ?? createForge("");

  // The context every command runs against; progress updates feed the busy
  // overlay's step log.
  const ctx = (f: ForgeClient): CommandContext => ({
    forge: f,
    repoId,
    owner,
    repo,
    viewer,
    viewerLogin,
    meiFriendUrl,
    progress: (u) => {
      if (u.step) busyLog.step(u.step);
      if (u.detail) busyLog.detail(u.detail);
    },
  });

  // Read the tracking tables (and privacy/config) for the console. Only the
  // first read shows the loading state; refreshes update the tables in place.
  async function load() {
    const f = readForge();
    if (!loaded) loading = true;
    loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, ctx(f));
      notInitialised = tables.notInitialised;
      isPrivate = tables.isPrivate;
      canPush = tables.canPush;
      taskDefs = tables.taskDefs;
      rows = tables.rows;
      validationColumns = tables.validationColumns;
      locks = tables.locks;
      history = tables.history;
      comments = tables.comments;
      logins = tables.logins;
      title = tables.title;
      description = tables.description;
      license = tables.license;
      passThreshold = tables.passThreshold;
      if (!notInitialised) {
        console.log(
          "[load] tables loaded:",
          taskDefs.length,
          "task(s),",
          rows.length,
          "state row(s),",
          locks.length,
          "lock(s),",
          comments.length,
          "comment(s)",
        );
      }
      loaded = true;
    } catch (e) {
      loadError = `Could not read ${owner}/${repo}: ${(e as Error).message}`;
    } finally {
      loading = false;
    }
  }

  // Resolve the campaign name to its repo before anything reads the tables. The
  // load effect below is gated on `owner`/`repo`, so it waits for this.
  // The URL is the campaign's address (/<name>), so the name's registry state
  // decides what the page is: a live campaign renders, a free name forwards to
  // the wizard with the name prefilled, and a name that is held, reserved or
  // blocked explains itself.
  $effect(() => {
    if (auth.status === "loading" || resolved || notFound || slugState || resolving)
      return;
    resolving = true;
    resolve().finally(() => (resolving = false));
  });

  async function resolve() {
    const info = await lookupSlug(campaign);
    if (info?.status === "free") {
      await goto(`/?slug=${encodeURIComponent(campaign)}`, { replaceState: true });
      return;
    }
    if (
      info?.status === "pending" ||
      info?.status === "reserved" ||
      info?.status === "tombstoned"
    ) {
      slugState = info.status;
      return;
    }
    // Active — or the registry was unreachable / the name malformed, which
    // resolveCampaign reports as null (notFound).
    const r = await resolveCampaign(readForge(), campaign).catch(() => null);
    if (r) resolved = r;
    else notFound = true;
  }

  $effect(() => {
    if (auth.status !== "loading" && owner && repo && !loaded) load();
  });

  // Pages the measure detector couldn't process during campaign creation, handed
  // over via sessionStorage by the create flow. Read once and clear, so the
  // notice shows on arrival but not on a later reload.
  let skippedPages = $state<string[]>([]);
  $effect(() => {
    const key = `facsimile-skipped:${repoId}`;
    const raw = sessionStorage.getItem(key);
    if (raw) {
      sessionStorage.removeItem(key);
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) skippedPages = parsed;
      } catch {
        // Malformed hand-off: nothing to show.
      }
    }
  });

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(
    command: (c: CommandContext) => Promise<Result>,
    refresh = true,
  ) {
    const f = forge();
    if (!f) return;
    busy = true;
    busyLog.clear();
    try {
      result = await command(ctx(f));
      if (refresh) {
        busyLog.step("Refreshing tables…");
        await load();
      }
    } finally {
      busyLog.done();
      busy = false;
    }
  }

  const claim = (task_id: string, subtask_id: string) =>
    run((c) => invoke(commands.claimValidation, { task_id, subtask_id }, c));

  // Measure-correction pre-tasks are validated in the zone editor, so claiming
  // one opens it — but only on a clean claim, so a rejected claim leaves you on
  // the console rather than in a read-only editor. Encoding tasks (whole-file
  // and per-page) review in the preview and just claim in place.
  const claimValidate = async (task_id: string, subtask_id: string) => {
    await claim(task_id, subtask_id);
    const locator = taskDefs.find(
      (t) => t.task_id === task_id && t.subtask_id === "",
    )?.locator;
    if (isPreTask(locator ?? "") && result?.ok && !result.warn) {
      await goto(`/${campaign}/zones/${task_id}`);
    }
  };

  // Open the task's score in mei-friend (claiming it if needed). The tab opens
  // only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  const editor = async (task_id: string) => {
    await run((c) => invoke(commands.openEditor, { task_id }, c));
    if (result?.ok && !result.warn && result.meiFriendUrl) {
      window.open(result.meiFriendUrl, "_blank", "noopener");
    }
  };

  const submitpr = (task_id: string) =>
    run((c) => invoke(commands.submitEncoding, { task_id }, c));

  const validate = (
    task_id: string,
    subtask_id: string,
    verdict: string,
    comment?: FailComment,
  ) =>
    run((c) =>
      invoke(
        commands.submitValidation,
        { task_id, subtask_id, verdict, ...(comment ? { comment } : {}) },
        c,
      ),
    );

  async function submitFail() {
    if (!overlayTask || !failForm || !failForm.body.trim()) return;
    const form = failForm;
    await validate(overlayTask, form.sub, "fail", {
      body: form.body,
      page: form.page.trim(),
      measure_start: form.m1.trim(),
      measure_end: form.m2.trim(),
    });
    if (result?.ok) failForm = null;
  }

  const sendBackTask = (task_id: string) =>
    run((c) => invoke(commands.sendBack, { task_id }, c));

  async function postComment() {
    if (!overlayTask || !composerText.trim()) return;
    const kind = replyTo ? "reply" : composerKind;
    const parent_id = replyTo?.comment_id ?? "";
    await run((c) =>
      invoke(
        commands.submitComment,
        {
          task_id: overlayTask!,
          subtask_id: "",
          kind,
          body: composerText,
          page: "",
          measure_start: "",
          measure_end: "",
          parent_id,
        },
        c,
      ),
    );
    if (result?.ok) {
      composerText = "";
      replyTo = null;
    }
  }

  const resolveCommentRow = (comment_id: string) =>
    run((c) => invoke(commands.resolveComment, { comment_id }, c));
  const canResolve = (c: CommentRow) =>
    viewer !== "" && (canPush || c.author_id === viewer);

  // The tokenised raw URL of the score — copied to the clipboard.
  const rawlink = async (task_id: string) => {
    await run((c) => invoke(commands.rawLink, { task_id }, c), false);
    if (result?.rawUrl) copy(result.rawUrl);
  };

  const reaper = () => run((c) => invoke(commands.runReaper, {}, c));

  // Save the edited plan; a clean save leaves plan mode (run() has already
  // refreshed the tables, so the board reflects the new plan).
  async function savePlan(tasks: TaskRow[]) {
    await run((c) => invoke(commands.savePlan, { tasks }, c));
    if (result?.ok) planEditing = false;
  }

  // Deep links from the dashboards, read once after the first load: ?task=
  // opens that task's overlay, ?claim=next claims the first open task.
  let deepLinked = false;
  $effect(() => {
    if (!loaded || deepLinked) return;
    deepLinked = true;
    const task = page.url.searchParams.get("task");
    if (task && findRow(taskDefs, task, "")) {
      openOverlay(task);
      return;
    }
    if (page.url.searchParams.get("claim") === "next" && nextCard) actOnNext();
  });

  // "Claim the next task": act on the first card the viewer can work on — a
  // claim when it is open, otherwise its overlay (their claimed or reviewable
  // work lives there).
  function claimCard(card: BoardCard) {
    if (card.pre) goto(`/${campaign}/zones/${card.task}`);
    else editor(card.task);
  }
  function actOnNext() {
    if (!nextCard) return;
    if (nextCard.column === "ready") claimCard(nextCard);
    else openOverlay(nextCard.task);
  }

  // History rows for the tables tab, newest first (the file is append-only).
  const historyNewestFirst = $derived(history.slice().reverse());
  const joinedValidations = (row: StateRow) =>
    validationColumns.map((c) => row[c] || "·").join("  ");

  const commentLogin = (c: CommentRow) => logins[c.author_id] || c.author_id;
  const initialOf = (name: string) => (name ? name[0].toUpperCase() : "?");
</script>

<svelte:window
  onpointermove={(e) => {
    if (resizing) resizeMove(e);
  }}
  onpointerup={() => {
    resizing = null;
  }}
  onkeydown={(e) => {
    if (e.key === "Escape" && overlayTask) closeOverlay();
  }}
/>

{#if busy}
  <LoadingOverlay log={busyLog} />
{/if}

{#snippet resultBanner()}
  {#if result && result.error}
    <div class="banner err">
      <span>
        {result.error}
        {#if result.prUrl}
          <a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
      </span>
      <button type="button" class="dismiss" onclick={() => (result = null)}
        >Dismiss</button
      >
    </div>
  {:else if result && result.ok}
    <div class="banner {result.warn ? 'warn' : 'ok'}">
      <div class="banner-body">
        {result.message}
        {#if result.prUrl}
          <a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
        {#if result.meiFriendUrl}
          <div class="rawlink">
            <input
              readonly
              value={result.meiFriendUrl}
              onfocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button type="button" onclick={() => copy(result!.meiFriendUrl!)}
              >Copy</button
            >
          </div>
          <span class="muted">
            <a href={result.meiFriendUrl} target="_blank" rel="noreferrer"
              >Open in mei-friend ↗</a
            >
            (if the tab didn't open automatically)
          </span>
          {#if isPrivate}
            <span class="muted">
              Opening mei-friend shares a short-lived, read-capable GitHub URL
              with that external service.
            </span>
          {/if}
        {/if}
        {#if result.rawUrl}
          <div class="rawlink">
            <input
              readonly
              value={result.rawUrl}
              onfocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button type="button" onclick={() => copy(result!.rawUrl!)}
              >Copy</button
            >
          </div>
          {#if isPrivate}
            <span class="muted"
              >The token in this link expires within minutes — use it
              promptly.</span
            >
          {/if}
        {/if}
      </div>
      <button type="button" class="dismiss" onclick={() => (result = null)}
        >Dismiss</button
      >
    </div>
  {/if}
{/snippet}

{#snippet slotDot(key: string)}
  <span class="dot {key}" aria-label={key} title={key}></span>
{/snippet}

<div class="console">
  {#if auth.status === "loading"}
    <p class="msg muted">Loading…</p>
  {:else}
    {#if !auth.user}
      <div class="banner warn">
        <span>
          Viewing this public campaign read-only. <button
            type="button"
            class="linkish"
            onclick={() => login()}>Log in with GitHub</button
          >
          to contribute.
        </span>
      </div>
    {/if}
    {#if skippedPages.length}
      <div class="banner warn">
        <span>
          The measure detector couldn't process {skippedPages.length} page(s) ({skippedPages.join(
            ", ",
          )}) during creation, so they were left out of the score. Everything
          else is ready below.
        </span>
      </div>
    {/if}
    {#if !overlayTask}
      {@render resultBanner()}
    {/if}

    <div class="main">
      {#if showInfo}
        <aside class="ipanel" style={`--ipanel-w:${infoW}px`}>
          <div class="iphead">
            <div class="iptitle">Campaign info</div>
            <button
              type="button"
              class="pclose"
              onclick={() => (showInfo = false)}
              title="Close the info panel"
              aria-label="Close the info panel">✕</button
            >
          </div>
          <div class="ipbody">
            <div class="isec">
              <span class="seclabel">Score</span>
              {#if scoreHeadState === "loading"}
                <span class="muted inote">Loading the score header…</span>
              {:else if scoreHeadState === "error"}
                <span class="muted inote">Could not read the score.</span>
              {:else if scoreHeadState === "done" && !scoreHead}
                <span class="muted inote">The score has no MEI header.</span>
              {:else if scoreHead}
                <div class="irow">
                  <span>Title</span>
                  <span>{scoreHead.title || "—"}</span>
                </div>
                <div class="irow">
                  <span>Composer</span>
                  <span>{scoreHead.composer || "—"}</span>
                </div>
                {#each scoreHead.contributors as c (c.role + c.name)}
                  <div class="irow">
                    <span>{c.role || "contributor"}</span>
                    <span>{c.name}</span>
                  </div>
                {/each}
              {/if}
              <div
                class="irow"
                title="Everyone the campaign history records: claims, submissions and validations."
              >
                <span>Worked on this</span>
                <span>
                  {#if workedOn.length}
                    {#each workedOn as u, i (u)}{i > 0 ? ", " : ""}<a
                        class="mono"
                        href={`https://github.com/${logins[u] || u}`}
                        target="_blank"
                        rel="noreferrer">@{logins[u] || u}</a
                      >{/each}
                  {:else}—{/if}
                </span>
              </div>
            </div>

            <div class="isec">
              <span class="seclabel">Campaign</span>
              <div class="irow">
                <span>Title</span>
                <span>{title || repo}</span>
              </div>
              <div class="irow">
                <span>About</span>
                <span>{description || "—"}</span>
              </div>
              <div class="irow">
                <span>Repository</span>
                <a
                  class="mono"
                  href={`https://github.com/${owner}/${repo}`}
                  target="_blank"
                  rel="noreferrer">{owner}/{repo}</a
                >
              </div>
              <div class="irow">
                <span>Visibility</span>
                <span>{isPrivate ? "Private" : "Public"}</span>
              </div>
              <div
                class="irow"
                title="Contributions to this campaign are published under this license."
              >
                <span>License</span>
                <span>{license || "—"}</span>
              </div>
              <div class="irow">
                <span>Tasks</span>
                <span>{board.done} / {board.total} complete</span>
              </div>
              <div
                class="irow"
                title="Validation passes each task needs before it counts as validated."
              >
                <span>Passes required</span>
                <span>{passThreshold}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            class="ipanel-resizer"
            aria-label="Drag to resize the info panel"
            title="Drag to resize the info panel"
            onpointerdown={(e) => {
              e.preventDefault();
              resizing = "info";
            }}
          ></button>
        </aside>
      {/if}
      <div class="viewcol">
        {#if notFound}
          <div class="banner err">
            <span>
              No campaign called <code>{campaign}</code> was found. It may have
              been removed, or the name may be misspelled.
              <a href="/">Back to all campaigns</a>.
            </span>
          </div>
        {:else if slugState === "pending"}
          <div class="banner warn">
            <span>
              Someone is setting up a campaign called <code>{campaign}</code>.
              If they don't finish it, the name becomes free again.
              <a href="/">Back to all campaigns</a>.
            </span>
          </div>
        {:else if slugState === "reserved"}
          <div class="banner err">
            <span>
              <code>{campaign}</code> is reserved and can't be used for a
              campaign. <a href="/">Back to all campaigns</a>.
            </span>
          </div>
        {:else if slugState === "tombstoned"}
          <div class="banner err">
            <span>
              The name <code>{campaign}</code> has been blocked and can't be
              used. <a href="/">Back to all campaigns</a>.
            </span>
          </div>
        {:else if !resolved}
          <p class="msg muted">Finding the campaign…</p>
        {:else if loading}
          <p class="msg muted">Loading campaign…</p>
        {:else if loadError}
          <div class="banner err"><span>{loadError}</span></div>
        {:else if notInitialised}
          <div class="banner warn">
            <span>
              This repository has no tracking tables (<code
                >tracking/task.csv</code
              >,
              <code>tracking/state.csv</code>, <code>tracking/lock.csv</code>)
              yet — it may not have been initialised. Create it through the home
              page to initialise it.
            </span>
          </div>
        {:else}
          <div class="hero">
            <div class="hero-titles">
              <div class="eyebrow">Campaign</div>
              <div class="hero-line">
                <h1>{title || repo}</h1>
                <a
                  class="mono slug"
                  href={`https://github.com/${owner}/${repo}`}
                  target="_blank"
                  rel="noreferrer">{owner}/{repo}</a
                >
              </div>
              <div class="hero-stats">
                <div class="hbar">
                  <div
                    style={`width:${board.total ? Math.round((board.done / board.total) * 100) : 0}%`}
                  ></div>
                </div>
                <span class="stat strong"
                  >{board.done} of {board.total} tasks done</span
                >
                <span class="sep">·</span>
                <span class="stat inflight">{board.inFlight} in flight</span>
                <span class="sep">·</span>
                <span class="stat attention"
                  >{board.attention} need{board.attention === 1 ? "s" : ""} attention</span
                >
                <span class="sep">·</span>
                <span class="stat"
                  >{board.contributorsWeek} contributor{board.contributorsWeek ===
                  1
                    ? ""
                    : "s"} this week</span
                >
              </div>
            </div>
            <div class="hero-right">
              <div class="hero-tools">
                <button
                  type="button"
                  class="hbtn"
                  class:on={showInfo}
                  onclick={() => {
                    showInfo = !showInfo;
                    if (showInfo) loadScoreHead();
                  }}
                  title="Show or hide campaign information">Info</button
                >
                <button
                  type="button"
                  class="hbtn"
                  onclick={() => load()}
                  disabled={busy || loading}
                  title="Re-read the tracking tables">↻ Refresh</button
                >
                {#if auth.user && canPush}
                  <button
                    type="button"
                    class="hbtn"
                    onclick={() => reaper()}
                    disabled={busy}
                    title="Release claims that have gone stale">Run reaper</button
                  >
                {/if}
                <div class="tabs">
                  <button
                    type="button"
                    class:on={view === "board"}
                    onclick={() => (view = "board")}>Board</button
                  >
                  <button
                    type="button"
                    class:on={view === "tables"}
                    onclick={() => (view = "tables")}>Tables</button
                  >
                </div>
              </div>
              <div class="hero-acts">
                {#if auth.user && canPush && view === "board"}
                  <button
                    type="button"
                    class="pillbtn"
                    disabled={busy}
                    title="Add, remove, rewire or reorder the tasks nobody has worked on yet"
                    onclick={() => (planEditing = !planEditing)}
                    >{planEditing ? "Back to the board" : "Edit the plan"}</button
                  >
                {/if}
                <button
                  type="button"
                  class="pillbtn primary"
                  disabled={busy || !auth.user || !nextCard}
                  title={!auth.user
                    ? "Log in to claim a task."
                    : !nextCard
                      ? "Nothing to claim right now."
                      : "Claim the first task that is open for you."}
                  onclick={actOnNext}>Claim the next task →</button
                >
              </div>
            </div>
          </div>

          {#if view === "board" && planEditing}
            <PlanEditor
              {taskDefs}
              {rows}
              {validationColumns}
              {locks}
              {logins}
              {busy}
              onsave={savePlan}
              oncancel={() => (planEditing = false)}
            />
          {:else if view === "board"}
            <div class="board">
              {#each board.columns as col (col.key)}
                <div class="bcol">
                  <div class="bcol-head c-{col.key}">
                    <span class="bcol-name">{col.label}</span>
                    <span class="bcol-count">{col.cards.length}</span>
                    {#if col.key === "validation" && col.attention > 0}
                      <span class="bcol-flag">{col.attention} ⚑</span>
                    {/if}
                  </div>
                  <div class="well">
                    {#each expanded[col.key] ? col.cards : col.cards.slice(0, CARD_CAP) as card (card.task)}
                      <button
                        type="button"
                        class="card col-{card.column}"
                        class:nextup={card.nextUp}
                        onclick={() => openOverlay(card.task)}
                        title="Open this task's preview"
                      >
                        {#if card.nextUp}
                          <span class="nextup-badge">next step</span>
                        {/if}
                        <div class="card-title">{card.title}</div>
                        <div class="card-type">
                          {card.column === "validation"
                            ? `${card.typeLine} · ${card.passes} of ${card.threshold} passes`
                            : card.typeLine}
                          <span class="mono card-id">{card.task}</span>
                        </div>
                        {#if card.column === "blocked"}
                          <div class="card-foot">
                            waits for <strong>{card.waitsFor}</strong>
                          </div>
                        {:else if card.column === "ready" && card.claimable}
                          <div class="card-claim">
                            <span
                              class="claimlink"
                              role="button"
                              tabindex="-1"
                              onclick={(e) => {
                                e.stopPropagation();
                                claimCard(card);
                              }}
                              onkeydown={(e) => {
                                if (e.key === "Enter") {
                                  e.stopPropagation();
                                  claimCard(card);
                                }
                              }}>Claim →</span
                            >
                          </div>
                        {:else if card.column === "encoding" && card.worker}
                          <div class="card-worker">
                            <span class="avatar"
                              >{initialOf(card.worker.login)}</span
                            >
                            <span class="worker-line"
                              >{card.worker.login} · {card.worker
                                .elapsed}</span
                            >
                            {#if card.worker.mine}
                              <span
                                class="claimlink"
                                role="button"
                                tabindex="-1"
                                onclick={(e) => {
                                  e.stopPropagation();
                                  submitpr(card.task);
                                }}
                                onkeydown={(e) => {
                                  if (e.key === "Enter") {
                                    e.stopPropagation();
                                    submitpr(card.task);
                                  }
                                }}
                                title="After committing in mei-friend, submit the encoding for validation."
                                >Submit →</span
                              >
                            {/if}
                          </div>
                        {:else if card.column === "validation"}
                          <div class="card-dots">
                            {#each card.dots as key, i (i)}
                              {@render slotDot(key)}
                            {/each}
                          </div>
                          {#if card.counts.fails + card.counts.comments + card.counts.questions > 0}
                            <div class="card-chips">
                              {#if card.counts.fails > 0}
                                <span class="chip chip-fail"
                                  >{card.counts.fails} fail{card.counts.fails ===
                                  1
                                    ? ""
                                    : "s"}</span
                                >
                              {/if}
                              {#if card.counts.comments > 0}
                                <span class="chip chip-note"
                                  >{card.counts.comments} comment{card.counts
                                    .comments === 1
                                    ? ""
                                    : "s"}</span
                                >
                              {/if}
                              {#if card.counts.questions > 0}
                                <span class="chip chip-question"
                                  >{card.counts.questions} question{card.counts
                                    .questions === 1
                                    ? ""
                                    : "s"}</span
                                >
                              {/if}
                            </div>
                          {/if}
                        {:else if card.column === "done"}
                          <div class="card-done">{card.doneLine}</div>
                        {/if}
                      </button>
                    {/each}
                    {#if col.cards.length > CARD_CAP}
                      <button
                        type="button"
                        class="more"
                        onclick={() =>
                          (expanded = {
                            ...expanded,
                            [col.key]: !expanded[col.key],
                          })}
                        >{expanded[col.key]
                          ? "show fewer"
                          : `+ ${col.cards.length - CARD_CAP} more`}</button
                      >
                    {/if}
                  </div>
                </div>
              {/each}
            </div>

            <div class="ticker">
              <span class="ticker-label">Activity</span>
              {#each board.ticker as t, i (i)}
                {#if i > 0}<span class="ticker-sep">|</span>{/if}
                <span class="ticker-entry"
                  ><strong>{t.login}</strong>
                  {t.text}
                  <span class="ticker-when">· {t.elapsed}</span></span
                >
              {/each}
              {#if board.ticker.length === 0}
                <span class="ticker-entry muted">No activity yet.</span>
              {/if}
              <span class="tspacer"></span>
              <button
                type="button"
                class="linkish"
                onclick={() => (view = "tables")}
                title="The full history, in the tables view">Full history</button
              >
            </div>
          {:else}
            <div class="tablesview">
              <div class="tcol">
                <div class="tsec">
                  <div class="tname">state.csv</div>
                  <div class="tcard">
                    <div
                      class="trow thead"
                      style="--cols: 1fr 1fr 1.4fr 1fr 1.6fr"
                    >
                      <span>task_id</span><span>subtask_id</span><span
                        >status</span
                      ><span>encoder</span><span>validate_status_*</span>
                    </div>
                    {#each rows as r (r.task_id + "/" + r.subtask_id)}
                      <div
                        class="trow"
                        class:subrow={r.subtask_id !== ""}
                        style="--cols: 1fr 1fr 1.4fr 1fr 1.6fr"
                      >
                        <span class="mono">{r.task_id}</span>
                        <span class="mono dim">{r.subtask_id || "—"}</span>
                        <span
                          ><span class="pill s-{r.status}">{r.status}</span
                          ></span
                        >
                        <span class="mono">{r.encoder || "—"}</span>
                        <span class="mono small"
                          >{r.subtask_id ? joinedValidations(r) : "—"}</span
                        >
                      </div>
                    {/each}
                  </div>
                </div>

                <div class="tsec">
                  <div class="tname">lock.csv</div>
                  <div class="tcard">
                    <div
                      class="trow thead"
                      style="--cols: 1fr 1fr 1fr 1.4fr 1fr"
                    >
                      <span>task_id</span><span>subtask_id</span><span
                        >user_id</span
                      ><span>timestamp</span><span>kind</span>
                    </div>
                    {#each locks as l}
                      <div class="trow" style="--cols: 1fr 1fr 1fr 1.4fr 1fr">
                        <span class="mono">{l.task_id}</span>
                        <span class="mono">{l.subtask_id || "—"}</span>
                        <span class="mono">{l.user_id}</span>
                        <span class="mono dim">{l.timestamp}</span>
                        <span class="mono">{l.kind}</span>
                      </div>
                    {/each}
                    {#if locks.length === 0}
                      <div class="tempty mono">— no active locks —</div>
                    {/if}
                  </div>
                </div>

                <div class="tsec">
                  <div class="tname">comment.csv</div>
                  <div class="tcard">
                    <div
                      class="trow thead"
                      style="--cols: 0.8fr 0.8fr 0.8fr 0.6fr 0.8fr 2fr"
                    >
                      <span>id</span><span>task_id</span><span>kind</span><span
                        >anchor</span
                      ><span>author</span><span>body</span>
                    </div>
                    {#each comments as c (c.comment_id)}
                      <div
                        class="trow"
                        class:subrow={c.resolved === "true"}
                        style="--cols: 0.8fr 0.8fr 0.8fr 0.6fr 0.8fr 2fr"
                      >
                        <span class="mono dim">{c.comment_id}</span>
                        <span class="mono">{c.task_id}</span>
                        <span class="mono">{c.kind}</span>
                        <span class="mono dim"
                          >{hasAnchor(c) ? anchorLabel(c) : "—"}</span
                        >
                        <span class="mono">{commentLogin(c)}</span>
                        <span>{c.body}</span>
                      </div>
                    {/each}
                    {#if comments.length === 0}
                      <div class="tempty mono">— no comments —</div>
                    {/if}
                  </div>
                </div>

                <div class="tsec">
                  <div class="tname">
                    history.csv <span class="mono dim small"
                      >(append-only, newest first)</span
                    >
                  </div>
                  <div class="tcard">
                    {#each historyNewestFirst as h, i (i)}
                      <div class="hrow">
                        <span class="mono xts">{h.timestamp}</span>
                        <span class="mono">@{logins[h.user_id] || h.user_id}</span>
                        <span
                          >{h.action}{h.task_id
                            ? ` ${h.task_id}`
                            : ""}{h.subtask_id ? `/${h.subtask_id}` : ""}</span
                        >
                        <span
                          class="outcome"
                          class:bad={h.outcome !== "accepted" &&
                            h.outcome !== "released"}>{h.outcome}</span
                        >
                        <span class="dim">{h.detail}</span>
                      </div>
                    {/each}
                    {#if history.length === 0}
                      <div class="tempty mono">— no history yet —</div>
                    {/if}
                  </div>
                </div>
              </div>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  {/if}

  {#if overlayTask && overlayCard}
    <div
      class="scrim"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) closeOverlay();
      }}
    >
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Task ${overlayCard.title}`}
      >
        {@render resultBanner()}
        <div class="mhead">
          <span class="ticon" class:pre={overlayCard.pre}
            >{overlayCard.pre ? "M" : "E"}</span
          >
          <span class="mtitle">{overlayCard.title}</span>
          <span class="mono mtask">{overlayCard.task}</span>
          <span class="pill s-{overlayCard.statusKey}">
            {overlayCard.statusKey === "validation_required"
              ? `validation · ${overlayCard.passes} of ${overlayCard.threshold} passes`
              : statusPill(overlayCard.statusKey, overlayCard.pre)}
          </span>
          {#if overlayCard.counts.fails > 0}
            <span class="chip chip-fail"
              >{overlayCard.counts.fails} fail{overlayCard.counts.fails === 1
                ? ""
                : "s"}</span
            >
          {/if}
          <span class="mspacer"></span>
          <button
            type="button"
            class="mbtn"
            onclick={() => rawlink(overlayCard!.task)}
            disabled={busy}
            title="Copy a direct link to the score file to paste into mei-friend manually."
            >Copy raw link</button
          >
          {#if mineEncoding}
            <button
              type="button"
              class="mbtn primary"
              onclick={() => submitpr(overlayCard!.task)}
              disabled={busy}
              title="After committing your encoding in mei-friend, submit it for validation."
              >Submit encoding</button
            >
          {/if}
          {#if overlayCard.pre}
            <a
              class="mbtn blue"
              href={`/${campaign}/zones/${overlayCard.task}`}
              title="Open the measure zones on the facsimile."
              >Open zone editor</a
            >
          {:else}
            <button
              type="button"
              class="mbtn blue"
              onclick={() => editor(overlayCard!.task)}
              disabled={busy || !auth.user || overlayCard.column === "blocked"}
              title="Opens the score in mei-friend; claims the task for you first when it is open to claim."
              >Open in mei-friend ↗</button
            >
          {/if}
          <button
            type="button"
            class="mclose"
            onclick={closeOverlay}
            aria-label="Close the preview"
            title="Close the preview">×</button
          >
        </div>
        <div class="mbody">
          <div class="mpreview">
            <div class="ptoolbar">
              <button
                type="button"
                class="tbtn-sq"
                onclick={() => pvGo(-1)}
                disabled={pvSpreadIndex <= 0}
                aria-label="Previous page">‹</button
              >
              <span class="pglabel">{pvSpreadLabel}</span>
              <button
                type="button"
                class="tbtn-sq"
                onclick={() => pvGo(1)}
                disabled={pvSpreadIndex >= pvSpreads.length - 1}
                aria-label="Next page">›</button
              >
              <span class="mspacer"></span>
              {#if preview?.facs?.length}
                <button
                  type="button"
                  class="tchip"
                  class:on={showZones}
                  onclick={() => (showZones = !showZones)}
                  title="Show or hide the measure zones on the facsimile"
                  >Measure zones · {showZones ? "on" : "off"}</button
                >
              {/if}
              <button
                type="button"
                class="tchip"
                class:on={pvView === "double"}
                onclick={() =>
                  pvSetView(pvView === "double" ? "single" : "double")}
                title="Show a two-page spread">Double page</button
              >
              {#if pvView === "double"}
                <label
                  class="pcheck"
                  title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens"
                >
                  <input
                    type="checkbox"
                    checked={pvFirstOnRight}
                    onchange={(e) =>
                      pvSetFirstOnRight(
                        (e.target as HTMLInputElement).checked,
                      )}
                  />
                  Page 1 right
                </label>
              {/if}
              <span class="vline"></span>
              <button
                type="button"
                class="tbtn-sq"
                onclick={() => pvZoomBy(-0.25)}
                disabled={pvZoom <= PV_ZOOM_MIN}
                aria-label="Zoom out">−</button
              >
              <span class="zval mono">{Math.round(pvZoom * 100)}%</span>
              <button
                type="button"
                class="tbtn-sq"
                onclick={() => pvZoomBy(0.25)}
                disabled={pvZoom >= PV_ZOOM_MAX}
                aria-label="Zoom in">+</button
              >
            </div>
            <div class="pbody-panes">
              {#if !preview || preview.loading}
                <p class="muted pnote">Loading the score…</p>
              {:else if preview.error}
                <p class="perr">{preview.error}</p>
              {:else}
                {#if preview.facs?.length}
                  <div class="pane">
                    <div class="pv-scroll">
                      <div class="pv-spread" style={`width:${pvZoom * 100}%`}>
                        {#if pvSpread.lonelySide === "right"}<div
                            class="pv-spacer"
                          ></div>{/if}
                        {#each pvSpread.pages as p (p)}
                          {@const pg = preview.facs[p]}
                          <figure class="pv-page">
                            {#if pg}
                              <svg
                                viewBox={`0 0 ${pg.w} ${pg.h}`}
                                role="img"
                                aria-label={`Facsimile page ${p + 1}`}
                              >
                                {#if pg.url}
                                  <image
                                    href={pg.url}
                                    width={pg.w}
                                    height={pg.h}
                                  />
                                {:else}
                                  <rect
                                    width={pg.w}
                                    height={pg.h}
                                    fill="#f3f3f0"
                                  />
                                {/if}
                                {#if showZones}
                                  {#each pg.zones as z, zi (zi)}
                                    <rect
                                      class="pv-zone"
                                      class:flagged={anchor &&
                                        p + 1 === anchor.page &&
                                        zoneFlagged(z.label)}
                                      x={z.box.ulx}
                                      y={z.box.uly}
                                      width={z.box.lrx - z.box.ulx}
                                      height={z.box.lry - z.box.uly}
                                    />
                                    <text
                                      class="pv-zonelabel"
                                      class:flagged={anchor &&
                                        p + 1 === anchor.page &&
                                        zoneFlagged(z.label)}
                                      x={z.box.ulx + 6}
                                      y={z.box.uly + 30}>{z.label}</text
                                    >
                                  {/each}
                                {/if}
                              </svg>
                              <figcaption class="mono">
                                page {p + 1}
                              </figcaption>
                            {/if}
                          </figure>
                        {/each}
                        {#if pvSpread.lonelySide === "left"}<div
                            class="pv-spacer"
                          ></div>{/if}
                      </div>
                    </div>
                    <div class="pane-cap">Facsimile</div>
                  </div>
                {/if}
                {#if preview.pageCount > 0}
                  <div class="pane">
                    <div class="pv-scroll">
                      <div class="pv-spread" style={`width:${pvZoom * 100}%`}>
                        {#if pvSpread.lonelySide === "right"}<div
                            class="pv-spacer"
                          ></div>{/if}
                        {#each pvSpread.pages as p (p)}
                          <div class="pv-page enc">
                            {#if p < preview.pageCount}
                              {@html flagSvg(preview.svgs[p + 1] ?? "")}
                            {/if}
                          </div>
                        {/each}
                        {#if pvSpread.lonelySide === "left"}<div
                            class="pv-spacer"
                          ></div>{/if}
                      </div>
                    </div>
                    <div class="pane-cap">
                      Current encoding — rendered with Verovio
                    </div>
                  </div>
                {:else if preview.facs?.length}
                  <div class="pane">
                    <p class="muted pnote">
                      No encoding to render yet — the measures are generated
                      when the measure correction is submitted.
                    </p>
                    <div class="pane-cap">Current encoding</div>
                  </div>
                {/if}
              {/if}
            </div>
          </div>
          <div class="mrail">
            <div class="rail-scroll">
              <div class="rsec">
                <div class="rlabel">Validation record</div>
                {#each record as r (r.sub + "/" + r.slot)}
                  {#if r.key === "fail"}
                    <div class="failbox">
                      <div class="failhead">
                        {@render slotDot("fail")}
                        <span class="failtitle">Slot {r.slot + 1} · fail</span>
                        <span class="rwho">{r.login} · {r.elapsed}</span>
                      </div>
                      {#if r.comment}
                        <div class="failbody">“{r.comment.body}”</div>
                        {#if hasAnchor(r.comment)}
                          <div class="failchips">
                            <button
                              type="button"
                              class="chip chip-question anchorchip"
                              onclick={() => showAnchorFor(r.comment!)}
                              title="Highlight this measure range in the preview"
                              >{anchorLabel(r.comment)} — show in the preview</button
                            >
                          </div>
                        {/if}
                      {:else}
                        <div class="failbody muted">
                          No comment was recorded with this fail.
                        </div>
                      {/if}
                      <div class="failacts">
                        {#if r.comment && r.comment.resolved !== "true" && canResolve(r.comment)}
                          <button
                            type="button"
                            class="linkish"
                            onclick={() =>
                              resolveCommentRow(r.comment!.comment_id)}
                            disabled={busy}
                            title="Mark this fail's comment as handled — it leaves the attention counts."
                            >Resolve</button
                          >
                        {:else if r.comment?.resolved === "true"}
                          <span class="muted small-note">resolved</span>
                        {/if}
                        <span class="mspacer"></span>
                        {#if viewer !== "" && (canPush || r.userId === viewer)}
                          <button
                            type="button"
                            class="dangerbtn"
                            onclick={() => sendBackTask(overlayCard!.task)}
                            disabled={busy}
                            title="Return the task to encoding: attribution and validations reset."
                            >Send back for encoding</button
                          >
                        {/if}
                      </div>
                    </div>
                  {:else}
                    <div class="rrow">
                      {@render slotDot(r.key)}
                      <span class="rslot"
                        >Slot {r.slot + 1} · {r.key === "review"
                          ? "in review"
                          : r.key}</span
                      >
                      {#if r.login}
                        <span class="rwho">{r.login} · {r.elapsed}</span>
                      {/if}
                      <span class="mspacer"></span>
                      {#if r.key === "pass"}
                        <span class="muted small-note">no remarks</span>
                      {:else if r.key === "open" && r.claimable}
                        <button
                          type="button"
                          class="claimbtn"
                          onclick={() =>
                            claimValidate(overlayCard!.task, r.sub)}
                          disabled={busy}
                          title="Reserve this validation slot for review."
                          >Claim to review</button
                        >
                      {:else if r.key === "open"}
                        <span class="muted small-note">{r.note}</span>
                      {:else if r.mine}
                        <button
                          type="button"
                          class="passbtn"
                          onclick={() =>
                            validate(overlayCard!.task, r.sub, "pass")}
                          disabled={busy}
                          title="Record a passing verdict.">Pass</button
                        >
                        <button
                          type="button"
                          class="failbtn"
                          class:on={failForm?.sub === r.sub}
                          onclick={() =>
                            (failForm =
                              failForm?.sub === r.sub
                                ? null
                                : {
                                    sub: r.sub,
                                    body: "",
                                    page: String(
                                      (pvSpread.pages[0] ?? 0) + 1,
                                    ),
                                    m1: "",
                                    m2: "",
                                  })}
                          disabled={busy}
                          title="Record a failing verdict — a fail carries a comment saying why."
                          >Fail</button
                        >
                      {/if}
                    </div>
                    {#if failForm && failForm.sub === r.sub && r.mine}
                      <div class="failform">
                        <textarea
                          rows="3"
                          bind:value={failForm.body}
                          placeholder="Why does this fail? (required)"
                        ></textarea>
                        <div class="failform-anchor">
                          <label
                            >p. <input
                              size="3"
                              bind:value={failForm.page}
                            /></label
                          >
                          <label
                            >m. <input
                              size="4"
                              bind:value={failForm.m1}
                              placeholder="from"
                            /></label
                          >
                          <label
                            >– <input
                              size="4"
                              bind:value={failForm.m2}
                              placeholder="to"
                            /></label
                          >
                          <span class="mspacer"></span>
                          <button
                            type="button"
                            class="dangerbtn"
                            onclick={submitFail}
                            disabled={busy || !failForm.body.trim()}
                            >Submit fail</button
                          >
                        </div>
                      </div>
                    {/if}
                  {/if}
                {/each}
                <div class="rfoot">
                  A fail always carries a comment — the validator cannot submit
                  one without saying why.
                </div>
              </div>
              <div class="rsec discussion">
                <div class="rlabel">
                  Discussion · {threads.reduce(
                    (n, t) => n + 1 + t.replies.length,
                    0,
                  )}
                </div>
                {#each threads as t (t.root.comment_id)}
                  <div class="crow" class:resolved={t.root.resolved === "true"}>
                    <div class="chead">
                      <span class="avatar small"
                        >{initialOf(commentLogin(t.root))}</span
                      >
                      <span class="cwho">{commentLogin(t.root)}</span>
                      {#if t.root.kind === "question"}
                        <span class="chip chip-question">? question</span>
                      {:else}
                        <span class="chip chip-note">note</span>
                      {/if}
                      {#if t.root.resolved === "true"}
                        <span class="muted small-note">resolved</span>
                      {/if}
                      <span class="cwhen">{elapsed(t.root.timestamp)}</span>
                    </div>
                    <div class="cbody">“{t.root.body}”</div>
                    <div class="cacts">
                      {#if auth.user}
                        <button
                          type="button"
                          class="linkish"
                          onclick={() => (replyTo = t.root)}>Reply</button
                        >
                      {/if}
                      {#if t.root.resolved !== "true" && canResolve(t.root)}
                        <button
                          type="button"
                          class="linkish"
                          onclick={() => resolveCommentRow(t.root.comment_id)}
                          disabled={busy}>Resolve</button
                        >
                      {/if}
                    </div>
                    {#each t.replies as reply (reply.comment_id)}
                      <div class="creply">
                        <div class="chead">
                          <span class="avatar small"
                            >{initialOf(commentLogin(reply))}</span
                          >
                          <span class="cwho">{commentLogin(reply)}</span>
                          <span class="cwhen">{elapsed(reply.timestamp)}</span>
                        </div>
                        <div class="cbody">“{reply.body}”</div>
                      </div>
                    {/each}
                  </div>
                {/each}
                {#if threads.length === 0}
                  <div class="muted small-note cnone">No discussion yet.</div>
                {/if}
              </div>
            </div>
            {#if auth.user}
              <div class="composer">
                {#if replyTo}
                  <div class="replying">
                    Replying to <strong>{commentLogin(replyTo)}</strong>
                    <button
                      type="button"
                      class="linkish"
                      onclick={() => (replyTo = null)}>Cancel</button
                    >
                  </div>
                {:else}
                  <div class="kindpick">
                    <button
                      type="button"
                      class="tchip"
                      class:on={composerKind === "question"}
                      onclick={() => (composerKind = "question")}
                      title="Ask the campaign a question">question</button
                    >
                    <button
                      type="button"
                      class="tchip"
                      class:on={composerKind === "addition"}
                      onclick={() => (composerKind = "addition")}
                      title="Leave a note">note</button
                    >
                  </div>
                {/if}
                <div class="composer-row">
                  <input
                    bind:value={composerText}
                    placeholder="Reply or leave a note…"
                    onkeydown={(e) => {
                      if (e.key === "Enter" && composerText.trim())
                        postComment();
                    }}
                  />
                  <button
                    type="button"
                    class="sendbtn"
                    onclick={postComment}
                    disabled={busy || !composerText.trim()}>Send</button
                  >
                </div>
              </div>
            {/if}
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .console {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-alt);
    background-image:
      radial-gradient(
        60% 90% at 15% 0%,
        rgba(109, 195, 255, 0.12),
        transparent 60%
      ),
      radial-gradient(
        60% 90% at 85% 10%,
        rgba(118, 222, 118, 0.12),
        transparent 60%
      ),
      radial-gradient(
        50% 80% at 50% 100%,
        rgba(255, 167, 109, 0.1),
        transparent 60%
      );
    /* Board-only surfaces without a global token. */
    --well: rgba(255, 255, 255, 0.65);
    --track: #eef2f8;
    --hairline: #f0f1f5;
  }
  :global([data-theme="dark"]) .console {
    --well: rgba(28, 31, 43, 0.55);
    --track: var(--bg-tint);
    --hairline: #232736;
  }
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .muted {
    color: var(--ink-faint);
  }
  .msg {
    padding: 1rem 1.4rem;
  }

  /* ------------------------------------------------------------ banners */
  .banner {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 20px;
    font-size: 12.5px;
    flex: none;
  }
  .banner.ok {
    background: var(--ok-bg);
    border-bottom: 1px solid var(--ok-line);
    color: var(--ok);
  }
  .banner.err {
    background: var(--danger-bg);
    border-bottom: 1px solid var(--danger-line);
    color: var(--danger);
  }
  .banner.warn {
    background: var(--warn-bg);
    border-bottom: 1px solid var(--warn-line);
    color: var(--warn);
  }
  .banner-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .dismiss {
    font-size: 11px;
    font-weight: 600;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    flex: none;
  }
  .rawlink {
    display: flex;
    gap: 0.4rem;
  }
  .rawlink input {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
  }
  .rawlink button {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
    cursor: pointer;
  }
  .linkish {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    cursor: pointer;
  }
  .linkish:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* --------------------------------------------------------------- main */
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .viewcol {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* --------------------------------------------------------- info panel */
  .ipanel {
    width: var(--ipanel-w, 300px);
    flex: none;
    border-right: 1px solid var(--line);
    background: var(--card);
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }
  .ipanel-resizer {
    position: absolute;
    right: -5px;
    top: 0;
    bottom: 0;
    width: 9px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: col-resize;
    z-index: 5;
  }
  .ipanel-resizer:hover,
  .ipanel-resizer:active {
    background: var(--accent-wash);
  }
  .iphead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--line);
    flex: none;
  }
  .iptitle {
    font-weight: 600;
    font-size: 13px;
  }
  .ipbody {
    padding: 15px 16px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    overflow: auto;
  }
  .isec {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .inote {
    font-size: 11px;
  }
  .irow {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
  }
  .irow > span:first-child {
    color: var(--ink-faint);
    flex: none;
  }
  .irow > :last-child {
    text-align: right;
    overflow-wrap: anywhere;
  }
  .irow a {
    color: var(--link);
    text-decoration: none;
  }
  .irow a:hover {
    text-decoration: underline;
  }
  .seclabel {
    font-weight: 600;
    font-size: 10px;
    color: var(--ink-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .pclose {
    font-size: 11px;
    font-weight: 600;
    border: none;
    background: none;
    color: var(--ink-faint);
    cursor: pointer;
    padding: 4px;
    flex: none;
  }

  /* ---------------------------------------------------------------- hero */
  .hero {
    flex: none;
    padding: 26px 32px 18px;
    display: flex;
    align-items: flex-end;
    gap: 24px;
  }
  .hero-titles {
    flex: 1;
    min-width: 0;
  }
  .eyebrow {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .hero-line {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-top: 4px;
    min-width: 0;
  }
  .hero-line h1 {
    margin: 0;
    font-size: 30px;
    line-height: 1.2;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .slug {
    font-size: 13px;
    color: var(--ink-faint);
    text-decoration: none;
    flex: none;
  }
  .slug:hover {
    text-decoration: underline;
  }
  .hero-stats {
    display: flex;
    gap: 16px;
    margin-top: 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .hbar {
    width: 280px;
    height: 6px;
    border-radius: 3px;
    background: var(--track);
    overflow: hidden;
  }
  .hbar div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .stat {
    font-size: 13px;
    color: var(--ink-soft);
  }
  .stat.strong {
    font-weight: 600;
  }
  .stat.inflight {
    color: var(--info);
    font-weight: 600;
  }
  .stat.attention {
    color: var(--warn);
    font-weight: 600;
  }
  .sep {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .hero-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 12px;
    flex: none;
  }
  .hero-tools {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hbtn {
    font-size: 11px;
    font-weight: 500;
    padding: 6px 11px;
    border: 1px solid var(--line-strong);
    border-radius: 7px;
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    font-family: inherit;
  }
  .hbtn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .hbtn.on {
    background: var(--invert-bg);
    border-color: var(--invert-bg);
    color: var(--invert-ink);
  }
  .tabs {
    display: flex;
    border: 1px solid var(--line-strong);
    border-radius: 7px;
    overflow: hidden;
  }
  .tabs button {
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    padding: 6px 11px;
    background: var(--card);
    color: var(--ink-faint);
    border: none;
    cursor: pointer;
  }
  .tabs button.on {
    font-weight: 600;
    background: var(--invert-bg);
    color: var(--invert-ink);
  }
  .hero-acts {
    display: flex;
    gap: 10px;
  }
  .pillbtn {
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    padding: 8px 18px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
  }
  .pillbtn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .pillbtn.primary {
    border: 0;
    background: var(--accent-btn);
    color: #fff;
    box-shadow: 0 1px 3px rgba(37, 99, 201, 0.35);
  }
  .pillbtn.primary:hover:not(:disabled) {
    background: var(--accent-btn-hover);
    color: #fff;
  }
  .pillbtn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* --------------------------------------------------------------- board */
  .board {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
    padding: 0 32px;
  }
  .bcol {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .bcol-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px;
  }
  .bcol-name {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .bcol-count {
    font-size: 11px;
    font-weight: 700;
    background: var(--track);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .bcol-head.c-blocked {
    color: var(--ink-faint);
  }
  .bcol-head.c-ready {
    color: var(--ink-soft);
  }
  .bcol-head.c-encoding {
    color: var(--info);
  }
  .bcol-head.c-encoding .bcol-count {
    background: var(--info-bg);
  }
  .bcol-head.c-validation {
    color: var(--warn);
  }
  .bcol-head.c-validation .bcol-count {
    background: var(--warn-bg);
  }
  .bcol-head.c-done {
    color: var(--ok);
  }
  .bcol-head.c-done .bcol-count {
    background: var(--ok-bg);
  }
  .bcol-flag {
    font-size: 11px;
    font-weight: 700;
    color: #fff;
    background: var(--warn-solid);
    border-radius: 999px;
    padding: 1px 7px;
    margin-left: auto;
  }
  .well {
    background: var(--well);
    border: 1px dashed var(--line-strong);
    border-radius: 14px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .card {
    position: relative;
    display: block;
    text-align: left;
    font-family: inherit;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
    flex: none;
  }
  .card:hover {
    border-color: var(--accent);
  }
  .card.col-blocked {
    opacity: 0.8;
    box-shadow: none;
  }
  .card.col-encoding {
    border: 1.5px solid var(--info-line);
  }
  .card.col-validation {
    border: 1.5px solid var(--warn-line);
  }
  .card.col-done {
    box-shadow: none;
  }
  .card.nextup {
    border-color: var(--accent);
  }
  .nextup-badge {
    position: absolute;
    top: -9px;
    left: 12px;
    background: var(--accent);
    color: var(--invert-ink);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 2px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  :global([data-theme="dark"]) .nextup-badge {
    color: #fff;
  }
  .card-title {
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .card.col-blocked .card-title,
  .card.col-done .card-title {
    color: var(--ink-soft);
  }
  .card-type {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 3px;
  }
  .card-id {
    font-size: 10px;
    opacity: 0.8;
    margin-left: 4px;
  }
  .card-foot {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 8px;
    border-top: 1px solid var(--hairline);
    padding-top: 8px;
  }
  .card-claim {
    margin-top: 8px;
  }
  .claimlink {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--accent);
    cursor: pointer;
  }
  .claimlink:hover {
    text-decoration: underline;
  }
  .card-worker {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 9px;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-btn);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .avatar.small {
    width: 22px;
    height: 22px;
    font-size: 11px;
  }
  .worker-line {
    font-size: 11.5px;
    color: var(--info);
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-dots {
    display: flex;
    gap: 4px;
    margin-top: 9px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line-input);
    flex: none;
    display: inline-block;
  }
  .dot.pass {
    background: var(--green);
    border-color: var(--ok);
  }
  :global([data-theme="dark"]) .dot.pass {
    background: var(--ok);
    border-color: var(--ok-line);
  }
  .dot.fail {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
  }
  .dot.review {
    background: var(--info-bg);
    border-color: var(--info);
  }
  .card-chips {
    display: flex;
    gap: 6px;
    margin-top: 9px;
    border-top: 1px solid var(--hairline);
    padding-top: 9px;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 11px;
    font-weight: 700;
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .chip-fail {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
  .chip-note {
    color: var(--warn);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
  }
  .chip-question {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .card-done {
    font-size: 11.5px;
    color: var(--ok);
    font-weight: 600;
    margin-top: 3px;
  }
  .more {
    font: inherit;
    font-size: 12px;
    color: var(--ink-faint);
    text-align: center;
    padding: 4px;
    background: none;
    border: none;
    cursor: pointer;
  }
  .more:hover {
    color: var(--accent);
  }

  /* -------------------------------------------------------------- ticker */
  .ticker {
    flex: none;
    margin: 16px 32px 24px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-sm);
    height: 56px;
    display: flex;
    align-items: center;
    padding: 0 18px;
    gap: 18px;
    overflow: hidden;
  }
  .ticker-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    flex: none;
  }
  .ticker-entry {
    font-size: 12.5px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .ticker-when {
    color: var(--ink-faint);
  }
  .ticker-sep {
    color: var(--line-strong);
    flex: none;
  }
  .tspacer,
  .mspacer {
    flex: 1;
  }

  /* ------------------------------------------------------------- overlay */
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(31, 36, 51, 0.42);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: 24px;
  }
  :global([data-theme="dark"]) .scrim {
    background: rgba(0, 0, 0, 0.55);
  }
  .modal {
    width: min(1440px, 100%);
    height: min(820px, 100%);
    background: var(--card);
    border-radius: 14px;
    box-shadow: 0 24px 80px rgba(31, 36, 51, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .modal .banner {
    border-radius: 0;
  }
  .mhead {
    min-height: 58px;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    padding: 6px 20px;
    gap: 12px;
    flex-wrap: wrap;
  }
  .ticon {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: var(--info-bg);
    border: 1px solid var(--info-line);
    color: var(--info);
    font:
      700 12px ui-monospace,
      monospace;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .ticon.pre {
    background: var(--pre-bg);
    border-color: var(--pre);
    color: var(--pre);
  }
  .mtitle {
    font-size: 16px;
    font-weight: 700;
  }
  .mtask {
    font-size: 11px;
    color: var(--ink-faint);
  }
  .mbtn {
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 7px 15px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    text-decoration: none;
    flex: none;
  }
  .mbtn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .mbtn.blue {
    border-color: var(--info-line);
    color: var(--info);
  }
  .mbtn.primary {
    border: 0;
    background: var(--accent-btn);
    color: #fff;
  }
  .mbtn.primary:hover:not(:disabled) {
    background: var(--accent-btn-hover);
    color: #fff;
  }
  .mbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mclose {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-faint);
    font-size: 15px;
    cursor: pointer;
    flex: none;
  }
  .mclose:hover {
    color: var(--ink);
  }
  .mbody {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .mpreview {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--line);
  }
  .ptoolbar {
    height: 44px;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 10px;
    overflow-x: auto;
  }
  .tbtn-sq {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
    font-family: inherit;
  }
  .tbtn-sq:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .pglabel {
    font-size: 12.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tchip {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
    white-space: nowrap;
  }
  .tchip.on {
    border-color: var(--info-line);
    background: var(--info-bg);
    color: var(--info);
  }
  .pcheck {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .vline {
    width: 1px;
    height: 18px;
    background: var(--line);
    flex: none;
  }
  .zval {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    min-width: 38px;
    text-align: center;
  }
  .pbody-panes {
    flex: 1;
    min-height: 0;
    background: var(--bg-inset);
    display: flex;
    gap: 16px;
    padding: 16px;
  }
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .pane-cap {
    font-size: 11.5px;
    color: var(--ink-faint);
    text-align: center;
    flex: none;
  }
  .pnote,
  .perr {
    margin: 0;
    padding: 14px;
    font-size: 12px;
  }
  .perr {
    color: var(--danger);
  }
  .pv-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .pv-spread {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    min-width: 100%;
    box-sizing: border-box;
  }
  .pv-spacer,
  .pv-page {
    flex: 1 1 0;
    min-width: 0;
  }
  .pv-page {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pv-page > svg {
    width: 100%;
    height: auto;
    display: block;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--facsimile-paper);
  }
  /* The rendered pages are paper: they stay light in both themes. */
  .pv-page.enc :global(svg) {
    width: 100%;
    height: auto;
    display: block;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fdfdfe;
  }
  .pv-page figcaption {
    font-size: 10px;
    color: var(--ink-faint);
    text-align: center;
  }
  .pv-zone {
    fill: rgba(109, 195, 255, 0.12);
    stroke: rgba(37, 99, 201, 0.55);
    stroke-width: 2;
  }
  .pv-zone.flagged {
    fill: rgba(180, 35, 24, 0.1);
    stroke: #b42318;
    stroke-width: 3;
  }
  .pv-zonelabel {
    font:
      24px ui-monospace,
      monospace;
    fill: #1a1a1a;
    paint-order: stroke;
    stroke: #fff;
    stroke-width: 4;
  }
  .pv-zonelabel.flagged {
    fill: #b42318;
    font-weight: 700;
  }
  .pv-page.enc :global(g.measure.m-flag *) {
    fill: #b42318;
    stroke: #b42318;
  }

  /* ---------------------------------------------------------- right rail */
  .mrail {
    width: 400px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 6px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .rlabel {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    padding-bottom: 4px;
  }
  .rrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .rslot {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
  }
  .rwho {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .small-note {
    font-size: 11.5px;
    white-space: nowrap;
  }
  .claimbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--info-line);
    background: var(--card);
    color: var(--info);
    cursor: pointer;
    flex: none;
  }
  .claimbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .passbtn,
  .failbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--ok-line);
    background: var(--card);
    color: var(--ok);
    cursor: pointer;
    flex: none;
  }
  .failbtn {
    border-color: var(--danger-line);
    color: var(--danger);
  }
  .failbtn.on {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
    color: #fff;
  }
  .passbtn:disabled,
  .failbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .failbox {
    margin: 10px 0;
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    background: var(--danger-wash);
    padding: 12px 14px;
  }
  .failhead {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .failtitle {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--danger);
  }
  .failbody {
    font-size: 12.5px;
    color: var(--ink);
    margin-top: 8px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .failchips {
    display: flex;
    gap: 6px;
    margin-top: 9px;
    flex-wrap: wrap;
  }
  .anchorchip {
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .failacts {
    display: flex;
    gap: 12px;
    margin-top: 10px;
    align-items: center;
  }
  .dangerbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 5px 12px;
    border-radius: 999px;
    border: 0;
    background: var(--danger-solid);
    color: #fff;
    cursor: pointer;
    flex: none;
  }
  .dangerbtn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .rfoot {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 8px;
    line-height: 1.5;
  }
  .failform {
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    padding: 10px 12px;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--danger-wash);
  }
  .failform textarea {
    font: inherit;
    font-size: 12.5px;
    padding: 7px 10px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
    resize: vertical;
  }
  .failform-anchor {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--ink-soft);
    flex-wrap: wrap;
  }
  .failform-anchor input {
    font: inherit;
    font-size: 11.5px;
    padding: 3px 6px;
    border: 1px solid var(--line-input);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    width: 3.2em;
  }

  /* ---------------------------------------------------------- discussion */
  .discussion {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .crow {
    padding: 10px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .crow.resolved {
    opacity: 0.55;
  }
  .chead {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cwho {
    font-size: 12.5px;
    font-weight: 600;
  }
  .cwhen {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-left: auto;
  }
  .cbody {
    font-size: 12.5px;
    color: var(--ink-soft);
    margin-top: 6px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .cacts {
    display: flex;
    gap: 12px;
    margin-top: 6px;
  }
  .creply {
    padding: 10px 0 0 18px;
  }
  .cnone {
    padding: 8px 0;
  }
  .composer {
    flex: none;
    padding: 10px 20px 16px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .replying {
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .kindpick {
    display: flex;
    gap: 6px;
  }
  .composer-row {
    display: flex;
    gap: 8px;
  }
  .composer-row input {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-family: inherit;
    padding: 8px 12px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
  }
  .sendbtn {
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 8px 16px;
    border-radius: 999px;
    border: 0;
    background: var(--accent-btn);
    color: #fff;
    cursor: pointer;
    flex: none;
  }
  .sendbtn:hover:not(:disabled) {
    background: var(--accent-btn-hover);
  }
  .sendbtn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* ---------------------------------------------------------------- pills */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 999px;
    white-space: nowrap;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
  }
  .pill.s-completed,
  .pill.s-pass {
    background: var(--ok-bg);
    border-color: var(--ok-line);
    color: var(--ok);
  }
  .pill.s-encoding_required,
  .pill.s-encoding,
  .pill.s-claimed {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .pill.s-validation_required,
  .pill.s-review {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .pill.s-fail {
    background: var(--danger-bg);
    border-color: var(--danger-line);
    color: var(--danger);
  }

  /* ------------------------------------------------------------- tables */
  .tablesview {
    flex: 1;
    overflow: auto;
    padding: 22px 26px;
  }
  .tcol {
    max-width: 900px;
    display: flex;
    flex-direction: column;
    gap: 26px;
  }
  .tname {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .tcard {
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--card);
  }
  .trow {
    display: grid;
    grid-template-columns: var(--cols);
    border-bottom: 1px solid var(--line);
    align-items: center;
  }
  .trow:last-child {
    border-bottom: none;
  }
  .trow > span {
    padding: 7px 10px;
    font-size: 11px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .trow.thead {
    background: var(--bg-alt);
    border-bottom: 1px solid var(--line);
  }
  .trow.thead > span {
    font-weight: 600;
    font-size: 10px;
    color: var(--ink-faint);
    padding: 8px 10px;
  }
  .trow.subrow {
    background: var(--bg-alt);
  }
  .trow .pill {
    font-size: 9px;
    padding: 2px 8px;
  }
  .dim {
    color: var(--ink-faint);
  }
  .small {
    font-size: 10px;
  }
  .tempty {
    padding: 9px 10px;
    font-size: 11px;
    color: var(--ink-faint);
  }
  .hrow {
    display: flex;
    gap: 10px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 11px;
    align-items: baseline;
  }
  .hrow:last-child {
    border-bottom: none;
  }
  .xts {
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .outcome {
    font-weight: 600;
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--ok-bg);
    color: var(--ok);
    white-space: nowrap;
  }
  .outcome.bad {
    background: var(--danger-bg);
    color: var(--danger);
  }

  /* --------------------------------------------------------- responsive */
  @media (max-width: 1100px) {
    .board {
      flex-direction: column;
      overflow-y: auto;
    }
    .bcol {
      min-height: auto;
    }
    .well {
      overflow-y: visible;
    }
    .hero {
      flex-direction: column;
      align-items: stretch;
    }
    .hero-right {
      align-items: flex-start;
    }
    .mbody {
      flex-direction: column;
      overflow-y: auto;
    }
    .mpreview {
      border-right: none;
      border-bottom: 1px solid var(--line);
      min-height: 380px;
    }
    .mrail {
      width: auto;
    }
  }
</style>
