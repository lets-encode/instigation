<!--
  The instigator's piece rail: "All pieces" plus one row per piece — mini
  facsimile thumbnail, name, a thin progress bar in the piece's colour, and an
  attention count (or a check when complete) on the right. Selecting a row
  scopes the board to that piece.
-->
<script lang="ts">
  import { readForge } from "$lib/command-runner.svelte.ts";
  import type { PieceRef } from "$lib/campaign-tables.ts";
  import { piecePreview } from "$lib/piece-previews.ts";
  import type { PiecePreview } from "$lib/piece-previews.ts";

  let {
    pieces,
    owner,
    repo,
    progress,
    counts,
    attention,
    openCount,
    selected,
    onselect,
  }: {
    pieces: PieceRef[];
    owner: string;
    repo: string;
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
    onselect: (selected: "all" | string) => void;
  } = $props();

  const pieceName = (p: PieceRef) => p.title || p.id;
  const percent = (path: string) => {
    const p = progress.get(path);
    return p?.total ? Math.round((p.done / p.total) * 100) : 0;
  };
  const complete = (path: string) => {
    const p = progress.get(path);
    return !!p && p.total > 0 && p.done === p.total;
  };

  let previews = $state<Record<string, PiecePreview>>({});
  $effect(() => {
    const f = readForge();
    for (const piece of pieces) {
      const path = piece.path;
      if (previews[path]) continue;
      piecePreview(f, owner, repo, path).then((preview) => {
        previews[path] = preview;
      });
    }
  });
</script>

<div class="rail">
  <button
    type="button"
    class="railrow all"
    class:selected={selected === "all"}
    onclick={() => onselect("all")}
    title="Show every piece's tasks on the board"
  >
    All pieces
    <span class="openpill">{openCount} open</span>
  </button>
  {#each pieces as piece, index (piece.path)}
    {@const url = previews[piece.path]?.thumb}
    {@const count = attention.get(piece.path) ?? 0}
    {@const n = counts.get(piece.path)}
    <button
      type="button"
      class="railrow"
      class:selected={selected === piece.path}
      style="--zone: var(--zone-{(index % 8) + 1})"
      onclick={() => onselect(piece.path)}
      title="Scope the board to this piece"
    >
      <span class="paper">
        {#if url}<img src={url} alt="" loading="lazy" />{/if}
      </span>
      <span class="railbody">
        <span class="railname">{pieceName(piece)}</span>
        <span class="railmeta">
          <span class="railbar">
            <span style={`width:${percent(piece.path)}%`}></span>
          </span>
          {#if n?.open}
            <b class="rc rc-open" title="open">{n.open}</b>
          {/if}
          {#if n?.encoding}
            <b class="rc rc-encoding" title="encoding">{n.encoding}</b>
          {/if}
          {#if n?.validation}
            <b class="rc rc-validation" title="awaiting validation">{n.validation}</b>
          {/if}
        </span>
      </span>
      {#if count > 0}
        <span class="attnpill" title="Unresolved fails, comments or questions"
          >{count}</span
        >
      {:else if complete(piece.path)}
        <span class="railok" title="All tasks done">✓</span>
      {/if}
    </button>
  {/each}
</div>

<style>
  .rail {
    flex: none;
    width: 232px;
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
  }
  .railrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1.5px solid transparent;
    background: none;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    transition: border-color 0.15s ease;
  }
  .railrow.all {
    padding: 8px 10px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-soft);
  }
  .railrow:hover {
    border-color: var(--line-input);
  }
  .railrow.selected {
    background: var(--card);
    border-color: var(--zone, var(--line-strong));
    box-shadow: var(--shadow-sm);
  }
  .openpill {
    margin-left: auto;
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .paper {
    flex: none;
    width: 24px;
    height: 32px;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
  }
  .paper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .railbody {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .railname {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .railrow.selected .railname {
    color: var(--ink);
  }
  .railmeta {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .railbar {
    display: block;
    flex: 1;
    min-width: 0;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--zone) 22%, var(--card));
    overflow: hidden;
  }
  /* Not-done task counts, coloured like the board's column heads. */
  .rc {
    flex: none;
    font-size: 10px;
    font-weight: 600;
  }
  .rc-open {
    color: var(--ink-faint);
  }
  .rc-encoding {
    color: var(--info);
  }
  .rc-validation {
    color: var(--warn);
  }
  .railbar > span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .attnpill {
    flex: none;
    font-size: 10px;
    font-weight: 600;
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
    border-radius: 999px;
    padding: 1px 5px;
  }
  .railok {
    flex: none;
    font-size: 10.5px;
    font-weight: 600;
    color: var(--ok);
  }
</style>
