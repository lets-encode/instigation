<!--
  The campaign page for viewers without push access: the viewer's next task
  with its action, the other open tasks as plain rows, and the pieces with
  their progress. Rows only navigate — clicking one opens the task panel,
  where the action lives. The board stays the instigator's view.
-->
<script lang="ts">
  import type { LockRow, PieceRef } from "$lib/campaign-tables.ts";
  import { cardPill } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import PieceCards from "./PieceCards.svelte";
  import TaskRunState from "./TaskRunState.svelte";

  let {
    cards,
    nextCard,
    locks,
    viewer,
    pieces,
    progress,
    pieceIndex,
    busy,
    onact,
    onopen,
    onviewscore,
  }: {
    /** Every board card, in column order. */
    cards: BoardCard[];
    /** The first card the viewer can act on, or null. */
    nextCard: BoardCard | null;
    locks: LockRow[];
    viewer: string;
    pieces: PieceRef[];
    /** Fragment path → tasks done / tasks total, for the piece tiles. */
    progress: Map<string, { done: number; total: number }>;
    /** Task id → index into `pieces`, for grouping and tinting by piece. */
    pieceIndex: Map<string, number>;
    busy: boolean;
    /** Perform the next card's action (claim, or open its detail). */
    onact: (card: BoardCard) => void;
    /** Open a task's panel. */
    onopen: (task: string) => void;
    /** Open the score preview on the piece at this index. */
    onviewscore: (index: number) => void;
  } = $props();

  const mine = (c: BoardCard) =>
    viewer !== "" &&
    locks.some((l) => l.task_id === c.task && l.user_id === viewer);
  /** Work the viewer holds, without the next-task card. */
  const myCards = $derived(
    cards.filter((c) => c.task !== nextCard?.task && mine(c)),
  );
  /** Tasks anyone could pick up: open ones, and validations with a free slot. */
  const openCards = $derived(
    cards.filter(
      (c) =>
        c.task !== nextCard?.task &&
        !mine(c) &&
        (c.column === "ready" ||
          (c.column === "validation" && c.slots.some((s) => s.key === "open"))),
    ),
  );
  const ROW_CAP = 5;
  let showAllOpen = $state(false);

  // With several pieces, the sections group their rows per piece, and each
  // piece tints its rows and its tile in one of the region editors' piece
  // colours — the same split the planned per-piece board tabs will make.
  const multiPiece = $derived(pieces.length > 1);
  const tintOf = (i: number) => `--piece-tint: var(--zone-${(i % 8) + 1})`;
  const byPiece = (list: BoardCard[]) =>
    pieces
      .map((piece, index) => ({
        piece,
        index,
        rows: list.filter((c) => (pieceIndex.get(c.task) ?? 0) === index),
      }))
      .filter((g) => g.rows.length > 0);

  const actLabel = (c: BoardCard): string => {
    if (c.column === "ready")
      return c.locator === "score-setup"
        ? "Claim & open setup editor"
        : c.pre
          ? "Claim & open zone editor"
          : "Claim & open editor ↗";
    if (c.column === "validation" && c.slots.some((s) => s.claimable))
      return "Claim to review";
    return "Open task";
  };

  const countChips = (c: BoardCard) =>
    c.counts.fails + c.counts.comments + c.counts.questions > 0;
</script>

{#snippet row(card: BoardCard)}
  <!-- A focusable div, not a <button>: the run state inside it can render a
       PR link, which HTML does not allow nested in a button. -->
  <div
    class="row"
    class:tinted={multiPiece}
    style={multiPiece ? tintOf(pieceIndex.get(card.task) ?? 0) : undefined}
    role="button"
    tabindex="0"
    onclick={() => onopen(card.task)}
    onkeydown={(e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onopen(card.task);
      }
    }}
    title="Open this task"
  >
    <span class="rowtitle"
      >{card.title} <span class="mono rowid">{card.task}</span></span
    >
    <span class="rowtype">{card.typeLine}</span>
    <TaskRunState task={card.task} />
    <span class="rspacer"></span>
    <span class="pill c-{card.column}">{cardPill(card, viewer)}</span>
    {#if countChips(card)}
      {#if card.counts.fails > 0}
        <span class="chip chip-fail"
          >{card.counts.fails} fail{card.counts.fails === 1 ? "" : "s"}</span
        >
      {/if}
      {#if card.counts.comments > 0}
        <span class="chip chip-note"
          >{card.counts.comments} comment{card.counts.comments === 1
            ? ""
            : "s"}</span
        >
      {/if}
      {#if card.counts.questions > 0}
        <span class="chip chip-question"
          >{card.counts.questions} question{card.counts.questions === 1
            ? ""
            : "s"}</span
        >
      {/if}
    {/if}
    <span class="chev">›</span>
  </div>
{/snippet}

<div class="volunteer">
  <div class="vcol">
    {#if nextCard}
      <div class="vsec">
        <span class="seclabel c-next">Your next task</span>
        <!-- A focusable div, not a <button>: the action button and the run
             state's PR link sit inside it. -->
        <div
          class="nextcard"
          role="button"
          tabindex="0"
          onclick={() => onopen(nextCard.task)}
          onkeydown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onopen(nextCard.task);
            }
          }}
          title="Open this task"
        >
          <div class="nextbody">
            <span class="nexttitle"
              >{nextCard.title}
              <span class="mono rowid">{nextCard.task}</span></span
            >
            <span class="rowtype">{nextCard.typeLine}</span>
            <TaskRunState task={nextCard.task} />
          </div>
          <span class="rspacer"></span>
          <button
            type="button"
            class="btn btn-lg btn-primary"
            onclick={(e) => {
              e.stopPropagation();
              onact(nextCard);
            }}
            disabled={busy}
            title="The first task that is open for you.">{actLabel(nextCard)}</button
          >
        </div>
      </div>
    {/if}

    {#if myCards.length > 0}
      <div class="vsec">
        <span class="seclabel">Your tasks <span class="seccount">{myCards.length}</span></span>
        {#if multiPiece}
          {#each byPiece(myCards) as g (g.piece.path)}
            <span class="grouplabel">{g.piece.title || g.piece.id}</span>
            {#each g.rows as card (card.task)}
              {@render row(card)}
            {/each}
          {/each}
        {:else}
          {#each myCards as card (card.task)}
            {@render row(card)}
          {/each}
        {/if}
      </div>
    {/if}

    <div class="vsec">
      <span class="seclabel"
        >{nextCard ? "Also open" : "Open tasks"}
        <span class="seccount">{openCards.length}</span></span
      >
      {#if multiPiece}
        {#each byPiece(showAllOpen ? openCards : openCards.slice(0, ROW_CAP)) as g (g.piece.path)}
          <span class="grouplabel">{g.piece.title || g.piece.id}</span>
          {#each g.rows as card (card.task)}
            {@render row(card)}
          {/each}
        {/each}
      {:else}
        {#each showAllOpen ? openCards : openCards.slice(0, ROW_CAP) as card (card.task)}
          {@render row(card)}
        {/each}
      {/if}
      {#if openCards.length > ROW_CAP}
        <button
          type="button"
          class="more"
          onclick={() => (showAllOpen = !showAllOpen)}
          >{showAllOpen
            ? "show fewer"
            : `+ ${openCards.length - ROW_CAP} more`}</button
        >
      {/if}
      {#if openCards.length === 0 && !nextCard && myCards.length === 0}
        <span class="none">No tasks are open for you right now.</span>
      {/if}
    </div>

    {#if pieces.length > 0}
      <div class="vsec">
        <span class="seclabel c-pieces">Pieces</span>
        <PieceCards {pieces} {progress} onview={onviewscore} />
      </div>
    {/if}
  </div>
</div>

<style>
  .volunteer {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    justify-content: center;
    padding: 0 32px;
  }
  .vcol {
    width: 100%;
    max-width: 860px;
    display: flex;
    flex-direction: column;
    gap: 22px;
    padding-bottom: 8px;
  }
  .vsec {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .seclabel {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .seclabel.c-next {
    color: var(--info);
  }
  .seclabel.c-pieces {
    color: var(--ok);
  }
  .seccount {
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 1px 7px;
    letter-spacing: 0;
  }

  .nextcard {
    display: flex;
    align-items: center;
    gap: 18px;
    background: var(--card);
    border: 1.5px solid var(--info-line);
    border-radius: 12px;
    padding: 18px 22px;
    box-shadow: var(--shadow-md);
    cursor: pointer;
  }
  .nextcard:hover {
    border-color: var(--accent);
  }
  .grouplabel {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    padding: 2px 4px 0;
  }
  .nextbody {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .nexttitle {
    font-size: 15px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .rspacer {
    flex: 1;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 16px;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
    font-family: inherit;
    text-align: left;
  }
  .row:hover {
    border-color: var(--accent);
  }
  .row.tinted {
    background: color-mix(in srgb, var(--piece-tint) 8%, var(--card));
  }
  .rowtitle {
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .rowid {
    font-size: 10px;
    opacity: 0.8;
    font-weight: 400;
    color: var(--ink-faint);
  }
  .rowtype {
    font-size: 11.5px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .chev {
    font-size: 15px;
    color: var(--ink-faint);
  }
  .none {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .more {
    align-self: flex-start;
    font: 600 11.5px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    padding: 2px 4px;
    cursor: pointer;
  }

  .pill {
    display: inline-flex;
    align-items: center;
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
  .chip {
    font-size: 11px;
    font-weight: 600;
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
</style>
