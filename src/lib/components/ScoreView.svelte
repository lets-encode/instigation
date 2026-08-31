<!--
  The full-page score view: one piece's score takes over the campaign page,
  with the piece-scoped comments panel beside it. Comment anchors turn the
  score to their page and highlight their measures; selecting a measure in the
  score targets the composer, and a comment posted then carries that anchor.
  The view is addressed by the campaign page's ?score= parameter; the back
  link returns to the campaign.
-->
<script lang="ts">
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow, PieceRef } from "$lib/campaign-tables.ts";
  import { buildThreads } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import { writeSidePanel } from "$lib/side-panels.ts";
  import type { SidePanelState } from "$lib/side-panels.ts";
  import CommentsPanel from "./CommentsPanel.svelte";
  import PanelIcon from "./PanelIcon.svelte";
  import ScorePreview from "./ScorePreview.svelte";

  let {
    piece,
    zone,
    campaignTitle,
    owner,
    repo,
    startPage = 0,
    anchor = null,
    cards,
    comments,
    logins,
    viewer,
    canPush,
    runner,
    panel = $bindable(),
    oncomment,
    onresolve,
  }: {
    piece: PieceRef;
    /** The piece's colour slot, 1-based (--zone-N). */
    zone: number;
    campaignTitle: string;
    owner: string;
    repo: string;
    /** The page the score opens at, 0-based. */
    startPage?: number;
    /** A measure range to open highlighted (from a comment anchor). */
    anchor?: { page: number; m1: number; m2: number } | null;
    /** The piece's task cards, for the comments panel's sections. */
    cards: BoardCard[];
    comments: CommentRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    panel: SidePanelState;
    oncomment: (
      task: string,
      kind: string,
      body: string,
      parent_id: string,
      anchor?: { page: string; measure_start: string; measure_end: string },
    ) => Promise<void>;
    onresolve: (comment_id: string) => Promise<void>;
  } = $props();

  let preview = $state<ReturnType<typeof ScorePreview>>();
  // svelte-ignore state_referenced_locally -- an initial value by contract
  let shownAnchor = $state(anchor);

  // The measure selected in the score, and the page it sits on: the composer
  // targets that page's task and a posted comment carries the anchor.
  let selected = $state<{ label: string; page: number } | null>(null);
  function onmeasureselect(label: string | null) {
    selected =
      label === null
        ? null
        : { label, page: preview?.pageOfMeasure(label) ?? 0 };
  }
  const selectedTask = $derived(
    selected
      ? (cards.find((c) => c.locator === `surface-${selected!.page + 1}`)
          ?.task ?? null)
      : null,
  );
  const selectionAnchor = () =>
    selected
      ? {
          page: String(selected.page + 1),
          measure_start: selected.label,
          measure_end: selected.label,
        }
      : undefined;

  const commentCount = $derived(
    cards.reduce(
      (n, card) =>
        n +
        buildThreads(comments, card.task).reduce(
          (m, t) => m + 1 + t.replies.length,
          0,
        ),
      0,
    ),
  );

  function showAnchor(c: CommentRow) {
    const m1 = Number(c.measure_start);
    const m2 = Number(c.measure_end || c.measure_start);
    shownAnchor = {
      page: Number(c.page),
      m1: Number.isFinite(m1) ? m1 : 0,
      m2: Number.isFinite(m2) ? m2 : 0,
    };
    preview?.setZones(true);
    if (shownAnchor.page) preview?.showPage(shownAnchor.page - 1);
  }
</script>

<div class="scoreview">
  <div class="shead">
    <span class="sname">{piece.title || piece.id}</span>
    <span class="scamp">{campaignTitle}</span>
    <span class="sspacer"></span>
    {#if !panel.open}
      <button
        type="button"
        class="btn"
        title="Show the comments panel"
        onclick={() => {
          panel.open = true;
          writeSidePanel("comments", { ...panel });
        }}
      >
        <PanelIcon />
        Comments
        <span class="countpill">{commentCount}</span>
      </button>
    {/if}
  </div>
  <div class="srow">
    <div class="smain">
      <ScorePreview
        bind:this={preview}
        {owner}
        {repo}
        fragment={piece.path}
        {startPage}
        anchor={shownAnchor}
        {onmeasureselect}
      />
    </div>
    {#if panel.open}
      <CommentsPanel
        {piece}
        {zone}
        {cards}
        {comments}
        {logins}
        {viewer}
        {canPush}
        {runner}
        bind:panel
        targetTask={selectedTask}
        composerHint={selected ? "Comment on the selected measure…" : ""}
        inScore
        onanchor={showAnchor}
        oncomment={(task, kind, body, parent_id) =>
          oncomment(task, kind, body, parent_id, selectionAnchor())}
        {onresolve}
      />
    {/if}
  </div>
</div>

<style>
  .scoreview {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 18px 32px 8px;
  }
  .shead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .sname {
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .scamp {
    font-size: 12.5px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sspacer {
    flex: 1;
  }
  .countpill {
    font-size: 11px;
    font-weight: 600;
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
    border-radius: 999px;
    padding: 0 7px;
  }
  .srow {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
  }
  .smain {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
