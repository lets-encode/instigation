<!--
  The score panel of the campaign view: the score viewer in a dock panel
  (DockPanel carries the docking and resizing). Without a task it shows a
  whole piece (a campaign with several pieces picks between them in the
  header); with a task it shows that task's score turned to the task's page.
  The task's own record and controls live in the separate task panel — this
  panel re-exports the viewer's paging so the campaign page can point it at
  an anchored comment.
-->
<script lang="ts">
  import { findRow } from "$lib/campaign-tables.ts";
  import type { TaskRow, PieceRef } from "$lib/campaign-tables.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import type { DockLayout } from "$lib/preview-dock.ts";
  import DockPanel from "./DockPanel.svelte";
  import ScorePreview from "./ScorePreview.svelte";

  let {
    layout = $bindable(),
    card,
    campaignTitle,
    owner,
    repo,
    taskDefs,
    pieces,
    anchor = null,
    onclose,
  }: {
    layout: DockLayout;
    /** The open task's card, or null when the panel just previews the score. */
    card: BoardCard | null;
    campaignTitle: string;
    owner: string;
    repo: string;
    taskDefs: TaskRow[];
    /** The pieces to offer when no task is open; may be empty. */
    pieces: PieceRef[];
    /** A measure range to highlight in both preview panes. */
    anchor?: { page: number; m1: number; m2: number } | null;
    onclose: () => void;
  } = $props();

  let selected = $state(0);
  const piece = $derived(pieces[selected] ?? pieces[0]);
  const pieceLabel = (p: PieceRef) => p.title || p.id;

  const taskDef = $derived(card ? findRow(taskDefs, card.task, "") : undefined);
  /** The score the panel shows: the task's, or the picked piece's. */
  const fragment = $derived(taskDef?.fragment ?? piece?.path ?? "");
  /** The page a per-page task opens at, 0-based. */
  const startPage = $derived.by(() => {
    const page = /^surface-(\d+)$/.exec(taskDef?.locator ?? "");
    return page ? Number(page[1]) - 1 : 0;
  });

  let preview = $state<ReturnType<typeof ScorePreview>>();

  /** Turn to a page (0-based) — see ScorePreview.showPage. */
  export function showPage(page: number) {
    preview?.showPage(page);
  }
  /** The first page the preview currently shows, 0-based. */
  export function currentPage(): number {
    return preview?.currentPage() ?? 0;
  }
  /** Show or hide the measure zones on the facsimile. */
  export function setZones(on: boolean) {
    preview?.setZones(on);
  }

  // Turning to another task turns the preview to its page (the score viewer
  // reloads by itself only when the task is on another score). The first run
  // only records the task the panel opened on — ScorePreview starts on its
  // page itself.
  let lastTask: string | null = null;
  $effect(() => {
    const task = card?.task ?? "";
    const page = startPage;
    if (task === lastTask) return;
    const first = lastTask === null;
    lastTask = task;
    if (first) return;
    if (task) preview?.showPage(page);
  });
</script>

<DockPanel bind:layout id="preview" label="Score preview panel" {onclose}>
  {#snippet header()}
    <span class="dtitle">{campaignTitle}</span>
    {#if card}
      <span class="dsub">· {card.task} · {card.title}</span>
    {:else}
      <span class="dsub">· score</span>
      {#if pieces.length > 1}
        <div class="seg pieceseg">
          {#each pieces as p, i (p.path)}
            <button
              type="button"
              class:on={i === selected}
              onclick={() => (selected = i)}>{pieceLabel(p)}</button
            >
          {/each}
        </div>
      {:else if piece?.title}
        <span class="dsub">· {piece.title}</span>
      {/if}
    {/if}
  {/snippet}
  {#if fragment}
    <ScorePreview
      bind:this={preview}
      {owner}
      {repo}
      {fragment}
      {startPage}
      {anchor}
    />
  {:else}
    <p class="perr">
      {card
        ? `No score file is recorded for ${card.task}.`
        : "This campaign has no score to preview."}
    </p>
  {/if}
</DockPanel>

<style>
  .dtitle {
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
  }
  .dsub {
    font-size: 14px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pieceseg {
    flex: none;
    overflow-x: auto;
  }
  .perr {
    margin: 0;
    padding: 14px;
    font-size: 12px;
    color: var(--danger);
  }
</style>
