<!--
  The in-page task panel: one continuous card — piece-tinted header, status
  line with the measure/page score link, submission, validation record and the
  action footer — with the task's discussion and composer below. Right-docked,
  resizable by its left drag handle; the width persists per browser
  (side-panels.ts). Commands run through callbacks the campaign page passes in.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { CommentRow, LockRow, StateRow } from "$lib/campaign-tables.ts";
  import type { FailComment } from "$lib/commands.ts";
  import { handle, preTaskRoute } from "$lib/campaign-graph.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import {
    buildRecord,
    buildThreads,
    cardPill,
    elapsed,
    initialOf,
  } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import { clampPanelWidth, writeSidePanel } from "$lib/side-panels.ts";
  import type { SidePanelState } from "$lib/side-panels.ts";
  import CommentCard from "./CommentCard.svelte";
  import CommentComposer from "./CommentComposer.svelte";
  import TaskRunState from "./TaskRunState.svelte";
  import ValidationRecord from "./ValidationRecord.svelte";

  let {
    card,
    pieceName,
    zone,
    campaign,
    comments,
    locks,
    rows,
    logins,
    viewer,
    canPush,
    runner,
    resultBanner,
    panel = $bindable(),
    onclose,
    onopenscore,
    onshowanchor,
    onclaim,
    oneditor,
    onsubmitencoding,
    onvalidate,
    oncomment,
    onresolve,
    onsendback,
  }: {
    card: BoardCard;
    /** The display name of the task's piece. */
    pieceName: string;
    /** The piece's colour slot, 1-based (--zone-N). */
    zone: number;
    campaign: string;
    comments: CommentRow[];
    locks: LockRow[];
    rows: StateRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    resultBanner: Snippet;
    panel: SidePanelState;
    onclose: () => void;
    /** Open the score at the task's pages. */
    onopenscore: () => void;
    /** Highlight a comment's measure range in the score. */
    onshowanchor: (c: CommentRow) => void;
    onclaim: (task_id: string, subtask_id: string) => Promise<void>;
    oneditor: (task_id: string) => Promise<void>;
    onsubmitencoding: (task_id: string) => Promise<void>;
    onvalidate: (
      task_id: string,
      subtask_id: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<void>;
    oncomment: (kind: string, body: string, parent_id: string) => Promise<void>;
    onresolve: (comment_id: string) => Promise<void>;
    onsendback: (task_id: string) => Promise<void>;
  } = $props();

  // The task's own one-shot submission, held while it is still processing.
  const encodePending = $derived(
    pendingVerdicts.isProcessing(`encode:${card.task}`),
  );
  const mineEncoding = $derived(
    viewer !== "" &&
      locks.some(
        (l) =>
          l.task_id === card.task &&
          l.subtask_id === "" &&
          l.kind === "encoding" &&
          l.user_id === viewer,
      ),
  );
  const record = $derived(buildRecord(card, comments, viewer, logins));
  /** The validation slot the viewer may claim right now, if any. */
  const claimableSub = $derived(
    record.find((r) => r.key === "open" && r.claimable)?.sub,
  );
  /** The viewer holds a review lock on this task. */
  const myReview = $derived(record.some((r) => r.mine));
  const claimPending = $derived(
    claimableSub !== undefined &&
      pendingVerdicts.isProcessing(`validate:${card.task}/${claimableSub}`),
  );
  const editorRoute = $derived(
    `/${campaign}/${preTaskRoute(card.locator)}/${card.task}`,
  );
  const editorName = $derived(
    card.locator === "score-setup" ? "setup editor" : "zone editor",
  );

  // The submitted encoding behind the card, for the Submission section.
  const taskState = $derived(findRow(rows, card.task, ""));
  const encoderLogin = $derived(
    taskState?.encoder ? handle(logins, taskState.encoder) : "",
  );

  // The task's page, linking the status line to the score and prefilling a
  // fail's anchor.
  const taskPage = $derived(/^surface-(\d+)$/.exec(card.locator)?.[1] ?? "");
  const scoreLink = $derived(taskPage ? `p. ${taskPage} →` : "score →");

  const threads = $derived(buildThreads(comments, card.task));
  const discussionCount = $derived(
    threads.reduce((n, t) => n + 1 + t.replies.length, 0),
  );
  const isReview = $derived(card.column === "validation");

  // The comment a discussion reply targets, shared by the thread list and the
  // composer.
  let replyTo = $state<CommentRow | null>(null);

  // Left-edge drag: the panel is right-docked, so dragging left widens it.
  let resizing = $state(false);
  let startX = 0;
  let startWidth = 0;

  function beginResize(e: PointerEvent) {
    // Keeps the drag from starting a text selection in the panel.
    e.preventDefault();
    resizing = true;
    startX = e.clientX;
    startWidth = panel.width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function moveResize(e: PointerEvent) {
    if (!resizing) return;
    panel.width = clampPanelWidth(startWidth + (startX - e.clientX), window.innerWidth);
  }
  function endResize() {
    if (!resizing) return;
    resizing = false;
    writeSidePanel("task", { ...panel });
  }
</script>

<div class="tspwrap" style="width: {panel.width}px">
  <div
    class="handle"
    class:active={resizing}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the task panel"
    onpointerdown={beginResize}
    onpointermove={moveResize}
    onpointerup={endResize}
    onpointercancel={endResize}
  ></div>
  <aside class="tsp" style="--zone: var(--zone-{zone})" aria-label={`Task ${card.title}`}>
    {@render resultBanner()}
    <div class="taskcard">
      <div class="tsphead">
        <span class="dot"></span>
        <span class="tsptitle">{card.title}</span>
        <span class="tspid">{card.task}</span>
        <button
          type="button"
          class="closebtn"
          title="Close the task panel"
          onclick={onclose}>✕</button
        >
      </div>
      <TaskRunState task={card.task} bar />
      <div class="statusrow">
        <span
          class="pill c-{card.column}"
          title={card.column === "blocked"
            ? `Waits for ${card.waitsFor}.`
            : card.column === "done"
              ? card.doneLine
              : undefined}>{cardPill(card, viewer)}</span
        >
        <span class="pieceline"
          >{pieceName} · <button
            type="button"
            class="scorelink"
            onclick={onopenscore}
            title="Open the score at this task's pages">{scoreLink}</button
          ></span
        >
      </div>
      {#if encoderLogin}
        <div class="section">
          <span class="seclbl">Submission</span>
          <div class="subline">
            <span class="avatar">{initialOf(encoderLogin)}</span>
            <span class="subtext"
              >encoded by <b>{encoderLogin}</b>{taskState?.encoded_at
                ? ` · ${elapsed(taskState.encoded_at)} ago`
                : ""}</span
            >
          </div>
        </div>
      {/if}
      {#if card.slots.length > 0}
        <div class="section">
          <ValidationRecord
            {card}
            {comments}
            {viewer}
            {logins}
            {canPush}
            {runner}
            variant="side"
            prefill={() => ({ page: taskPage, m1: "", m2: "" })}
            {onshowanchor}
            {onclaim}
            {onvalidate}
            {onresolve}
            {onsendback}
          />
        </div>
      {/if}
      <!-- The one action the viewer can take on this task in its current
           state; a task the viewer cannot work on gets no footer. -->
      {#if card.column === "ready"}
        <div class="tspfoot">
          {#if card.pre}
            <a
              class="btn btn-primary"
              href={editorRoute}
              title={`Claims the task for you and opens the ${editorName}.`}
              >Claim &amp; open {editorName}</a
            >
          {:else}
            <button
              type="button"
              class="btn btn-primary"
              onclick={() => oneditor(card.task)}
              disabled={runner.busy || !auth.user}
              title={auth.user
                ? "Claims the task for you, then opens the score in mei-friend."
                : "Log in to claim a task."}
              >Claim &amp; open editor ↗</button
            >
          {/if}
        </div>
      {:else if card.column === "encoding"}
        {#if card.pre && card.worker?.mine}
          <div class="tspfoot">
            <a
              class="btn btn-primary"
              href={editorRoute}
              title={`Continue your work in the ${editorName}.`}
              >Continue in {editorName}</a
            >
          </div>
        {:else if mineEncoding}
          <div class="tspfoot">
            <button
              type="button"
              class="btn btn-primary"
              onclick={() => onsubmitencoding(card.task)}
              disabled={runner.busy || encodePending}
              title="After committing your encoding in mei-friend, submit it for validation."
              >Submit for validation</button
            >
            <button
              type="button"
              class="btn btn-soft"
              onclick={() => oneditor(card.task)}
              disabled={runner.busy}
              title="Opens the score in mei-friend."
              >Open editor ↗</button
            >
          </div>
        {/if}
      {:else if card.column === "validation"}
        {#if claimableSub !== undefined}
          <div class="tspfoot">
            <button
              type="button"
              class="btn btn-primary"
              onclick={() => onclaim(card.task, claimableSub)}
              disabled={runner.busy || claimPending}
              title="Reserve this validation slot for review."
              >Claim to review</button
            >
            {#if !card.pre}
              <a
                class="btn btn-soft"
                href={`/${campaign}/review/${card.task}`}
                title="Open the full-screen review view: score and facsimile side by side, with the verdict controls."
                >Open review view</a
              >
            {/if}
          </div>
        {:else if myReview}
          <div class="tspfoot">
            {#if card.pre}
              <a
                class="btn btn-primary"
                href={editorRoute}
                title={`Review the submitted work in the ${editorName}.`}
                >Open {editorName}</a
              >
            {:else}
              <a
                class="btn btn-primary"
                href={`/${campaign}/review/${card.task}`}
                title="Open the full-screen review view: score and facsimile side by side, with the verdict controls."
                >Open review view</a
              >
            {/if}
          </div>
        {/if}
      {/if}
    </div>

    <div class="tspscroll">
    <span class="sechead" class:review={isReview}>
      <span class="secdot"></span>
      Discussion
      <span class="seccount">{discussionCount}</span>
    </span>
    {#each threads as t (t.root.comment_id)}
      <CommentCard
        comment={t.root}
        {logins}
        {viewer}
        {canPush}
        {runner}
        review={isReview}
        onanchor={onshowanchor}
        onreply={(c) => (replyTo = c)}
        {onresolve}
      />
      {#each t.replies as reply (reply.comment_id)}
        <CommentCard
          comment={reply}
          {logins}
          {viewer}
          {canPush}
          {runner}
          review={isReview}
          reply
          onanchor={onshowanchor}
          {onresolve}
        />
      {/each}
    {/each}
    {#if threads.length === 0}
      <span class="cnone">No discussion yet.</span>
    {/if}
    </div>
    <CommentComposer task={card.task} {logins} {runner} bind:replyTo {oncomment} />
  </aside>
</div>

<style>
  /* The panel runs the full row height; the task card stays pinned on top,
     the discussion scrolls and the composer stays pinned at the bottom. */
  .tspwrap {
    flex: none;
    display: flex;
    min-height: 0;
    align-self: stretch;
  }
  /* The host row's gap spaces the bar from the board; the right margin
     mirrors it towards the panel. */
  .handle {
    flex: none;
    align-self: stretch;
    margin: 12px 14px 12px 0;
    width: 6px;
    border-radius: 3px;
    background: var(--line-input);
    opacity: 0.65;
    cursor: col-resize;
    touch-action: none;
    position: relative;
  }
  .handle:hover,
  .handle.active {
    background: var(--accent);
    opacity: 0.8;
  }
  /* The embossed double line marking the bar as draggable. */
  .handle::before,
  .handle::after {
    content: "";
    position: absolute;
    top: 50%;
    width: 1px;
    height: 26px;
    transform: translateY(-50%);
    border-radius: 1px;
    background: var(--card);
  }
  .handle::before {
    left: 1.5px;
  }
  .handle::after {
    right: 1.5px;
  }
  .tsp {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    border-radius: 12px;
    padding: 12px;
  }
  .tspscroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tsp :global(.banner) {
    margin: 0;
  }

  /* Pinned above the discussion; past its share of the panel it scrolls on
     its own so the verdict controls stay in reach. */
  .taskcard {
    flex: none;
    max-height: 55%;
    background: var(--card);
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    overflow-y: auto;
    overflow-x: hidden;
    box-shadow: var(--shadow-sm);
  }
  .tsphead {
    display: flex;
    align-items: center;
    gap: 8px;
    background: color-mix(in srgb, var(--zone) 10%, var(--card));
    border-bottom: 1px solid color-mix(in srgb, var(--zone) 25%, var(--line));
    padding: 9px 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone);
    flex: none;
  }
  .tsptitle {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tspid {
    font: 400 10px ui-monospace, Menlo, monospace;
    color: var(--ink-faint);
    flex: none;
  }
  .closebtn {
    margin-left: auto;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    cursor: pointer;
    flex: none;
    padding: 0;
  }
  .statusrow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px;
  }
  .pieceline {
    font-size: 11.5px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .scorelink {
    font: 600 11.5px var(--font);
    color: var(--info);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .section {
    padding: 10px 12px;
    border-top: 1px solid var(--hairline, var(--line));
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .seclbl {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-soft);
  }
  .subline {
    display: flex;
    align-items: center;
    gap: 7px;
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
  .subtext {
    font-size: 11.5px;
    color: var(--ink-soft);
  }
  .subtext b {
    color: var(--ink);
  }
  .tspfoot {
    padding: 10px 12px;
    border-top: 1px solid var(--hairline, var(--line));
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .tspfoot .btn {
    flex: 1;
  }

  .sechead {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--info);
    padding: 4px 2px 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sechead.review {
    color: var(--warn);
  }
  .secdot {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: currentColor;
    flex: none;
  }
  .seccount {
    margin-left: auto;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    border-radius: 999px;
    padding: 1px 7px;
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
  }
  .cnone {
    font-size: 11.5px;
    color: var(--ink-faint);
    padding: 4px 2px;
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
  .pill.c-encoding {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .pill.c-validation {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .pill.c-done {
    background: var(--ok-bg);
    border-color: var(--ok-line);
    color: var(--ok);
  }
</style>
