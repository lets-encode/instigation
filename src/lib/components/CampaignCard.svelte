<!--
  One campaign in the main screen's grid. The whole card is the link to the
  campaign view. The viewer's own campaigns render in amber with a YOURS pill
  and a health chip; other campaigns show how many tasks are open to claim.
-->
<script lang="ts">
  import { elapsed } from "$lib/campaign-board.ts";
  import { attentionCount } from "$lib/campaign-stats.ts";
  import type { CampaignStats } from "$lib/campaign-stats.ts";

  let { stats, owned = false }: { stats: CampaignStats; owned?: boolean } =
    $props();

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
  const meta = $derived(
    [stats.composer, stats.pages ? `${stats.pages} pages` : ""]
      .filter(Boolean)
      .join(" · "),
  );
</script>

<a class="tile" class:owned href={`/${stats.name}`}>
  <div class="titleline">
    <span class="title">{stats.title}</span>
    {#if owned}
      <span class="yours">YOURS</span>
    {/if}
    {#if isNew}
      <span class="newbadge">NEW</span>
    {/if}
  </div>
  <div class="byline">
    {meta}{#if !owned}{meta ? " · " : ""}by <strong>{stats.owner}</strong>{/if}
  </div>
  <div class="progress">
    <div class="bar"><div style={`width:${pct}%`}></div></div>
    <span class="count">{stats.done}/{stats.total}</span>
  </div>
  <div class="foot">
    {#if owned && attention > 0}
      <span class="pill pill-amber"
        >{attention} need{attention === 1 ? "s" : ""} attention</span
      >
    {:else if owned}
      <span class="pill pill-green-on-amber">healthy</span>
    {:else if stats.ready > 0 && stats.nearlyDone}
      <span class="pill pill-green">{stats.ready} ready · nearly done</span>
    {:else if stats.ready > 0}
      <span class="pill pill-blue">{stats.ready} ready</span>
    {:else}
      <span class="pill pill-grey">no open tasks</span>
    {/if}
    <span class="when">{activity}</span>
  </div>
</a>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 13px 16px;
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.05);
    text-decoration: none;
    color: var(--ink);
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .tile:hover {
    border-color: var(--info-line);
    box-shadow: 0 4px 14px rgba(31, 36, 51, 0.08);
    text-decoration: none;
  }
  .tile.owned {
    background: var(--owner-bg);
    border-color: var(--owner-line);
  }
  .tile.owned:hover {
    border-color: var(--owner);
    box-shadow: 0 4px 14px rgba(224, 123, 57, 0.14);
  }
  .titleline {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .title {
    font-size: 15px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .yours {
    flex: none;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--owner);
    background: var(--card);
    border: 1px solid var(--owner-line);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .newbadge {
    flex: none;
    font-size: 10.5px;
    font-weight: 700;
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .byline {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .byline strong {
    font-weight: 600;
    color: var(--ink-soft);
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    overflow: hidden;
  }
  .owned .bar {
    background: var(--owner-track);
  }
  .bar div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .count {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink-soft);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: auto;
    min-width: 0;
  }
  .pill {
    flex: none;
    font-size: 11.5px;
    font-weight: 700;
    border-radius: 999px;
    padding: 2px 9px;
    white-space: nowrap;
  }
  .pill-blue {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .pill-green {
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .pill-grey {
    color: var(--ink-faint);
    background: var(--bg-tint);
    border: 1px solid var(--line);
  }
  .pill-amber {
    color: var(--owner);
    background: var(--card);
    border: 1px solid var(--owner-line);
  }
  .pill-green-on-amber {
    color: var(--ok);
    background: var(--card);
    border: 1px solid var(--owner-line);
  }
  .when {
    font-size: 11.5px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
