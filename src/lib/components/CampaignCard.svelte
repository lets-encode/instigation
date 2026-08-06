<!--
  One campaign in the landing grid: a preview tile. The whole card links to
  the campaign console; the claim button carries a ?claim=next intent so the
  console claims the first open task on arrival.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { elapsed, initialOf } from "$lib/campaign-board.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import type { CampaignStats } from "$lib/campaign-stats.ts";

  let { stats }: { stats: CampaignStats } = $props();

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
  const handleOf = (id: string) => handle(stats.logins, id);
  // Avatar hues cycle through the brand-adjacent set the mocks use.
  const AVATAR_HUES = ["#3b76e0", "#e07b39", "#8f5fd0", "#1a9e6b"];

  // The card body links to the console while the claim button inside stays a
  // real link of its own — nested anchors are invalid HTML, so the card is a
  // scripted link instead.
  function open() {
    goto(`/${stats.name}`);
  }
</script>

<div
  class="tile"
  role="link"
  tabindex="0"
  onclick={open}
  onkeydown={(e) => {
    if (e.key === "Enter") open();
  }}
>
  <div class="strip">
    {#if stats.preview}
      <img src={stats.preview.url} alt="" loading="lazy" />
      <span class="strip-cap mono">facsimile · p. {stats.preview.page}</span>
    {:else}
      <span class="strip-cap mono">no preview yet</span>
    {/if}
  </div>
  <div class="body">
    <div class="titleline">
      <span class="title">{stats.title}</span>
      {#if isNew}
        <span class="newbadge">NEW</span>
      {/if}
      {#if stats.composer}
        <span class="composer">{stats.composer}</span>
      {/if}
    </div>
    <div class="byline">
      started by <strong>{stats.owner}</strong>{#if stats.pages}
        · {stats.pages} pages{/if}
    </div>
    <div class="progress">
      <div class="bar"><div style={`width:${pct}%`}></div></div>
      <span class="count">{stats.done} of {stats.total} tasks done</span>
    </div>
    <div class="foot">
      {#if stats.ready > 0 && stats.nearlyDone}
        <span class="pill pill-green">Nearly done · {stats.ready} to claim</span>
      {:else if stats.ready > 0}
        <span class="pill pill-blue">{stats.ready} ready to claim</span>
      {:else}
        <span class="pill pill-grey">no open tasks</span>
      {/if}
      {#if stats.contributorIds.length > 0}
        <span class="avatars">
          {#each stats.contributorIds.slice(0, 3) as id, i (id)}
            <span class="avatar" style={`background:${AVATAR_HUES[i % AVATAR_HUES.length]}`}
              title={handleOf(id)}>{initialOf(handleOf(id))}</span
            >
          {/each}
        </span>
      {/if}
      <span class="when">{activity}</span>
      <span class="spacer"></span>
      {#if stats.ready > 0}
        <a
          class="claim"
          href={`/${stats.name}?claim=next`}
          onclick={(e) => e.stopPropagation()}
          >Claim a task →</a
        >
      {:else}
        <span class="claim off">—</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .tile {
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.06);
    overflow: hidden;
    cursor: pointer;
    text-decoration: none;
    color: var(--ink);
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .tile:hover {
    border-color: var(--info-line);
    box-shadow: 0 6px 18px rgba(31, 36, 51, 0.1);
  }
  .strip {
    position: relative;
    height: 130px;
    flex: none;
    /* Paper-light only under an actual scan; the empty strip stays recessed. */
    background: var(--bg-inset);
    border-bottom: 1px solid var(--line);
    overflow: hidden;
  }
  .strip:has(img) {
    background: var(--facsimile-paper);
  }
  .strip img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top center;
    display: block;
  }
  .strip-cap {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    font-size: 11px;
    color: var(--ink-faint);
    background: color-mix(in srgb, var(--card) 85%, transparent);
    border-radius: 6px;
    padding: 3px 8px;
    white-space: nowrap;
  }
  .strip:has(img) .strip-cap {
    top: auto;
    bottom: 8px;
    transform: translateX(-50%);
  }
  .mono {
    font-family: ui-monospace, Menlo, monospace;
  }
  .body {
    padding: 14px 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
  }
  .titleline {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .title {
    font-size: 17px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .composer {
    font-size: 12.5px;
    color: var(--ink-soft);
    white-space: nowrap;
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
  .bar div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .count {
    font-size: 12px;
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
  .avatars {
    display: flex;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--card);
  }
  .avatar + .avatar {
    margin-left: -6px;
  }
  .when {
    font-size: 11.5px;
    color: var(--ink-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .claim {
    flex: none;
    font-size: 12.5px;
    font-weight: 600;
    padding: 6px 14px;
    border-radius: 999px;
    background: var(--accent-btn);
    color: #fff;
    text-decoration: none;
  }
  .claim:hover {
    background: var(--accent-btn-hover);
  }
  .claim.off {
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
    cursor: default;
  }
</style>
