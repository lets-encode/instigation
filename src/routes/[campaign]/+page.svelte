<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import { CommandRunner, readForge, viewerId } from "$lib/command-runner.svelte.ts";
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
  import { isPreTask } from "$lib/campaign-graph.ts";
  import { buildBoard, elapsed, initialOf } from "$lib/campaign-board.ts";
  import type { BoardCard, ColumnKey } from "$lib/campaign-board.ts";
  import { parseMeiHeader } from "$lib/mei-header.ts";
  import type { MeiHeader } from "$lib/mei-header.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import PlanEditor from "$lib/components/PlanEditor.svelte";
  import TaskDetail from "$lib/components/TaskDetail.svelte";

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
  const viewer = $derived(viewerId());

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

  const runner = new CommandRunner();

  // UI-only state — one surface at a time: the board (default), a task's
  // detail (?task= present), or the owner's manage takeover. Everything else
  // derives from the tracking tables.
  let manage = $state(false);
  let showInfo = $state(false);
  // Columns the viewer expanded past the card cap.
  let expanded = $state<Partial<Record<ColumnKey, boolean>>>({});
  const CARD_CAP = 5;
  // The Done column collapses to a summary card until expanded.
  let showAllDone = $state(false);

  // The score's <meiHead> fields, fetched on first open of the info panel.
  let scoreHead = $state<MeiHeader | null>(null);
  let scoreHeadState = $state<"idle" | "loading" | "done" | "error">("idle");
  async function loadScoreHead() {
    if (scoreHeadState !== "idle") return;
    scoreHeadState = "loading";
    try {
      const f = readForge();
      // The first task's fragment is the piece the campaign opens on.
      const mei = taskDefs[0]?.fragment
        ? await f.getRepoFile(owner, repo, taskDefs[0].fragment)
        : null;
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

  // --------------------------------------------------------- the task detail
  // A task's detail drills into the view body; the URL carries it as ?task=
  // so the row stays addressable (deep links, post-login resume).
  let detailTask = $state<string | null>(null);
  const detailCard = $derived(
    detailTask ? (allCards.find((c) => c.task === detailTask) ?? null) : null,
  );
  function openTask(task: string) {
    detailTask = task;
    goto(`/${campaign}?task=${encodeURIComponent(task)}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }
  function closeTask() {
    detailTask = null;
    goto(`/${campaign}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});

  // The context every command runs against; progress updates feed the busy
  // overlay's step log.
  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo }, { meiFriendUrl });

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
      await goto(`/new?slug=${encodeURIComponent(campaign)}`, { replaceState: true });
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
    // resolveCampaign reports as null (notFound). The lookup above is passed
    // through so the name is not fetched from the registry twice.
    const r = await resolveCampaign(readForge(), campaign, info).catch(() => null);
    if (r) resolved = r;
    else notFound = true;
  }

  $effect(() => {
    if (auth.status !== "loading" && owner && repo && !loaded) load();
  });

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(
    command: (c: CommandContext) => Promise<Result>,
    refresh = true,
  ) {
    const f = forge();
    if (!f) return;
    await runner.run(
      () => command(ctx(f)),
      async () => {
        if (refresh) {
          runner.log.step("Refreshing tables…");
          await load();
        }
      },
    );
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
    if (isPreTask(locator ?? "") && runner.result?.ok && !runner.result.warn) {
      await goto(`/${campaign}/zones/${task_id}`);
    }
  };

  // Open the task's score in mei-friend (claiming it if needed). The tab opens
  // only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  const editor = async (task_id: string) => {
    await run((c) => invoke(commands.openEditor, { task_id }, c));
    if (runner.result?.ok && !runner.result.warn && runner.result.meiFriendUrl) {
      window.open(runner.result.meiFriendUrl, "_blank", "noopener");
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

  const sendBackTask = (task_id: string) =>
    run((c) => invoke(commands.sendBack, { task_id }, c));

  const postComment = (kind: string, body: string, parent_id: string) =>
    run((c) =>
      invoke(
        commands.submitComment,
        {
          task_id: detailTask!,
          subtask_id: "",
          kind,
          body,
          page: "",
          measure_start: "",
          measure_end: "",
          parent_id,
        },
        c,
      ),
    );

  const resolveCommentRow = (comment_id: string) =>
    run((c) => invoke(commands.resolveComment, { comment_id }, c));

  // The tokenised raw URL of the score — copied to the clipboard.
  const rawlink = async (task_id: string) => {
    await run((c) => invoke(commands.rawLink, { task_id }, c), false);
    if (runner.result?.rawUrl) copy(runner.result.rawUrl);
  };

  const reaper = () => run((c) => invoke(commands.runReaper, {}, c));

  // Save the edited plan; a clean save leaves the manage takeover (run() has
  // already refreshed the tables, so the board reflects the new plan).
  async function savePlan(tasks: TaskRow[]) {
    await run((c) => invoke(commands.savePlan, { tasks }, c));
    if (runner.result?.ok) manage = false;
  }

  // Deep links, read once after the first load: ?task= opens that task's
  // detail.
  let deepLinked = false;
  $effect(() => {
    if (!loaded || deepLinked) return;
    deepLinked = true;
    const task = page.url.searchParams.get("task");
    if (task && findRow(taskDefs, task, "")) detailTask = task;
  });

  // "Claim the next task": act on the first card the viewer can work on — a
  // claim when it is open, otherwise its detail (their claimed or reviewable
  // work lives there).
  function claimCard(card: BoardCard) {
    if (card.pre) goto(`/${campaign}/zones/${card.task}`);
    else editor(card.task);
  }
  function actOnNext() {
    if (!nextCard) return;
    if (nextCard.column === "ready") claimCard(nextCard);
    else openTask(nextCard.task);
  }

  // The board rendered as four columns: queued-but-blocked tasks share the
  // Ready column (dimmed, with what they wait for) instead of a fifth column.
  const displayColumns = $derived.by(() => {
    const by = new Map(board.columns.map((c) => [c.key, c]));
    const ready = by.get("ready");
    const blocked = by.get("blocked");
    const encoding = by.get("encoding");
    const validation = by.get("validation");
    const done = by.get("done");
    return [
      {
        key: "ready" as ColumnKey,
        label: "Ready",
        cards: [...(ready?.cards ?? []), ...(blocked?.cards ?? [])],
        attention: 0,
      },
      {
        key: "encoding" as ColumnKey,
        label: "Encoding",
        cards: encoding?.cards ?? [],
        attention: encoding?.attention ?? 0,
      },
      {
        key: "validation" as ColumnKey,
        label: "Awaiting validation",
        cards: validation?.cards ?? [],
        attention: validation?.attention ?? 0,
      },
      {
        key: "done" as ColumnKey,
        label: "Done",
        cards: done?.cards ?? [],
        attention: 0,
      },
    ];
  });

  // The reaper's last trace in the history, for the manage header.
  const lastReap = $derived(
    history.findLast((h) => h.action === "reap") ?? null,
  );
  const elapsedLabel = (iso: string) => {
    const e = elapsed(iso);
    return e === "now" ? "just now" : `${e} ago`;
  };
</script>

{#if runner.busy}
  <LoadingOverlay log={runner.log} />
{/if}

{#snippet resultBanner()}
  {#if runner.result && runner.result.error}
    <div class="banner err">
      <span>
        {runner.result.error}
        {#if runner.result.prUrl}
          <a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
      </span>
      <button type="button" class="dismiss" onclick={() => (runner.result = null)}
        >Dismiss</button
      >
    </div>
  {:else if runner.result && runner.result.ok}
    <div class="banner {runner.result.warn ? 'warn' : 'ok'}">
      <div class="banner-body">
        {runner.result.message}
        {#if runner.result.prUrl}
          <a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
        {#if runner.result.meiFriendUrl}
          <div class="rawlink">
            <input
              readonly
              value={runner.result.meiFriendUrl}
              onfocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button type="button" onclick={() => copy(runner.result!.meiFriendUrl!)}
              >Copy</button
            >
          </div>
          <span class="muted">
            <a href={runner.result.meiFriendUrl} target="_blank" rel="noreferrer"
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
        {#if runner.result.rawUrl}
          <div class="rawlink">
            <input
              readonly
              value={runner.result.rawUrl}
              onfocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button type="button" onclick={() => copy(runner.result!.rawUrl!)}
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
      <button type="button" class="dismiss" onclick={() => (runner.result = null)}
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
    {#if !detailTask}
      {@render resultBanner()}
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
      {:else if detailTask && detailCard}
        <TaskDetail
          card={detailCard}
          {campaign}
          campaignTitle={title || repo}
          {owner}
          {repo}
          {taskDefs}
          {comments}
          {locks}
          {logins}
          {viewer}
          {canPush}
          {runner}
          {resultBanner}
          {slotDot}
          onclaim={claimValidate}
          oneditor={editor}
          onsubmitencoding={submitpr}
          onvalidate={validate}
          oncomment={postComment}
          onresolve={resolveCommentRow}
          onsendback={sendBackTask}
          onrawlink={rawlink}
          onclose={closeTask}
        />
      {:else if manage && canPush}
        <div class="crumbrow">
          <button type="button" class="backlink" onclick={() => (manage = false)}
            >← Back to the board</button
          >
          <span class="bcsep">/</span>
          <span class="crumbtitle">{title || repo}</span>
          <span class="crumbsub">· Manage</span>
          <span class="ownerpill">owner</span>
          <span class="cspacer"></span>
          <span class="reapline">
            {#if lastReap}
              Reaper last released a stale claim {elapsedLabel(lastReap.timestamp)}
            {:else}
              The reaper has not released any stale claims yet
            {/if}
          </span>
          <button
            type="button"
            class="reapbtn"
            onclick={() => reaper()}
            disabled={runner.busy}
            title="Release claims that have gone stale">Run reaper now</button
          >
        </div>
        <PlanEditor
          {taskDefs}
          {rows}
          {validationColumns}
          {locks}
          {logins}
          busy={runner.busy}
          onsave={savePlan}
          oncancel={() => (manage = false)}
        />
      {:else}
        <div class="hero">
          <div class="hero-line">
            <h1>{title || repo}</h1>
            <a
              class="mono slug"
              href={`https://github.com/${owner}/${repo}`}
              target="_blank"
              rel="noreferrer">{owner}/{repo} ↗</a
            >
            <button
              type="button"
              class="infochip"
              class:on={showInfo}
              onclick={() => {
                showInfo = !showInfo;
                if (showInfo) loadScoreHead();
              }}
              title="Show or hide campaign information"
              >ⓘ Info {showInfo ? "▾" : "▸"}</button
            >
            <span class="cspacer"></span>
            {#if auth.user && canPush}
              <button
                type="button"
                class="managechip"
                onclick={() => (manage = true)}
                disabled={runner.busy}
                title="Owner only — plan editor and reaper">⚙ Manage</button
              >
            {/if}
            <button
              type="button"
              class="pillbtn primary"
              disabled={runner.busy || !auth.user || !nextCard}
              title={!auth.user
                ? "Log in to claim a task."
                : !nextCard
                  ? "Nothing to claim right now."
                  : "Claim the first task that is open for you."}
              onclick={actOnNext}>Claim the next task</button
            >
          </div>
          <div class="hero-stats">
            <span class="stat"><b class="c-ok">{board.done}</b> done</span>
            <span class="sep">·</span>
            <span class="stat"><b class="c-info">{board.inFlight}</b> in flight</span>
            <span class="sep">·</span>
            <span class="stat"
              ><b class="c-danger">{board.attention}</b> need{board.attention === 1
                ? "s"
                : ""} attention</span
            >
            <span class="sep">·</span>
            <span class="stat"
              ><b>{board.contributorsWeek}</b> contributor{board.contributorsWeek ===
              1
                ? ""
                : "s"} this week</span
            >
            <div class="hbar">
              <div
                style={`width:${board.total ? Math.round((board.done / board.total) * 100) : 0}%`}
              ></div>
            </div>
            <span class="hbarlabel">{board.done}/{board.total} tasks done</span>
          </div>
        </div>

        {#if showInfo}
          <div class="infoblock">
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
                <span>About</span>
                <span>{description || "—"}</span>
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
              <div
                class="irow"
                title="Validation passes each task needs before it counts as validated."
              >
                <span>Passes required</span>
                <span>{passThreshold}</span>
              </div>
            </div>
          </div>
        {/if}

        <div class="board">
          {#each displayColumns as col (col.key)}
            <div class="bcol">
              <div class="bcol-head c-{col.key}">
                <span class="bcol-name">{col.label}</span>
                <span class="bcol-count">{col.cards.length}</span>
                {#if col.key === "validation" && col.attention > 0}
                  <span class="bcol-flag">{col.attention} ⚑</span>
                {/if}
              </div>
              <div class="well">
                {#if col.key === "done" && !showAllDone && col.cards.length > 1}
                  <div class="donesum">
                    <span
                      >{col.cards.length} completed tasks · merged into the
                      piece scores</span
                    >
                    <button
                      type="button"
                      class="linkish"
                      onclick={() => (showAllDone = true)}>Show all ▸</button
                    >
                  </div>
                {:else}
                  {#each expanded[col.key] || col.key === "done" ? col.cards : col.cards.slice(0, CARD_CAP) as card (card.task)}
                    <button
                      type="button"
                      class="card col-{card.column}"
                      class:nextup={card.nextUp}
                      class:pre={card.pre}
                      class:failtint={card.counts.fails > 0 &&
                        card.column !== "done"}
                      onclick={() =>
                        card.pre ? claimCard(card) : openTask(card.task)}
                      title={card.pre
                        ? "Open the measure corrector"
                        : "Open this task"}
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
                      {#if card.pre}
                        <div class="card-pre">Opens the corrector →</div>
                      {:else if card.column === "blocked"}
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
                  {#if col.key === "done" && showAllDone && col.cards.length > 1}
                    <button
                      type="button"
                      class="more"
                      onclick={() => (showAllDone = false)}
                      >show the summary</button
                    >
                  {:else if col.key !== "done" && col.cards.length > CARD_CAP}
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
        </div>
      {/if}
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
  /* The view's content stops widening at --page-max and centres past it; the
     console's gradient behind it stays full-bleed. */
  .viewcol {
    flex: 1;
    min-width: 0;
    width: 100%;
    max-width: var(--page-max);
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* ---------------------------------------------------------- info block */
  /* Campaign info, collapsed into the header area behind the Info toggle. */
  .infoblock {
    flex: none;
    margin: 0 32px;
    padding: 14px 18px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px 32px;
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

  /* ---------------------------------------------------------------- hero */
  .hero {
    flex: none;
    padding: 18px 32px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .hero-line {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .hero-line h1 {
    margin: 0;
    font-size: 26px;
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
  .infochip {
    font: 600 12.5px var(--font);
    color: var(--ink-soft);
    background: var(--bg-tint);
    border: 0;
    border-radius: 999px;
    padding: 5px 13px;
    cursor: pointer;
    flex: none;
  }
  .infochip:hover,
  .infochip.on {
    color: var(--accent);
  }
  .cspacer {
    flex: 1;
  }
  .managechip {
    font: 600 12.5px var(--font);
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
    border-radius: 999px;
    padding: 6px 14px;
    cursor: pointer;
    flex: none;
  }
  .managechip:hover:not(:disabled) {
    border-color: var(--owner);
  }
  .managechip:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .hero-stats {
    display: flex;
    gap: 14px;
    align-items: center;
    flex-wrap: wrap;
  }
  .hbar {
    flex: 1;
    max-width: 420px;
    height: 6px;
    border-radius: 3px;
    background: var(--track);
    overflow: hidden;
  }
  .hbar div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .hbarlabel {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .stat {
    font-size: 13px;
    color: var(--ink-soft);
  }
  .stat b.c-ok {
    color: var(--ok);
  }
  .stat b.c-info {
    color: var(--info);
  }
  .stat b.c-danger {
    color: var(--danger);
  }
  .sep {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .pillbtn {
    font-size: 13.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 9px 20px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
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
  .card.pre {
    border-left: 3px solid var(--pre);
  }
  .card.failtint {
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }
  .card-pre {
    font-size: 12px;
    font-weight: 600;
    color: var(--pre);
  }
  .donesum {
    background: color-mix(in srgb, var(--card) 60%, transparent);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 12.5px;
    color: var(--ink-faint);
    align-items: flex-start;
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
  /* ----------------------------------------------- manage takeover chrome */
  .crumbrow {
    flex: none;
    padding: 14px 32px 0;
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .backlink {
    font: 600 13px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    flex: none;
  }
  .backlink:hover {
    text-decoration: underline;
  }
  .bcsep {
    color: var(--line-input);
  }
  .crumbtitle {
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumbsub {
    font-size: 15px;
    color: var(--ink-faint);
    flex: none;
  }
  .ownerpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 700;
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
    border-radius: 999px;
    padding: 2px 10px;
  }
  .reapline {
    font-size: 12.5px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .reapbtn {
    flex: none;
    font: 600 12.5px var(--font);
    padding: 7px 14px;
    border-radius: 999px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink);
    cursor: pointer;
  }
  .reapbtn:hover:not(:disabled) {
    border-color: var(--info-line);
  }
  .reapbtn:disabled {
    opacity: 0.55;
    cursor: default;
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
  }
</style>
