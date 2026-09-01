<!--
  The task panel's body: the task's status pill, the one action the viewer can
  take on it right now, the fails and own verdict controls, and the discussion
  thread. Commands run through callbacks the campaign page passes in; the
  shared CommandRunner carries the busy state and result. The score itself
  renders in the separate score panel (PreviewDock), which turns to a page
  when a comment is anchored here.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { LockRow, CommentRow } from "$lib/campaign-tables.ts";
  import type { FailComment } from "$lib/commands.ts";
  import { preTaskRoute } from "$lib/campaign-graph.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { buildRecord, cardPill } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import CommentComposer from "./CommentComposer.svelte";
  import TaskRunState from "./TaskRunState.svelte";
  import TaskDiscussion from "./TaskDiscussion.svelte";
  import ValidationRecord from "./ValidationRecord.svelte";

  let {
    card,
    campaign,
    comments,
    locks,
    logins,
    viewer,
    canPush,
    runner,
    resultBanner,
    currentPage,
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
    campaign: string;
    comments: CommentRow[];
    locks: LockRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    resultBanner: Snippet;
    /** The first page the preview shows right now, 0-based. */
    currentPage: () => number;
    /** Highlight a comment's measure range in the preview. */
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
  const encodePending = $derived(pendingVerdicts.isProcessing(`encode:${card.task}`));
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

  // The comment a discussion reply targets, shared by the thread list and the
  // composer.
  let replyTo = $state<CommentRow | null>(null);
</script>

<aside class="taskpanel" aria-label={`Task ${card.title}`}>
  {@render resultBanner()}
  <TaskRunState task={card.task} bar />
  <div class="thead">
    <div class="tline">
      <span
        class="pill c-{card.column}"
        title={card.column === "blocked"
          ? `Waits for ${card.waitsFor}.`
          : card.column === "done"
            ? card.doneLine
            : undefined}>{cardPill(card, viewer)}</span
      >
    </div>
    <!-- The one action the viewer can take on this task in its current state;
         a task the viewer cannot work on gets no buttons — the score preview
         is the way to look at it. -->
    {#if card.column === "ready"}
      <div class="tacts">
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
        <div class="tacts">
          <a
            class="btn btn-primary"
            href={editorRoute}
            title={`Continue your work in the ${editorName}.`}
            >Continue in {editorName}</a
          >
        </div>
      {:else if mineEncoding}
        <div class="tacts">
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
        <div class="tacts">
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
        <div class="tacts">
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
  <div class="rail-scroll">
    <ValidationRecord
      {card}
      {comments}
      {viewer}
      {logins}
      {canPush}
      {runner}
      variant="panel"
      prefill={() => ({ page: String(currentPage() + 1), m1: "", m2: "" })}
      {onshowanchor}
      {onclaim}
      {onvalidate}
      {onresolve}
      {onsendback}
    />
    <TaskDiscussion
      taskId={card.task}
      {comments}
      {viewer}
      {logins}
      {canPush}
      {runner}
      bind:replyTo
      {onresolve}
    />
  </div>
  <CommentComposer task={card.task} {logins} {runner} bind:replyTo {oncomment} />
</aside>

<style>
  /* --------------------------------------------------------------- layout */
  .taskpanel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .taskpanel :global(.banner) {
    border-radius: 0;
    box-shadow: none;
  }
  .thead {
    flex: none;
    padding: 12px 20px;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tline {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .tacts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
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
