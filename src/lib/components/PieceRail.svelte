<!--
  The instigator's piece rail: "All pieces" plus one bordered card per piece —
  the name with an unresolved-comment count, and its task counts per board
  category as labelled cells. Compact, the rail is a strip of dots, one per
  piece in its colour, with the name and counts in the dot's tooltip.
  Selecting a card or dot scopes the board to that piece.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import type { PieceRef } from "$lib/campaign-tables.ts";

  let {
    pieces,
    progress,
    counts,
    attention,
    openCount,
    selected,
    compact,
    onselect,
  }: {
    pieces: PieceRef[];
    /** Fragment path → tasks done / tasks total. */
    progress: Map<string, { done: number; total: number }>;
    /** Fragment path → not-done tasks per board category. */
    counts: Map<string, { open: number; encoding: number; validation: number }>;
    /** Fragment path → unresolved fails/comments/questions on its tasks. */
    attention: Map<string, number>;
    /** Tasks open to claim across the campaign, for the "All pieces" row. */
    openCount: number;
    /** The piece path the board is scoped to, or "all". */
    selected: "all" | string;
    /** Dots only; the page decides from the board row's width. */
    compact: boolean;
    onselect: (selected: "all" | string) => void;
  } = $props();

  const pieceName = (p: PieceRef) => p.title || p.id;
  const complete = (path: string) => {
    const p = progress.get(path);
    return !!p && p.total > 0 && p.done === p.total;
  };
  // The four board categories, in the board's column order.
  const cells = (path: string) => {
    const n = counts.get(path);
    return [
      { key: "open", label: "open", n: n?.open ?? 0 },
      { key: "encoding", label: "encoding", n: n?.encoding ?? 0 },
      { key: "validation", label: "review", n: n?.validation ?? 0 },
      { key: "done", label: "done", n: progress.get(path)?.done ?? 0 },
    ];
  };
  const tooltip = (piece: PieceRef) => {
    const parts = cells(piece.path).map((c) => `${c.n} ${c.label}`);
    const a = attention.get(piece.path) ?? 0;
    if (a > 0) parts.push(`${a} unresolved`);
    return `${pieceName(piece)} · ${parts.join(" · ")}`;
  };
</script>

<div class="rail" class:compact>
  <button
    type="button"
    class="railrow all"
    class:selected={selected === "all"}
    onclick={() => onselect("all")}
    title="All pieces · {openCount} open"
  >
    <span class="dot"></span>
    <span class="railname">All pieces</span>
    <span class="openpill">{openCount} open</span>
  </button>
  {#each pieces as piece, index (piece.path)}
    {@const count = attention.get(piece.path) ?? 0}
    <button
      type="button"
      class="railrow"
      class:selected={selected === piece.path}
      style="--zone: var(--zone-{(index % 8) + 1})"
      onclick={() => onselect(piece.path)}
      title={tooltip(piece)}
    >
      <span class="railtop">
        <span class="dot"></span>
        <span class="railname">{pieceName(piece)}</span>
        {#if count > 0}
          <span class="attn">
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><path
                d="M14 7.7c0 2.9-2.7 5.2-6 5.2-.8 0-1.6-.1-2.3-.4L2.5 13.7l.9-2.6C2.5 10.2 2 9 2 7.7 2 4.8 4.7 2.5 8 2.5s6 2.3 6 5.2z"
              /></svg
            >{count}</span
          >
        {:else if complete(piece.path)}
          <span class="alldone"><Icon name="check" size={11} /></span>
        {/if}
      </span>
      <span class="railgrid">
        {#each cells(piece.path) as cell (cell.key)}
          <span class="rc rc-{cell.key}" class:zero={cell.n === 0}
            ><b>{cell.n}</b> {cell.label}</span
          >
        {/each}
      </span>
    </button>
  {/each}
</div>

<style>
  .rail {
    flex: none;
    width: 168px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    border-radius: 12px;
    padding: 8px;
    align-self: flex-start;
    max-height: 100%;
    overflow-y: auto;
    box-sizing: border-box;
  }
  .railrow {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 9px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--card);
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    transition: border-color 0.15s ease;
  }
  .railrow.all {
    flex-direction: row;
    align-items: center;
    padding: 6px 9px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-soft);
  }
  .railrow:hover {
    border-color: var(--line-input);
  }
  .railrow.selected {
    border-color: var(--zone, var(--line-strong));
    box-shadow:
      0 0 0 1px var(--zone, var(--line-strong)),
      var(--shadow-sm);
  }
  .openpill {
    margin-left: auto;
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .railtop {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  /* The piece's tint, as on its board cards. */
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone);
  }
  .all .dot {
    display: none;
  }
  .railname {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .railrow.selected .railname {
    color: var(--ink);
  }
  /* Counts as "N label" cells in two columns, coloured like the board's
     column heads. */
  .railgrid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 3px 6px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }
  .rc b {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .rc-open {
    color: var(--ink-soft);
  }
  .rc-encoding {
    color: var(--info);
  }
  .rc-validation {
    color: var(--warn);
  }
  .rc-done {
    color: var(--ok);
  }
  .rc.zero {
    color: var(--ink-faint);
    opacity: 0.6;
  }
  .rc.zero b {
    font-weight: 500;
  }
  /* Unresolved fails, comments and questions, marked by the speech bubble. */
  .attn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    font-weight: 600;
    color: var(--danger);
  }
  .attn svg {
    flex: none;
  }
  .alldone {
    flex: none;
    display: inline-flex;
    color: var(--ok);
  }
  /* Compact: a strip of dots, one per piece in its colour, a ring for
     "All pieces", a red mark for unresolved comments. Names and counts are
     in the tooltips. */
  .rail.compact {
    width: auto;
    gap: 2px;
    padding: 5px;
  }
  .compact .railrow,
  .compact .railrow.all {
    position: relative;
    padding: 6px;
    border-color: transparent;
    background: none;
  }
  .compact .railrow:hover {
    background: var(--bg-tint);
  }
  .compact .railrow.selected {
    background: var(--card);
    border-color: var(--zone, var(--line-strong));
    box-shadow: none;
  }
  .compact .railname,
  .compact .openpill,
  .compact .railgrid,
  .compact .alldone,
  .compact .attn svg {
    display: none;
  }
  .compact .dot,
  .compact .all .dot {
    display: block;
    width: 14px;
    height: 14px;
  }
  .compact .all .dot {
    box-sizing: border-box;
    background: none;
    border: 3px solid var(--ink-soft);
  }
  .compact .attn {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger);
    font-size: 0;
  }
</style>
