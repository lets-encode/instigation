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
    {#if index > 0}
      <span class="raildiv"></span>
    {/if}
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
        <span class="railbar">
          <span style={`width:${percent(piece.path)}%`}></span>
        </span>
        <span class="railmeta">
          {#if complete(piece.path)}
            <span class="rc rc-done">✓ all done</span>
          {:else}
            {#if n?.open}
              <b class="rc rc-open">{n.open} open</b>
            {/if}
            {#if n?.encoding}
              <b class="rc rc-encoding">{n.encoding} encoding</b>
            {/if}
            {#if n?.validation}
              <b class="rc rc-validation">{n.validation} review</b>
            {/if}
          {/if}
          {#if count > 0}
            <span class="attn" title="Unresolved fails, comments or questions">
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
          {/if}
        </span>
      </span>
    </button>
  {/each}
</div>

<style>
  .rail {
    flex: none;
    width: 288px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    border-radius: 12px;
    padding: 10px;
    align-self: flex-start;
    max-height: 100%;
    overflow-y: auto;
  }
  .railrow {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1.5px solid transparent;
    background: none;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    transition: border-color 0.15s ease;
  }
  .raildiv {
    flex: none;
    height: 1px;
    margin: 0 10px;
    background: var(--shade);
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
    width: 28px;
    height: 38px;
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
    gap: 5px;
  }
  .railname {
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
  .railmeta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
  }
  .railbar {
    display: block;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--zone) 22%, var(--card));
    overflow: hidden;
  }
  /* Not-done task counts as words, coloured like the board's column heads. */
  .rc {
    flex: none;
  }
  .rc + .rc::before {
    content: "·";
    color: var(--line-input);
    margin-right: 6px;
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
  .railbar > span {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  /* Unresolved fails, comments and questions, marked by the speech bubble. */
  .attn {
    flex: none;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--danger);
  }
  .attn svg {
    flex: none;
  }
</style>
