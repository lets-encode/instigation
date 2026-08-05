<!--
  The entry point to the app: the contributor dashboard — start card and the
  viewer's claimed work on the left, campaign discovery (search, filter chips,
  preview tiles) on the right — and the campaign onboarding wizard once a
  setup is underway.

  The wizard is one flow across several screens, driven by the step index in
  the wizard store rather than by the URL, so state survives moving between
  steps. Create on the landing hands the chosen name off to /c?slug=, which
  hooks.ts reroutes here; the name step reads that query and prefills.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { auth, forge, login } from "$lib/auth.svelte.ts";
  import { createForge } from "$lib/forge/index.ts";
  import { provider } from "$lib/forge/config.ts";
  import { draftSnapshot, saveDraft, wizard } from "$lib/wizard.svelte.ts";
  import { loadCampaignStats, myTasksIn } from "$lib/campaign-stats.ts";
  import type { CampaignStats, MyTask } from "$lib/campaign-stats.ts";
  import type { RepoSummary } from "$lib/forge/github-rest.ts";
  import LandingStart from "$lib/components/LandingStart.svelte";
  import YourWorkPanel from "$lib/components/YourWorkPanel.svelte";
  import CampaignCard from "$lib/components/CampaignCard.svelte";
  import CampaignNameStep from "$lib/components/CampaignNameStep.svelte";
  import CampaignLicenseStep from "$lib/components/CampaignLicenseStep.svelte";
  import CampaignUploadStep from "$lib/components/CampaignUploadStep.svelte";
  import CampaignPagesStep from "$lib/components/CampaignPagesStep.svelte";
  import CampaignSourceStep from "$lib/components/CampaignSourceStep.svelte";
  import CampaignPiecesStep from "$lib/components/CampaignPiecesStep.svelte";
  import CampaignDrafts from "$lib/components/CampaignDrafts.svelte";
  import WizardCard from "$lib/components/WizardCard.svelte";

  // The landing shows until a setup is underway: a name arriving via /c?slug=
  // (the wizard opens to take it), a held name, or a step past the first. A
  // continued draft re-opens past the first step, so it lands in the wizard.
  const landing = $derived(
    !page.url.searchParams.get("slug") &&
      wizard.step === "name" &&
      !wizard.claim,
  );

  // Mirror the wizard's entries into the browser as they change, so a setup
  // interrupted here can be continued from the listing above. The draft is
  // collected on every change but written on a debounce, since one write
  // serialises all of it; a page about to go away — a Back press, a closed tab —
  // writes what is pending first, so the last edits before it are kept.
  $effect(() => {
    const owner = auth.user?.login;
    const snapshot = draftSnapshot();
    if (!owner) return;
    const timer = setTimeout(() => saveDraft(owner, snapshot), 500);
    const flush = () => saveDraft(owner, snapshot);
    addEventListener("pagehide", flush);
    return () => {
      clearTimeout(timer);
      removeEventListener("pagehide", flush);
    };
  });

  // ------------------------------------------------------- campaign discovery
  const viewer = $derived(auth.user?.id != null ? String(auth.user.id) : "");
  const readForge = () => forge() ?? createForge("");

  let stats = $state<CampaignStats[]>([]);
  let listLoading = $state(false);
  let listError = $state<string | null>(null);
  let listLoaded = $state(false);

  $effect(() => {
    if (!landing || auth.status === "loading" || listLoaded || listLoading)
      return;
    listLoading = true;
    loadAll().finally(() => {
      listLoading = false;
      listLoaded = true;
    });
  });

  // Stats arrive one campaign at a time; each resolves into the grid as it
  // lands rather than waiting for the slowest repository.
  async function loadAll() {
    const f = readForge();
    let repos: RepoSummary[];
    try {
      repos = await f.searchReposByTopic(provider.repoTopic);
    } catch (err) {
      listError = (err as Error).message;
      return;
    }
    listError = null;
    await Promise.all(
      repos.map(async (repo) => {
        try {
          const s = await loadCampaignStats(f, repo, true);
          stats = [...stats.filter((x) => x.repoId !== s.repoId), s];
        } catch {
          // One unreadable repository doesn't take the listing down.
        }
      }),
    );
  }

  let search = $state("");
  let chip = $state<"open" | "nearly" | "new" | null>("open");
  const toggleChip = (c: typeof chip) => (chip = chip === c ? null : c);

  const isNew = (s: CampaignStats) =>
    s.createdAt !== "" &&
    Date.now() - Date.parse(s.createdAt) < 7 * 24 * 3600_000;
  const matchesSearch = (s: CampaignStats) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.title, s.composer].some((v) =>
      v.toLowerCase().includes(q),
    );
  };
  const openCount = $derived(stats.filter((s) => s.ready > 0).length);
  const filtered = $derived(
    stats
      .filter(matchesSearch)
      .filter((s) =>
        chip === "open"
          ? s.ready > 0
          : chip === "nearly"
            ? s.nearlyDone
            : chip === "new"
              ? isNew(s)
              : true,
      )
      .sort(
        (a, b) =>
          Date.parse(b.lastActivity || "0") - Date.parse(a.lastActivity || "0"),
      ),
  );
  const tiles = $derived(filtered.slice(0, 4));

  // ------------------------------------------------------- the viewer's work
  const myTasks = $derived(
    viewer ? stats.flatMap((s) => myTasksIn(s, viewer)) : ([] as MyTask[]),
  );
</script>

<!--
  Every step renders the full workbench shell itself; this route only decides
  which step is on screen.
-->
{#if landing}
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
        <div class="chips">
          <button
            type="button"
            class="fchip"
            class:on={chip === "open"}
            onclick={() => toggleChip("open")}
            >{chip === "open" ? "✓ " : ""}Has open tasks · {openCount}</button
          >
          <button
            type="button"
            class="fchip"
            class:on={chip === "nearly"}
            onclick={() => toggleChip("nearly")}
            >{chip === "nearly" ? "✓ " : ""}Nearly done</button
          >
          <button
            type="button"
            class="fchip"
            class:on={chip === "new"}
            onclick={() => toggleChip("new")}
            >{chip === "new" ? "✓ " : ""}New this week</button
          >
        </div>
      </div>
      {#if listError}
        <p class="note">Couldn't load the campaigns: {listError}</p>
      {:else if listLoaded && stats.length === 0}
        <p class="note">No campaigns yet. Be the first to create one!</p>
      {:else if listLoaded && filtered.length === 0}
        <p class="note">No campaign matches.</p>
      {:else}
        <div class="tiles">
          {#each tiles as s (s.repoId)}
            <CampaignCard stats={s} />
          {/each}
        </div>
        {#if listLoading && tiles.length === 0}
          <p class="note">Loading campaigns…</p>
        {/if}
      {/if}
      <div class="showmore">
        <span class="showing"
          >{Math.min(4, filtered.length)} of {stats.length} campaign{stats.length ===
          1
            ? ""
            : "s"}</span
        >
        <a class="morebtn" href="/campaigns">Show more</a>
      </div>
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
{:else if auth.status === "loading"}
  <p class="note checking">Checking your session…</p>
{:else if !auth.user}
  <WizardCard step="name" heading="Start a new encoding campaign">
    <p class="note login-note">
      Log in with GitHub to create a campaign. Its score, configuration and
      progress live in a repository on your account.
    </p>
    {#snippet footer()}
      <button type="button" class="btn btn-primary" onclick={() => login()}>
        Log in with GitHub
      </button>
    {/snippet}
  </WizardCard>
{:else if wizard.step === "name"}
  <CampaignNameStep />
{:else if wizard.step === "license"}
  <CampaignLicenseStep />
{:else if wizard.step === "upload"}
  <CampaignUploadStep />
{:else if wizard.step === "pages"}
  <CampaignPagesStep />
{:else if wizard.step === "source"}
  <CampaignSourceStep />
{:else}
  <CampaignPiecesStep />
{/if}

<style>
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
  .checking {
    padding: 2rem 1.5rem;
  }
  .login-note {
    margin-top: 16px;
    font-size: 13.5px;
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
  .chips {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
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
  .tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .showmore {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
  .showing {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .morebtn {
    font: 600 12.5px var(--font);
    padding: 6px 16px;
    border-radius: 999px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink-soft);
    text-decoration: none;
  }
  .morebtn:hover {
    border-color: var(--info-line);
    color: var(--accent);
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
