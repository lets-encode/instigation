<!--
  The task panel's body: the task's status and controls (claim, open in the
  editor, copy raw link, submit), the validation record and the discussion
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
  import { statusPill } from "$lib/campaign-graph.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import CommentComposer from "./CommentComposer.svelte";
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
    onrawlink,
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
    onrawlink: (task_id: string) => Promise<void>;
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
  // Opening the editor claims the task first when it is open to claim — the
  // button says so.
  const editorLabel = $derived(
    mineEncoding || card.column !== "ready"
      ? "Open editor ↗"
      : "Claim & open editor ↗",
  );

  // The comment a discussion reply targets, shared by the thread list and the
  // composer.
  let replyTo = $state<CommentRow | null>(null);
</script>

<aside class="taskpanel" aria-label={`Task ${card.title}`}>
  {@render resultBanner()}
  <div class="thead">
    <div class="tline">
      <span class="pill s-{card.statusKey}">
        {card.statusKey === "validation_required"
          ? `validation · ${card.passes} of ${card.threshold} passes`
          : statusPill(card.statusKey, card.pre)}
      </span>
      {#if card.counts.fails > 0}
        <span class="chip chip-fail"
          >{card.counts.fails} fail{card.counts.fails === 1 ? "" : "s"}</span
        >
      {/if}
    </div>
    <div class="tacts">
      <button
        type="button"
        class="mbtn"
        onclick={() => onrawlink(card.task)}
        disabled={runner.busy}
        title="Copy a direct link to the score file to paste into mei-friend manually."
        >Copy raw link</button
      >
      {#if card.locator === "score-setup"}
        <a
          class="mbtn blue"
          href={`/${campaign}/setup/${card.task}`}
          title="Open the score setup form: staves, clefs, key signature and meter."
          >Open setup editor</a
        >
      {:else if card.pre}
        <a
          class="mbtn blue"
          href={`/${campaign}/zones/${card.task}`}
          title="Open the measure zones on the facsimile."
          >Open zone editor</a
        >
      {:else if card.column === "ready" || card.column === "encoding"}
        <!-- Only while an encoding can land: a task in validation or done
             cannot accept a submission, so no editor hand-off is offered. -->
        <button
          type="button"
          class="mbtn blue"
          onclick={() => oneditor(card.task)}
          disabled={runner.busy || !auth.user}
          title={editorLabel === "Open editor ↗"
            ? "Opens the score in mei-friend."
            : "Claims the task for you, then opens the score in mei-friend."}
          >{editorLabel}</button
        >
      {:else if card.column === "validation"}
        <a
          class="mbtn blue"
          href={`/${campaign}/review/${card.task}`}
          title="Open the full-screen review view: score and facsimile side by side, with the verdict controls."
          >Open review view</a
        >
      {/if}
      {#if mineEncoding && !card.pre}
        <!-- A pre-task is submitted from its own editor. -->
        <button
          type="button"
          class="mbtn primary"
          onclick={() => onsubmitencoding(card.task)}
          disabled={runner.busy || encodePending}
          title="After committing your encoding in mei-friend, submit it for validation."
          >Submit for validation</button
        >
      {/if}
    </div>
  </div>
  <div class="rail-scroll">
    <ValidationRecord
      {card}
      {comments}
      {viewer}
      {logins}
      {canPush}
      {runner}
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
  <CommentComposer {logins} {runner} bind:replyTo {oncomment} />
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
  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 6px;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
