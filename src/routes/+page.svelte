<!--
  The entry point to the app: the start card, unfinished setups and the
  viewer's claimed work on the left; every campaign on the right, in a
  paginated grid with search, sort and an open-tasks filter. Campaign creation
  lives at /new.
-->
<script lang="ts">
  import { auth, login } from "$lib/auth.svelte.ts";
  import { readForge, viewerId } from "$lib/command-runner.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import { loadAllCampaignStats, myTasksIn } from "$lib/campaign-stats.ts";
  import type { CampaignStats, MyTask } from "$lib/campaign-stats.ts";
  import LandingStart from "$lib/components/LandingStart.svelte";
  import YourWorkPanel from "$lib/components/YourWorkPanel.svelte";
  import CampaignCard from "$lib/components/CampaignCard.svelte";
  import CampaignDrafts from "$lib/components/CampaignDrafts.svelte";

  const PER_PAGE = 12;

  // ------------------------------------------------------- campaign discovery
  const viewer = $derived(viewerId());

  let stats = $state<CampaignStats[]>([]);
  let listLoading = $state(false);
  let listError = $state<string | null>(null);
  let listLoaded = $state(false);

  $effect(() => {
    if (auth.status === "loading" || listLoaded || listLoading) return;
    listLoading = true;
    loadAll().finally(() => {
      listLoading = false;
      listLoaded = true;
    });
  });

  // Stats arrive one campaign at a time; each resolves into the grid as it
  // lands rather than waiting for the slowest repository.
  async function loadAll() {
    try {
      await loadAllCampaignStats(readForge(), provider.repoTopic, {
        withPreview: true,
        onEach: (s) =>
          (stats = [...stats.filter((x) => x.repoId !== s.repoId), s]),
      });
      listError = null;
    } catch (err) {
      listError = (err as Error).message;
    }
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

  // ------------------------------------------------------- the viewer's work
  const myTasks = $derived(
    viewer ? stats.flatMap((s) => myTasksIn(s, viewer)) : ([] as MyTask[]),
  );
</script>

<div class="dash">
  <div class="rail">
    <LandingStart compact />
    {#if auth.user}
      <CampaignDrafts />
    {/if}
    {#if auth.user}
      <YourWorkPanel tasks={myTasks} loading={listLoading} />
    {/if}
  </div>
  <div class="main">
    <div class="finder">
      <div class="searchbox">
        <span class="glass">⌕</span>
        <input
          type="text"
          bind:value={search}
          placeholder="Search by work, composer, or campaign…"
          aria-label="Search campaigns"
        />
      </div>
      <div class="toolbar">
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
          >{openOnly ? "✓ " : ""}Has open tasks · {openCount}</button
        >
        <span class="showing">
          {#if filtered.length === 0}
            0 of {stats.length} campaign{stats.length === 1 ? "" : "s"}
          {:else}
            {(current - 1) * PER_PAGE + 1}–{Math.min(
              current * PER_PAGE,
              filtered.length,
            )} of {filtered.length} campaign{filtered.length === 1 ? "" : "s"}
          {/if}
        </span>
      </div>
    </div>
    {#if listError}
      <p class="note">Couldn't load the campaigns: {listError}</p>
    {:else if listLoaded && stats.length === 0}
      <p class="note">No campaigns yet. Be the first to create one!</p>
    {:else if listLoading && stats.length === 0}
      <p class="note">Loading campaigns…</p>
    {:else if shown.length === 0}
      <p class="note">No campaign matches.</p>
    {:else}
      <div class="tiles">
        {#each shown as s (s.repoId)}
          <CampaignCard stats={s} />
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
    {#if !auth.user && auth.status === "anonymous"}
      <p class="note login-hint">
        Browsing works logged out —
        <button type="button" class="linkish" onclick={() => login()}
          >log in with GitHub</button
        > to claim a task or see your work here.
      </p>
    {/if}
  </div>
</div>

<style>
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
  /* The dashboard scrolls as one surface, on the brand-tinted page gradient
     carried over from the old landing. */
  .dash {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    display: flex;
    align-items: flex-start;
    gap: 24px;
    padding: 24px 32px;
    box-sizing: border-box;
    background:
      radial-gradient(60% 90% at 15% 0%, rgba(109, 195, 255, 0.12), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, rgba(118, 222, 118, 0.12), transparent 60%),
      radial-gradient(50% 80% at 50% 100%, rgba(255, 167, 109, 0.1), transparent 60%),
      var(--bg-alt);
  }
  .rail {
    flex: none;
    width: 400px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .rail > :global(*) {
    max-width: none;
    margin: 0;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .finder {
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: center;
    padding-top: 4px;
  }
  .searchbox {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 680px;
    max-width: 100%;
    box-sizing: border-box;
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 999px;
    padding: 12px 22px;
    box-shadow: 0 4px 18px rgba(31, 36, 51, 0.08);
  }
  .searchbox:focus-within {
    border-color: var(--accent);
  }
  .glass {
    color: var(--ink-faint);
    font-size: 16px;
  }
  .searchbox input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    font: 400 14.5px var(--font);
    background: transparent;
    color: var(--ink);
  }
  .searchbox input::placeholder {
    color: var(--ink-faint);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
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
    padding: 5px 14px;
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
  .showing {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .pager {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
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
  .login-hint {
    text-align: center;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .linkish {
    font: inherit;
    font-weight: 600;
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .linkish:hover {
    text-decoration: underline;
  }
</style>
