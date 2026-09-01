<!--
  One campaign in the overview listing: a full-width row of four zones —
  facsimile spine, title/byline/progress, incipit strip, and the suggested
  next task with its claim action. The row links to the campaign; only the
  claim button acts. The viewer's own campaigns render in amber.
-->
<script lang="ts">
  import { elapsed } from "$lib/campaign-board.ts";
  import { attentionCount, nextTask } from "$lib/campaign-stats.ts";
  import type { CampaignStats, NextTask } from "$lib/campaign-stats.ts";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import { piecePreview } from "$lib/piece-previews.ts";
  import type { PiecePreview } from "$lib/piece-previews.ts";

  let {
    stats,
    owned = false,
    viewer,
    busy,
    onact,
  }: {
    stats: CampaignStats;
    owned?: boolean;
    viewer: string;
    busy: boolean;
    /** Claim the row's next task (action 'encode' or 'review'). */
    onact: (stats: CampaignStats, next: NextTask) => void;
  } = $props();

  const next = $derived(nextTask(stats, viewer));

  const pct = $derived(
    stats.total ? Math.round((stats.done / stats.total) * 100) : 0,
  );
  const isNew = $derived(
    stats.createdAt !== "" &&
      Date.now() - Date.parse(stats.createdAt) < 7 * 24 * 3600_000,
  );
  const activity = $derived.by(() => {
    if (stats.lastActivity) {
      const e = elapsed(stats.lastActivity);
      return e === "now" ? "active just now" : `active ${e} ago`;
    }
    if (stats.createdAt) return `created ${elapsed(stats.createdAt)} ago`;
    return "no activity yet";
  });
  const attention = $derived(owned ? attentionCount(stats) : 0);
  const pieceCount = $derived(Object.keys(stats.pieceNames).length);
  const byline = $derived(
    [
      stats.composer,
      pieceCount ? `${pieceCount} piece${pieceCount === 1 ? "" : "s"}` : "",
      stats.pages ? `${stats.pages} pages` : "",
      owned ? "" : `by ${stats.owner}`,
      activity,
    ]
      .filter(Boolean)
      .join(" · "),
  );

  // The first piece's preview: spine thumbnail and incipit strip. Loaded when
  // the row mounts; the show-more paging keeps unmounted rows from loading.
  const piecePath = $derived(stats.taskDefs.find((t) => t.fragment)?.fragment);
  let preview = $state<PiecePreview | null>(null);
  $effect(() => {
    const path = piecePath;
    if (!path) return;
    piecePreview(readForge(), stats.owner, stats.repo, path).then((p) => {
      preview = p;
    });
  });

  const actLabel = (n: NextTask): string => {
    if (n.action === "review") return "Claim to review";
    return n.locator === "score-setup"
      ? "Claim & open setup editor"
      : n.pre
        ? "Claim & open zone editor"
        : "Claim & open editor ↗";
  };

</script>

<div class="shelfrow">
  <a class="rowlink" href={`/${stats.name}`}>
    <span class="spine">
      {#if preview?.thumb}
        <span class="paper"><img src={preview.thumb} alt="" loading="lazy" /></span>
      {:else}
        <span class="nopreview">no preview</span>
      {/if}
    </span>
    <span class="main">
      <span class="titleline">
        <span class="title">{stats.title}</span>
        {#if owned}
          <span class="pill yours">YOURS</span>
        {/if}
        {#if isNew}
          <span class="pill newbadge">NEW</span>
        {/if}
        {#if attention > 0}
          <span class="attn">{attention} need{attention === 1 ? "s" : ""} attention</span>
        {/if}
      </span>
      <span class="byline">{byline}</span>
      <span class="progress">
        <span class="bar"><span class="fill" style={`width:${pct}%`}></span></span>
        <span class="count">{stats.done}/{stats.total}</span>
      </span>
    </span>
    <span class="incipit">
      {#if preview?.incipit}
        <span class="incstrip">{@html preview.incipit}</span>
      {:else}
        <span class="incnote">
          {preview?.incipitPending ? "incipit appears after the preparation tasks" : "no preview"}
        </span>
      {/if}
    </span>
  </a>
  <div class="nextcol">
    {#if next}
      <span
        class="microlabel"
        class:k-validation={next.kind === "validation"}
        class:k-pre={next.pre}>Next task · {next.kind}</span
      >
      <span class="nexttitle">{next.title}</span>
      {#if next.action === "encode" || next.action === "review"}
        <button
          type="button"
          class="btn btn-primary"
          disabled={busy}
          onclick={() => onact(stats, next)}>{actLabel(next)}</button
        >
      {:else if next.action === "continue"}
        <a class="continue" href={`/${stats.name}?task=${encodeURIComponent(next.task)}`}
          >Continue →</a
        >
      {/if}
    {:else}
      <span class="microlabel">Next task</span>
      <span class="nonote"
        >{stats.total > 0 && stats.done === stats.total
          ? "campaign complete"
          : "no open tasks"}</span
      >
    {/if}
  </div>
</div>

<style>
  .shelfrow {
    display: flex;
    align-items: stretch;
    min-height: 120px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .shelfrow:hover {
    border-color: var(--info-line);
    box-shadow: var(--shadow-md);
  }
  .rowlink {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: stretch;
    color: var(--ink);
    text-decoration: none;
  }
  .spine {
    flex: none;
    width: 96px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--mat);
    border-right: 1px solid var(--line);
  }
  .paper {
    display: flex;
    width: 62px;
    height: 82px;
    background: var(--facsimile-paper);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .paper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top;
  }
  .nopreview {
    font-size: 11px;
    color: var(--ink-faint);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 7px;
    padding: 18px 26px;
  }
  .titleline {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title {
    font-size: 16px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pill {
    flex: none;
    font-size: 10.5px;
    font-weight: 600;
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .yours {
    color: var(--owner);
    background: var(--card);
    border: 1px solid var(--owner-line);
  }
  .newbadge {
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .attn {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--danger);
  }
  .byline {
    font-size: 12px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .bar {
    flex: 1;
    max-width: 460px;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .count {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-soft);
  }
  .incipit {
    flex: none;
    width: 300px;
    display: flex;
    align-items: center;
    padding: 18px 20px;
    border-left: 1px solid var(--line);
    box-sizing: border-box;
  }
  /* The incipit is engraved in black ink, so — like the facsimile thumbs —
     it always sits on paper, in both themes. */
  .incstrip {
    flex: 1;
    min-width: 0;
    height: 44px;
    display: flex;
    align-items: center;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 10px;
    overflow: hidden;
  }
  .incstrip :global(svg) {
    height: 100%;
    width: auto;
    max-width: 100%;
  }
  .incnote {
    font-size: 11px;
    color: var(--ink-faint);
  }
  .nextcol {
    flex: none;
    width: 320px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: 8px;
    padding: 18px 22px;
    border-left: 1px solid var(--line);
    background: var(--accent-tint);
    box-sizing: border-box;
  }
  /* The stage colours match the app's task coding: encoding blue,
     review/validation orange, preparation purple. */
  .microlabel {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--info);
  }
  .microlabel.k-validation {
    color: var(--warn);
  }
  .microlabel.k-pre {
    color: var(--pre);
  }
  .nexttitle {
    font-size: 12.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .continue {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--link);
    text-decoration: none;
  }
  .continue:hover {
    text-decoration: underline;
  }
  .nonote {
    font-size: 12px;
    color: var(--ink-faint);
  }
  @media (max-width: 1100px) {
    .incipit {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .nextcol {
      display: none;
    }
  }
</style>
