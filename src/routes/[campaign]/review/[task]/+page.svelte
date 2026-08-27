<!--
  The review view: a full-screen surface for validating an encoding task. The
  score fills the window, facsimile and rendered encoding side by side, and a
  resizable rail on the right carries the validation record with the verdict
  controls and the task's discussion. Clicking a measure in either pane
  highlights it in both and prefills the fail form's anchor. Pre-tasks are
  reviewed in their own editors, not here.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { CommandRunner, readForge, viewerId } from "$lib/command-runner.svelte.ts";
  import { meiFriendUrl } from "$lib/forge/config.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result, FailComment } from "$lib/commands.ts";
  import { resolveCampaign } from "$lib/campaign-resolve.ts";
  import type { ResolvedCampaign } from "$lib/campaign-resolve.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type {
    TaskRow,
    StateRow,
    LockRow,
    HistoryRow,
    CommentRow,
  } from "$lib/campaign-tables.ts";
  import { preTaskRoute, statusPill } from "$lib/campaign-graph.ts";
  import { buildBoard } from "$lib/campaign-board.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { readDockLayout, writeDockLayout, DOCK_MIN } from "$lib/preview-dock.ts";
  import CommentComposer from "$lib/components/CommentComposer.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import ScorePreview from "$lib/components/ScorePreview.svelte";
  import TaskDiscussion from "$lib/components/TaskDiscussion.svelte";
  import ValidationRecord from "$lib/components/ValidationRecord.svelte";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);
  let resolved = $state<ResolvedCampaign | null>(null);
  let resolving = $state(false);
  let notFound = $state(false);
  const owner = $derived(resolved?.owner ?? "");
  const repo = $derived(resolved?.repo ?? "");
  const repoId = $derived(resolved?.repoId ?? 0);
  // The acting user's stable numeric id; login is display-only.
  const viewer = $derived(viewerId());

  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notInitialised = $state(false);
  let canPush = $state(false);
  let taskDefs = $state<TaskRow[]>([]);
  let rows = $state<StateRow[]>([]);
  let validationColumns = $state<string[]>([]);
  let locks = $state<LockRow[]>([]);
  let history = $state<HistoryRow[]>([]);
  let comments = $state<CommentRow[]>([]);
  let logins = $state<Record<string, string>>({});
  let passThreshold = $state(1);
  let allowSelfValidation = $state(false);

  const runner = new CommandRunner();

  const board = $derived(
    buildBoard(
      { taskDefs, rows, validationColumns, locks, passThreshold, allowSelfValidation },
      comments,
      history,
      viewer,
      logins,
    ),
  );
  const card = $derived(
    board.columns.flatMap((c) => c.cards).find((c) => c.task === taskId) ??
      null,
  );
  const taskDef = $derived(findRow(taskDefs, taskId, ""));
  const fragment = $derived(taskDef?.fragment ?? "");
  /** The page a per-page task opens at, 0-based. */
  const startPage = $derived.by(() => {
    const p = /^surface-(\d+)$/.exec(taskDef?.locator ?? "");
    return p ? Number(p[1]) - 1 : 0;
  });

  // The score viewer, bound for the anchor jump and the fail-form prefill.
  let preview = $state<ReturnType<typeof ScorePreview>>();
  // The measure selected in the viewer, reported back for the fail form.
  let selectedMeasure = $state<string | null>(null);
  // The measure range a fail comment refers to, highlighted in both panes.
  let anchor = $state<{ page: number; m1: number; m2: number } | null>(null);
  function showAnchorFor(c: CommentRow) {
    const m1 = Number(c.measure_start);
    const m2 = Number(c.measure_end || c.measure_start);
    anchor = {
      page: Number(c.page),
      m1: Number.isFinite(m1) ? m1 : 0,
      m2: Number.isFinite(m2) ? m2 : 0,
    };
    preview?.setZones(true);
    preview?.showPage(anchor.page - 1);
  }
  // A fresh fail form opens anchored to what the viewer is looking at.
  const prefill = () => ({
    page: String((preview?.currentPage() ?? 0) + 1),
    m1: selectedMeasure ?? "",
    m2: selectedMeasure ?? "",
  });

  // The comment a discussion reply targets, shared by the thread list and the
  // composer.
  let replyTo = $state<CommentRow | null>(null);

  // The rail's width, persisted per browser; dragging the grip resizes it.
  let railWidth = $state(readDockLayout("review").width);
  let resizing = $state(false);
  const clampWidth = (w: number) =>
    Math.round(
      Math.min(Math.max(DOCK_MIN, window.innerWidth - 480), Math.max(DOCK_MIN, w)),
    );
  function startResize(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizing = true;
  }
  function moveResize(e: PointerEvent) {
    if (!resizing) return;
    railWidth = clampWidth(window.innerWidth - e.clientX);
  }
  function endResize() {
    if (!resizing) return;
    resizing = false;
    writeDockLayout("review", {
      ...readDockLayout("review"),
      width: railWidth,
    });
  }

  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo }, { meiFriendUrl });

  // Read the tracking tables for the task's record, discussion and controls.
  // Only the first read shows the loading state; refreshes update in place.
  async function load() {
    const f = readForge();
    const name = campaign;
    if (!loaded) loading = true;
    loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, ctx(f));
      if (name !== campaign) return;
      notInitialised = tables.notInitialised;
      canPush = tables.canPush;
      taskDefs = tables.taskDefs;
      rows = tables.rows;
      validationColumns = tables.validationColumns;
      locks = tables.locks;
      history = tables.history;
      comments = tables.comments;
      logins = tables.logins;
      passThreshold = tables.passThreshold;
      allowSelfValidation = tables.allowSelfValidation;
      loaded = true;
    } catch (e) {
      if (name === campaign)
        loadError = `Could not read ${owner}/${repo}: ${(e as Error).message}`;
    } finally {
      if (name === campaign) loading = false;
    }
  }

  // A same-route navigation to another campaign or task starts over.
  $effect(() => {
    void campaign;
    void taskId;
    resolved = null;
    notFound = false;
    loaded = false;
    loadError = null;
    anchor = null;
    selectedMeasure = null;
  });

  $effect(() => {
    if (auth.status === "loading" || resolved || notFound || resolving) return;
    resolving = true;
    const name = campaign;
    resolveCampaign(readForge(), name)
      .catch(() => null)
      .then((r) => {
        if (name !== campaign) return;
        if (r) resolved = r;
        else notFound = true;
      })
      .finally(() => (resolving = false));
  });

  $effect(() => {
    if (auth.status !== "loading" && owner && repo && !loaded) load();
  });

  // Background verdicts refresh the tables when they land — unless a command
  // overlay is up, whose own after-refresh will catch the change.
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (!runner.busy && owner && repo) load();
    }),
  );

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(command: (c: CommandContext) => Promise<Result>) {
    const f = forge();
    if (!f) return;
    await runner.run(
      () => command(ctx(f)),
      async () => {
        runner.log.step("Refreshing tables…");
        await load();
      },
    );
  }

  const claim = (task_id: string, subtask_id: string) =>
    run((c) => invoke(commands.claimValidation, { task_id, subtask_id }, c));

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
          task_id: taskId,
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
</script>

{#if runner.busy}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
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
      <span>
        {runner.result.message}
        {#if runner.result.prUrl}
          <a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
      </span>
      <button type="button" class="dismiss" onclick={() => (runner.result = null)}
        >Dismiss</button
      >
    </div>
  {/if}
{/snippet}

<div class="review">
  {#if auth.status === "loading"}
    <p class="msg muted">Loading…</p>
  {:else if notFound}
    <div class="msg banner err">
      <span>
        No campaign called <code>{campaign}</code> was found.
        <a href="/campaigns">Back to all campaigns</a>.
      </span>
    </div>
  {:else if !resolved || loading}
    <p class="msg muted">Loading the task…</p>
  {:else if loadError}
    <div class="msg banner err"><span>{loadError}</span></div>
  {:else if notInitialised}
    <div class="msg banner err">
      <span>
        This repository has no tracking tables yet.
        <a href={`/${campaign}`}>Back to the campaign</a>.
      </span>
    </div>
  {:else if !card || !taskDef}
    <div class="msg banner err">
      <span>
        No task called <code>{taskId}</code> was found in this campaign.
        <a href={`/${campaign}`}>Back to the campaign</a>.
      </span>
    </div>
  {:else if card.pre}
    <div class="msg banner warn">
      <span>
        {card.title} is reviewed in its own editor.
        <a href={`/${campaign}/${preTaskRoute(card.locator)}/${card.task}`}
          >Open it</a
        >.
      </span>
    </div>
  {:else}
    <div class="scorecol">
      {#if !auth.user}
        <div class="banner warn">
          <span>
            Viewing read-only. <button
              type="button"
              class="linkish"
              onclick={() => login()}>Log in with GitHub</button
            >
            to review.
          </span>
        </div>
      {/if}
      {#if fragment}
        <ScorePreview
          bind:this={preview}
          {owner}
          {repo}
          {fragment}
          {startPage}
          {anchor}
          initialPane="both"
          onmeasureselect={(label) => (selectedMeasure = label)}
        />
      {:else}
        <p class="msg perr">No score file is recorded for {card.task}.</p>
      {/if}
    </div>
    <div
      class="grip"
      class:active={resizing}
      onpointerdown={startResize}
      onpointermove={moveResize}
      onpointerup={endResize}
      onpointercancel={endResize}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the review rail"
    ></div>
    <aside class="rail" style={`width:${railWidth}px`} aria-label={`Review ${card.title}`}>
      {@render resultBanner()}
      <div class="rhead">
        <span class="rtitle">{card.title}</span>
        <span class="taskchip"
          >{card.task}{taskDef.locator ? ` · ${taskDef.locator}` : ""}</span
        >
        <span class="pill s-{card.statusKey}">
          {card.statusKey === "validation_required"
            ? `validation · ${card.passes} of ${card.threshold} passes`
            : statusPill(card.statusKey, card.pre)}
        </span>
      </div>
      <div class="rail-scroll">
        <ValidationRecord
          {card}
          {comments}
          {viewer}
          {logins}
          {canPush}
          {runner}
          {prefill}
          onshowanchor={showAnchorFor}
          onclaim={claim}
          onvalidate={validate}
          onresolve={resolveCommentRow}
          onsendback={sendBackTask}
        />
        <TaskDiscussion
          taskId={card.task}
          {comments}
          {viewer}
          {logins}
          {canPush}
          {runner}
          bind:replyTo
          onresolve={resolveCommentRow}
        />
      </div>
      <CommentComposer {logins} {runner} bind:replyTo oncomment={postComment} />
    </aside>
  {/if}
</div>

<style>
  .muted {
    color: var(--ink-faint);
  }
  .linkish {
    font: inherit;
    font-size: inherit;
    font-weight: 600;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    cursor: pointer;
    text-decoration: underline;
  }
  .msg {
    margin: 24px auto;
    max-width: 640px;
  }
  .perr {
    padding: 14px;
    font-size: 12px;
    color: var(--danger);
  }

  /* The whole view: the score with the rail beside it, filling the window
     under the navigation bar. */
  .review {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--bg);
  }
  .scorecol {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* ------------------------------------------------------------------ rail */
  .rail {
    flex: 0 1 auto;
    min-width: 300px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--card);
    border-left: 1px solid var(--line);
  }
  .rail :global(.banner) {
    border-radius: 0;
  }
  .rhead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 12px 20px;
    border-bottom: 1px solid var(--line);
  }
  .rtitle {
    font-size: 14px;
    font-weight: 600;
  }
  .taskchip {
    font-size: 12px;
    font-family: ui-monospace, Menlo, monospace;
    background: var(--bg-tint);
    border-radius: 5px;
    padding: 2px 7px;
    white-space: nowrap;
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

  /* ------------------------------------------------------------------ grip */
  .grip {
    flex: none;
    width: 6px;
    cursor: col-resize;
    touch-action: none;
    position: relative;
  }
  .grip:hover,
  .grip.active {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  /* The embossed double line marking the handle as draggable. */
  .grip::before,
  .grip::after {
    content: "";
    position: absolute;
    border-radius: 1px;
    background: var(--line-strong);
    width: 1px;
    height: 40px;
    top: calc(50% - 20px);
    box-shadow: 1px 0 0 var(--card);
  }
  .grip::before {
    left: 1px;
  }
  .grip::after {
    left: 4px;
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
</style>
