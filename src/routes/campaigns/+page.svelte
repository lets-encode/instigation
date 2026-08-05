<!--
  All campaigns, densely: the dashboard's tile vocabulary without previews, in
  a paginated three-column grid with search, sort and an open-tasks filter.
  Reached from "Show more" on the dashboard. The name "campaigns" is reserved
  in the slug registry, so no campaign can shadow this route.
-->
<script lang="ts">
  import { auth, forge } from "$lib/auth.svelte.ts";
  import { createForge } from "$lib/forge/index.ts";
  import { provider } from "$lib/forge/config.ts";
  import { loadCampaignStats } from "$lib/campaign-stats.ts";
  import type { CampaignStats } from "$lib/campaign-stats.ts";
  import type { RepoSummary } from "$lib/forge/github-rest.ts";
  import CampaignCard from "$lib/components/CampaignCard.svelte";

  const PER_PAGE = 12;

  const readForge = () => forge() ?? createForge("");

  let stats = $state<CampaignStats[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (auth.status === "loading" || loaded || loading) return;
    loading = true;
    loadAll().finally(() => {
      loading = false;
      loaded = true;
    });
  });

  async function loadAll() {
    const f = readForge();
    let repos: RepoSummary[];
    try {
      repos = await f.searchReposByTopic(provider.repoTopic);
    } catch (err) {
      error = (err as Error).message;
      return;
    }
    error = null;
    await Promise.all(
      repos.map(async (repo) => {
        try {
          const s = await loadCampaignStats(f, repo);
          stats = [...stats.filter((x) => x.repoId !== s.repoId), s];
        } catch {
          // One unreadable repository doesn't take the listing down.
        }
      }),
    );
  }

  let search = $state("");
  let sort = $state<"active" | "newest" | "nearly">("active");
  let openOnly = $state(false);
  let pageNo = $state(1);
  // A changed filter starts over from page 1.
  $effect(() => {
    void search;
    void sort;
    void openOnly;
    pageNo = 1;
  });

  const matchesSearch = (s: CampaignStats) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.title, s.composer].some((v) =>
      v.toLowerCase().includes(q),
    );
  };
  const filtered = $derived.by(() => {
    const list = stats
      .filter(matchesSearch)
      .filter((s) => !openOnly || s.ready > 0);
    const ts = (v: string) => Date.parse(v || "0") || 0;
    if (sort === "newest")
      return list.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    if (sort === "nearly")
      return list.sort(
        (a, b) =>
          (b.total ? b.done / b.total : 0) - (a.total ? a.done / a.total : 0),
      );
    return list.sort((a, b) => ts(b.lastActivity) - ts(a.lastActivity));
  });
  const pages = $derived(Math.max(1, Math.ceil(filtered.length / PER_PAGE)));
  const current = $derived(Math.min(pageNo, pages));
  const shown = $derived(
    filtered.slice((current - 1) * PER_PAGE, current * PER_PAGE),
  );
  const openCount = $derived(stats.filter((s) => s.ready > 0).length);

  // The pagination row: 1 … around the current page … last.
  const pageButtons = $derived.by(() => {
    const out: Array<number | "…"> = [];
    for (let p = 1; p <= pages; p++) {
      if (p === 1 || p === pages || Math.abs(p - current) <= 1) out.push(p);
      else if (out.at(-1) !== "…") out.push("…");
    }
    return out;
  });
</script>

<div class="allwrap">
<div class="all">
  <div class="head">
    <a class="back" href="/">← Dashboard</a>
    <h1>All campaigns</h1>
    <span class="counts"
      >{stats.length} campaign{stats.length === 1 ? "" : "s"} · {openCount} with
      open tasks</span
    >
  </div>
  <div class="toolbar">
    <div class="searchbox">
      <span class="glass">⌕</span>
      <input
        type="text"
        bind:value={search}
        placeholder="Search by work, composer, or campaign…"
        aria-label="Search campaigns"
      />
    </div>
    <div class="seg">
      <button
        type="button"
        class:on={sort === "active"}
        onclick={() => (sort = "active")}>Most active</button
      >
      <button
        type="button"
        class:on={sort === "newest"}
        onclick={() => (sort = "newest")}>Newest</button
      >
      <button
        type="button"
        class:on={sort === "nearly"}
        onclick={() => (sort = "nearly")}>Nearly done</button
      >
    </div>
    <button
      type="button"
      class="fchip"
      class:on={openOnly}
      onclick={() => (openOnly = !openOnly)}
      >{openOnly ? "✓ " : ""}Has open tasks</button
    >
    <span class="spacer"></span>
    <span class="showing">
      {#if filtered.length === 0}
        Showing 0 of {stats.length}
      {:else}
        Showing {(current - 1) * PER_PAGE + 1}–{Math.min(
          current * PER_PAGE,
          filtered.length,
        )} of {filtered.length}
      {/if}
    </span>
  </div>
  {#if error}
    <p class="note">Couldn't load the campaigns: {error}</p>
  {:else if loaded && stats.length === 0}
    <p class="note">No campaigns yet. Be the first to create one!</p>
  {:else if loading && stats.length === 0}
    <p class="note">Loading campaigns…</p>
  {:else if shown.length === 0}
    <p class="note">No campaign matches.</p>
  {:else}
    <div class="grid">
      {#each shown as s (s.repoId)}
        <CampaignCard stats={s} dense />
      {/each}
    </div>
  {/if}
  {#if pages > 1}
    <div class="pager">
      <button
        type="button"
        class="pbtn"
        disabled={current === 1}
        onclick={() => (pageNo = current - 1)}
        aria-label="Previous page">‹</button
      >
      {#each pageButtons as p, i (i)}
        {#if p === "…"}
          <span class="ellipsis">…</span>
        {:else}
          <button
            type="button"
            class="pbtn"
            class:on={p === current}
            onclick={() => (pageNo = p)}>{p}</button
          >
        {/if}
      {/each}
      <button
        type="button"
        class="pbtn"
        disabled={current === pages}
        onclick={() => (pageNo = current + 1)}
        aria-label="Next page">›</button
      >
    </div>
  {/if}
</div>
</div>

<style>
  /* Full-bleed brand-tinted backdrop; the content column centres inside it. */
  .allwrap {
    min-height: 100%;
    box-sizing: border-box;
    padding: 22px 32px 18px;
    background:
      radial-gradient(60% 90% at 15% 0%, rgba(109, 195, 255, 0.12), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, rgba(118, 222, 118, 0.12), transparent 60%),
      radial-gradient(50% 80% at 50% 100%, rgba(255, 167, 109, 0.1), transparent 60%);
  }
  .all {
    max-width: 1180px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    padding-top: 0.25rem;
  }
  .back {
    font-size: 13px;
    font-weight: 600;
    color: var(--link);
    text-decoration: none;
  }
  .back:hover {
    text-decoration: underline;
  }
  h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
  }
  .counts {
    font-size: 13px;
    color: var(--ink-faint);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
    flex-wrap: wrap;
  }
  .searchbox {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 340px;
    box-sizing: border-box;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 8px 16px;
  }
  .searchbox:focus-within {
    border-color: var(--accent);
  }
  .glass {
    color: var(--ink-faint);
    font-size: 14px;
  }
  .searchbox input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    font: 400 13px var(--font);
    background: transparent;
    color: var(--ink);
  }
  .searchbox input::placeholder {
    color: var(--ink-faint);
  }
  .seg {
    display: flex;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 3px;
  }
  .seg button {
    font: 600 12.5px var(--font);
    padding: 5px 14px;
    border-radius: 999px;
    border: 0;
    background: none;
    color: var(--ink-faint);
    cursor: pointer;
  }
  .seg button.on {
    background: var(--card);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.1);
  }
  .fchip {
    font: 600 12.5px var(--font);
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 6px 14px;
    cursor: pointer;
  }
  .fchip:hover {
    border-color: var(--info-line);
    color: var(--accent);
  }
  .fchip.on {
    color: var(--info);
    background: var(--info-bg);
    border-color: var(--info-line);
  }
  .spacer {
    flex: 1;
  }
  .showing {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .grid {
    margin-top: 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-auto-rows: min-content;
    align-content: start;
    gap: 12px;
  }
  @media (max-width: 1000px) {
    .grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .note {
    margin: 1.5rem 0 0;
    color: var(--ink-soft);
  }
  .pager {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 14px 0 4px;
  }
  .pbtn {
    font: 600 12.5px var(--font);
    width: 30px;
    height: 30px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
  }
  .pbtn:hover:not(:disabled):not(.on) {
    border-color: var(--info-line);
    color: var(--accent);
  }
  .pbtn.on {
    border: 0;
    background: var(--accent-btn);
    color: #fff;
  }
  .pbtn:disabled {
    color: var(--ink-faint);
    cursor: default;
  }
  .ellipsis {
    font-size: 12.5px;
    color: var(--ink-faint);
    padding: 0 4px;
  }
</style>
