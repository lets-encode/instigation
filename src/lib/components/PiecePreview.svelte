<!--
  The whole-score preview: a modal card over the campaign view holding the
  score viewer, so a piece can be read end to end without opening one of the
  tasks it is split into. A campaign with several pieces picks between them in
  the header.
-->
<script lang="ts">
  import ScorePreview from "./ScorePreview.svelte";
  import type { PieceRef } from "$lib/campaign-tables.ts";

  let {
    owner,
    repo,
    campaignTitle,
    pieces,
    onclose,
  }: {
    owner: string;
    repo: string;
    campaignTitle: string;
    /** The pieces to offer, in campaign order; at least one. */
    pieces: PieceRef[];
    onclose: () => void;
  } = $props();

  let selected = $state(0);
  const piece = $derived(pieces[selected] ?? pieces[0]);
  const label = (p: PieceRef) => p.title || p.id;
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") onclose();
  }}
/>

<div class="overlay">
  <button class="scrim" aria-label="Close the score preview" onclick={onclose}
  ></button>
  <div class="popup" role="dialog" aria-modal="true" aria-label="Score preview">
    <div class="phead">
      <span class="ptitle">{campaignTitle}</span>
      <span class="psub">· score</span>
      {#if pieces.length > 1}
        <div class="pieceseg">
          {#each pieces as p, i (p.path)}
            <button
              type="button"
              class:on={i === selected}
              onclick={() => (selected = i)}>{label(p)}</button
            >
          {/each}
        </div>
      {:else if piece.title}
        <span class="psub">· {piece.title}</span>
      {/if}
      <span class="pspacer"></span>
      <button type="button" class="closebtn" onclick={onclose}>Close</button>
    </div>
    <ScorePreview {owner} {repo} fragment={piece.path} />
  </div>
</div>

<style>
  .overlay {
    /* Covers the view it opens over, leaving the app's header and footer
       reachable; the card takes that area bar a margin. */
    position: absolute;
    inset: 0;
    z-index: 55;
    display: flex;
    padding: 12px;
    box-sizing: border-box;
  }
  .scrim {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    cursor: pointer;
  }
  .popup {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 12px 44px var(--shade);
    overflow: hidden;
  }
  .phead {
    flex: none;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 18px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .ptitle {
    font-size: 15px;
    font-weight: 700;
  }
  .psub {
    font-size: 15px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pieceseg {
    display: flex;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 3px;
    gap: 2px;
    flex: none;
    overflow-x: auto;
  }
  .pieceseg button {
    font: 600 12px var(--font);
    padding: 4px 14px;
    border-radius: 999px;
    border: 0;
    background: none;
    color: var(--ink-faint);
    cursor: pointer;
    white-space: nowrap;
  }
  .pieceseg button.on {
    background: var(--card);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.1);
  }
  .pspacer {
    flex: 1;
  }
  .closebtn {
    font: 600 12.5px var(--font);
    padding: 7px 15px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
  }
  .closebtn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
