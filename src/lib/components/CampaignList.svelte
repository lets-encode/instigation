<!--
  The campaigns built from this template, as the forge reports them. Anonymous
  visitors see the public ones; signing in also surfaces the viewer's own
  private repositories.

  The listing is the repositories carrying the campaign topic, which the wizard
  stamps only once a setup is finished — so a repository whose setup was abandoned
  part-way is not listed here. Unfinished setups are offered for continuing by
  CampaignDrafts instead.
-->
<script lang="ts">
  import { auth } from "$lib/auth.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import { searchReposByTopic } from "$lib/forge/github-rest.ts";
  import type { RepoSummary } from "$lib/forge/types.ts";

  let repos = $state<RepoSummary[]>([]);
  let listError = $state<string | null>(null);

  $effect(() => {
    if (auth.status === "loading") return;
    searchReposByTopic(provider.repoTopic, auth.token ?? undefined)
      .then((found) => {
        repos = found;
        listError = null;
      })
      .catch((err) => {
        listError = (err as Error).message;
        repos = [];
      });
  });
</script>

<section class="repos">
  <h2>Campaigns</h2>

  {#if listError}
    <p class="muted">Couldn't load the list: {listError}</p>
  {:else if repos.length === 0}
    <p class="muted">None yet. Be the first to create one!</p>
  {:else}
    <ul>
      {#each repos as repo (repo.full_name)}
        <li>
          <div class="row">
            <a href={`/campaign/${repo.name}`}>{repo.full_name}</a>
            {#if repo.private}
              <span class="badge" title="Private — only visible to its owner">
                <svg
                  class="badge-lock"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect>
                  <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>
                </svg>
                Private
              </span>
            {/if}
            {#if auth.user}
              <a class="gh-link" href={repo.html_url} target="_blank" rel="noreferrer">
                View on GitHub →
              </a>
            {/if}
          </div>
          {#if repo.description}
            <p class="desc">{repo.description}</p>
          {/if}
        </li>
      {/each}
    </ul>
    {#if !auth.user}
      <p class="muted small">Log in to also see your own private repositories here.</p>
    {/if}
  {/if}
</section>

<style>
  .repos {
    max-width: 640px;
    margin: 0 auto 3rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--line);
  }
  h2 {
    font-size: 1.15rem;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .row a {
    font-weight: 600;
    text-decoration: none;
    color: var(--ink);
  }
  .row a:hover {
    text-decoration: underline;
  }
  .row a.gh-link {
    margin-left: auto;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--link);
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--warn);
    background: var(--bg-alt);
    border: 1px solid var(--line);
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
  }
  .badge-lock {
    width: 11px;
    height: 11px;
  }
  .desc {
    margin: 0.35rem 0 0;
    color: var(--ink-soft);
    font-size: 0.88rem;
  }
  .muted {
    color: var(--ink-faint);
  }
  .small {
    font-size: 0.85rem;
    margin-top: 1rem;
  }
</style>
