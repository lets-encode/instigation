<!--
  The full-page score view: one piece's score takes over the campaign page,
  with the side panel beside it — the ?task= task when one is selected, else
  the campaign. Comment anchors on this piece turn the score to their page
  and highlight their measures; a comment posted while a measure is selected
  carries that measure. The view is addressed by the campaign page's ?score=
  parameter; the back link returns to the campaign.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { CommentAnchorInput, Result } from "$lib/commands.ts";
  import {
    commentAnchor,
    type MeasureAnchor,
    pieceLabel,
  } from "$lib/campaign-tables.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow, PieceRef } from "$lib/campaign-tables.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import type { SidePanelState } from "$lib/side-panels.ts";
  import ScorePreview from "./ScorePreview.svelte";
  import SidePanel from "./SidePanel.svelte";

  let {
    piece,
    campaignTitle,
    owner,
    repo,
    startPage = 0,
    anchor = null,
    card,
    cardOnPiece,
    cardSubtitle = "",
    cardZone = 0,
    taskBox,
    banner,
    comments,
    logins,
    viewer,
    canPush,
    runner,
    panel = $bindable(),
    ondeselect,
    onopenanchor,
    oncomment,
    onresolve,
  }: {
    piece: PieceRef;
    campaignTitle: string;
    owner: string;
    repo: string;
    /** The page the score opens at, 0-based. */
    startPage?: number;
    /** A measure range to open highlighted (from a comment anchor). */
    anchor?: MeasureAnchor | null;
    /** The selected task, or null for the campaign. */
    card: BoardCard | null;
    /** Whether the selected task is a task of this piece. */
    cardOnPiece: boolean;
    cardSubtitle?: string;
    cardZone?: number;
    /** The selected task's box. */
    taskBox?: Snippet;
    banner?: Snippet;
    comments: CommentRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    panel: SidePanelState;
    ondeselect: () => void;
    /** Show an anchor on another piece (the campaign page reopens the view). */
    onopenanchor: (comment: CommentRow) => void;
    oncomment: (
      task: string,
      kind: string,
      body: string,
      parent_id: string,
      anchor?: CommentAnchorInput,
    ) => Promise<Result | null>;
    onresolve: (comment_id: string) => Promise<unknown>;
  } = $props();

  let preview = $state<ReturnType<typeof ScorePreview>>();
  // svelte-ignore state_referenced_locally -- an initial value by contract
  let shownAnchor = $state(anchor);

  // The measure selected in the score, and the page it sits on: a comment
  // posted then carries it.
  let selected = $state<{ label: string; page: number } | null>(null);
  function onmeasureselect(label: string | null) {
    selected =
      label === null
        ? null
        : { label, page: preview?.pageOfMeasure(label) ?? 0 };
  }
  const task = $derived(card?.task ?? "");
  // A campaign comment names this piece with its anchor; a task comment
  // carries the anchor only when the task is on this piece.
  const selectionAnchor = (): CommentAnchorInput | undefined =>
    selected && (task === "" || cardOnPiece)
      ? {
          page: String(selected.page + 1),
          measure_start: selected.label,
          measure_end: selected.label,
          fragment: task === "" ? piece.path : "",
        }
      : undefined;

  /** Turn the open score to a page (0-based), highlighting `range` when
      given; the campaign page calls it for links into the score shown. */
  export function show(page: number | undefined, range: MeasureAnchor | null) {
    if (range) {
      shownAnchor = range;
      preview?.setZones(true);
    }
    if (page !== undefined) preview?.showPage(page);
  }

  const onThisPiece = (c: CommentRow) =>
    c.task_id === "" ? c.fragment === piece.path : cardOnPiece;
  function showAnchor(c: CommentRow) {
    if (!onThisPiece(c)) {
      onopenanchor(c);
      return;
    }
    shownAnchor = commentAnchor(c);
    preview?.setZones(true);
    if (shownAnchor.page) preview?.showPage(shownAnchor.page - 1);
  }
</script>

<div class="scoreview">
  <div class="shead">
    <span class="sname">{pieceLabel(piece)}</span>
    <span class="scamp">{campaignTitle}</span>
  </div>
  <div class="srow sidehost">
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
    <SidePanel
      {task}
      subtitle={card ? cardSubtitle : ""}
      zone={card ? cardZone : 0}
      review={card?.column === "validation"}
      {comments}
      {logins}
      {viewer}
      {canPush}
      {runner}
      bind:panel
      inScore
      emptyLine="Select a task on the board to show it here."
      composerHint={selectionAnchor() ? "Comment on the selected measure…" : ""}
      banner={card ? banner : undefined}
      taskBox={card ? taskBox : undefined}
      ondeselect={card ? ondeselect : undefined}
      onanchor={showAnchor}
      oncomment={(kind, body, parent_id) =>
        oncomment(task, kind, body, parent_id, selectionAnchor())}
      {onresolve}
    />
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
  /* Docked panel (DOCKED_QUERY in side-panels.ts): the panel spans the
     window's width under the score. */
  @media (orientation: portrait) and (max-width: 900px) {
    .scoreview {
      padding: 10px 0 0;
      gap: 8px;
    }
    .shead,
    .smain {
      padding: 0 12px;
    }
  }
</style>
