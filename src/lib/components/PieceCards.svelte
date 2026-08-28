<!--
  The campaign's pieces as tiles on a recessed surface: per-piece task
  progress and the "View score" entry into the score preview. The host passes
  the piece list, a fragment-path → progress map, and the open handler.
-->
<script lang="ts">
  import type { PieceRef } from "$lib/campaign-tables.ts";

  let {
    pieces,
    progress,
    onview,
  }: {
    pieces: PieceRef[];
    /** Fragment path → tasks done / tasks total for that piece. */
    progress: Map<string, { done: number; total: number }>;
    /** Open the score preview on the piece at this index. */
    onview: (index: number) => void;
  } = $props();

  const label = (p: PieceRef) => p.title || p.id;
</script>

<div class="pieces">
  {#each pieces as p, i (p.path)}
    {@const prog = progress.get(p.path) ?? { done: 0, total: 0 }}
    <!-- Each piece carries one of the region editors' piece colours as a
         tint, matching the tint on its task rows. -->
    <div class="piece" style={`--piece-tint: var(--zone-${(i % 8) + 1})`}>
      <div class="pbody">
        <span class="pname">{label(p)}</span>
        <div class="pbar">
          <div
            style={`width:${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%`}
          ></div>
        </div>
        <span class="pline">{prog.done} of {prog.total} tasks done</span>
      </div>
      <button
        type="button"
        class="btn"
        onclick={() => onview(i)}
        title="Show every page of this piece's score, without opening a task."
        >View score →</button
      >
    </div>
  {/each}
</div>

<style>
  .pieces {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 14px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    border-radius: 14px;
    padding: 12px;
  }
  .piece {
    display: flex;
    align-items: center;
    gap: 16px;
    background: color-mix(in srgb, var(--piece-tint) 10%, var(--card));
    border: 1px solid color-mix(in srgb, var(--piece-tint) 45%, var(--line));
    border-radius: 10px;
    padding: 14px 18px;
  }
  .pbody {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .pname {
    font-size: 14px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .pbar {
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--piece-tint) 22%, var(--card));
    overflow: hidden;
  }
  .pbar > div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .pline {
    font-size: 12px;
    color: var(--ink-faint);
  }
</style>
