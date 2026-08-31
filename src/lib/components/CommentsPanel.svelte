<!--
  The comments side panel: one piece's discussion, sectioned per task and
  colour-coded by the task's stage (encoding = info, validation = warn), with
  a pinned composer. Right-docked, resizable by its left drag handle; open
  state and width persist per browser (side-panels.ts). The host renders the
  button that reopens a closed panel.
-->
<script lang="ts">
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow, PieceRef } from "$lib/campaign-tables.ts";
  import { buildThreads } from "$lib/campaign-board.ts";
  import type { BoardCard, Thread } from "$lib/campaign-board.ts";
  import { clampPanelWidth, writeSidePanel } from "$lib/side-panels.ts";
  import type { SidePanelState } from "$lib/side-panels.ts";
  import CommentCard from "./CommentCard.svelte";
  import CommentComposer from "./CommentComposer.svelte";
  import PanelIcon from "./PanelIcon.svelte";

  let {
    piece,
    zone,
    cards,
    comments,
    logins,
    viewer,
    canPush,
    runner,
    panel = $bindable(),
    targetTask = null,
    composerHint = "",
    inScore = false,
    onanchor,
    oncomment,
    onresolve,
  }: {
    piece: PieceRef;
    /** The piece's colour slot, 1-based (--zone-N). */
    zone: number;
    /** The piece's task cards, in board order — the section source. */
    cards: BoardCard[];
    /** The whole comment log; the panel filters to its piece's tasks. */
    comments: CommentRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    panel: SidePanelState;
    /** The task a new top-level comment attaches to; null picks the piece's
        first not-done task. */
    targetTask?: string | null;
    /** Composer placeholder override (e.g. when a measure is selected). */
    composerHint?: string;
    /** Anchor links read as in-view highlights instead of score links. */
    inScore?: boolean;
    /** Show a comment's measure range in the score. */
    onanchor: (comment: CommentRow) => void;
    oncomment: (
      task: string,
      kind: string,
      body: string,
      parent_id: string,
    ) => Promise<void>;
    onresolve: (comment_id: string) => Promise<void>;
  } = $props();

  type Section = { card: BoardCard; threads: Thread[] };
  const sections = $derived(
    cards
      .map((card) => ({ card, threads: buildThreads(comments, card.task) }))
      .filter((s: Section) => s.threads.length > 0),
  );
  const count = $derived(
    sections.reduce(
      (n, s) => n + s.threads.reduce((m, t) => m + 1 + t.replies.length, 0),
      0,
    ),
  );

  const isReview = (card: BoardCard) => card.column === "validation";
  const sectionPill = (card: BoardCard) =>
    isReview(card) ? "review" : card.pre ? card.typeLine.toLowerCase() : "encoding";
  const sectionLabel = (card: BoardCard) => {
    const prefix = `${piece.title || piece.id} · `;
    const stripped = card.title.startsWith(prefix)
      ? card.title.slice(prefix.length)
      : card.title;
    return stripped || card.typeLine;
  };

  let replyTo = $state<CommentRow | null>(null);

  // A reply lands on its thread's task; a new comment on the host's target,
  // else the piece's first task still in progress.
  const composerTask = $derived(
    replyTo?.task_id ??
      targetTask ??
      (cards.find((c) => c.column !== "done") ?? cards[0])?.task,
  );

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
    writeSidePanel("comments", { ...panel });
  }

  function close() {
    panel.open = false;
    writeSidePanel("comments", { ...panel });
  }
</script>

{#if panel.open}
  <div class="cpwrap" style="width: {panel.width}px">
    <div
      class="handle"
      class:active={resizing}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the comments panel"
      onpointerdown={beginResize}
      onpointermove={moveResize}
      onpointerup={endResize}
      onpointercancel={endResize}
    ></div>
    <div class="cpanel" style="--zone: var(--zone-{zone})">
      <div class="scope">
        <span class="dot"></span>
        <span class="scopename">Comments · {piece.title || piece.id}</span>
        <span class="countpill">{count}</span>
        <button type="button" class="iconbtn" title="Hide the comments panel" onclick={close}>
          <PanelIcon />
        </button>
      </div>
      <div class="clist">
        {#each sections as s (s.card.task)}
          <div class="sechead" class:review={isReview(s.card)}>
            <span class="secdot"></span>
            {sectionLabel(s.card)}
            <span class="secpill">{sectionPill(s.card)}</span>
          </div>
          {#each s.threads as t (t.root.comment_id)}
            <CommentCard
              comment={t.root}
              {logins}
              {viewer}
              {canPush}
              {runner}
              review={isReview(s.card)}
              {inScore}
              {onanchor}
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
                review={isReview(s.card)}
                reply
                {inScore}
                {onanchor}
                {onresolve}
              />
            {/each}
          {/each}
        {/each}
        {#if sections.length === 0}
          <div class="cnone">No comments on this piece yet.</div>
        {/if}
      </div>
      {#if composerTask}
        <CommentComposer
          {logins}
          {runner}
          bind:replyTo
          variant="card"
          placeholder={composerHint ||
            `Ask a question about ${piece.title || piece.id}…`}
          oncomment={(kind, body, parent_id) =>
            oncomment(composerTask, kind, body, parent_id)}
        />
      {/if}
    </div>
  </div>
{/if}

<style>
  /* The panel runs the full row height; its list scrolls and the composer
     stays pinned at the bottom. */
  .cpwrap {
    flex: none;
    display: flex;
    min-height: 0;
    align-self: stretch;
  }
  /* The host row's gap spaces the bar from the content; the right margin
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
  .cpanel {
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
  .scope {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    background: color-mix(in srgb, var(--zone) 10%, var(--card));
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 8px;
    padding: 7px 10px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone);
    flex: none;
  }
  .scopename {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .countpill {
    margin-left: auto;
    font-size: 11px;
    font-weight: 600;
    background: var(--card);
    border-radius: 999px;
    padding: 1px 7px;
    color: var(--ink-soft);
  }
  .iconbtn {
    width: 24px;
    height: 24px;
    border-radius: 7px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex: none;
    padding: 0;
  }
  .clist {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sechead {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--info);
    padding: 6px 2px 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .secdot {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: var(--info);
    flex: none;
  }
  .secpill {
    margin-left: auto;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    border-radius: 999px;
    padding: 1px 7px;
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .sechead.review {
    color: var(--warn);
  }
  .sechead.review .secdot {
    background: var(--warn);
  }
  .sechead.review .secpill {
    color: var(--warn);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .cnone {
    font-size: 11.5px;
    color: var(--ink-faint);
    padding: 8px 2px;
  }
</style>
