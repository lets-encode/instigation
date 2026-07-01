<script lang="ts">
	import { goto } from '$app/navigation';
	import { auth, login, forge } from '$lib/auth.svelte.ts';
	import { provider } from '$lib/forge/config.ts';
	import { searchReposByTopic } from '$lib/forge/github-rest.ts';
	import type { RepoSummary } from '$lib/forge/types.ts';
	import {
		buildCampaignConfig,
		configToYaml,
		stampTemplate,
		buildStateCsv,
		buildLocksCsv
	} from '$lib/campaign-init.ts';

	const templateName = `${provider.template.owner}/${provider.template.repo}`;

	// The repository listing, fetched client-side (a logged-in token also surfaces
	// the user's private matches; anonymous sees public ones).
	let repos = $state<RepoSummary[]>([]);
	let listError = $state<string | null>(null);

	$effect(() => {
		if (auth.status === 'loading') return;
		const token = auth.token ?? undefined;
		searchReposByTopic(provider.repoTopic, token)
			.then((r) => {
				repos = r;
				listError = null;
			})
			.catch((e) => {
				listError = (e as Error).message;
				repos = [];
			});
	});

	// Create form state.
	let showForm = $state(false);
	let submitting = $state(false);
	let error = $state<string | null>(null);
	let created = $state<{ html_url: string; full_name: string; initWarning: boolean } | null>(null);

	let visibility = $state('public');
	let title = $state('');
	let handle = $state('');
	let handleTouched = $state(false);
	let description = $state('');
	let license = $state('CC-BY-4.0');
	let composer = $state('');

	$effect(() => {
		if (!handleTouched) handle = makeHandle(title);
	});

	// Generic words dropped when deriving a handle, so the distinctive words of a
	// title survive. Stop words, plus key/mode names common to many pieces.
	const STOP_WORDS = new Set([
		'the', 'a', 'an', 'of', 'in', 'for', 'and', 'or', 'to', 'from', 'on', 'by', 'at', 'with',
		'de', 'la', 'le', 'les', 'des', 'du', 'der', 'die', 'das', 'und', 'et', 'il', 'el'
	]);
	const MODE_WORDS = new Set(['major', 'minor', 'sharp', 'flat', 'dur', 'moll']);
	// Catalogue labels (e.g. "Op. 125", "BWV 1043"): the label and its number are
	// both dropped, since they don't help recognise the piece by name.
	const CATALOGUE_WITH_NUMBER = new Set(['op', 'opus', 'k', 'kv', 'bwv', 'woo', 'hob', 'rv', 'd', 's', 'l', 'wq']);
	// Labels whose following number names the piece (Symphony No. 9): drop the
	// label, keep the number.
	const CATALOGUE_KEEP_NUMBER = new Set(['no', 'nr', 'number']);

	// Derive a short, slug-safe handle from a piece title: lowercase and strip
	// diacritics, drop stop words and catalogue noise, then keep the first few
	// distinctive words. Falls back to the raw words if everything was dropped.
	function makeHandle(name: string): string {
		const tokens = name
			.replace(/[äÄ]/g, 'ae')
			.replace(/[öÖ]/g, 'oe')
			.replace(/[üÜ]/g, 'ue')
			.replace(/ß/g, 'ss')
			.normalize('NFKD')
			.replace(/\p{Diacritic}/gu, '')
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean);

		const kept: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (CATALOGUE_WITH_NUMBER.has(t)) {
				if (/^\d+$/.test(tokens[i + 1] ?? '')) i++; // drop the catalogue number too
				continue;
			}
			if (CATALOGUE_KEEP_NUMBER.has(t)) continue; // drop the label, keep its number
			if (STOP_WORDS.has(t) || MODE_WORDS.has(t)) continue;
			if (t.length === 1 && !/\d/.test(t)) continue; // lone letters (key names, initials)
			kept.push(t);
		}

		const words = (kept.length ? kept : tokens).slice(0, 4);
		return words.join('-').slice(0, 40).replace(/-+$/, '');
	}

	// Create the campaign repo and initialise it (Action A), entirely client-side
	// with the user's token: generate from the template, tag it, give its Actions a
	// write token, then commit the config, stamped score, and tracking tables.
	async function createCampaign(e: SubmitEvent) {
		e.preventDefault();
		error = null;
		created = null;
		const user = auth.user;
		const f = forge();
		if (!user || !f) return;

		const t = title.trim();
		const h = handle.trim();
		if (!t) return void (error = 'Campaign name is required.');
		if (!h) return void (error = 'A handle is required.');
		if (!/^[A-Za-z0-9_-]+$/.test(h)) {
			return void (error = 'The handle may only contain letters, numbers, hyphens and underscores.');
		}

		submitting = true;
		try {
			const repo = await f.createRepoFromTemplate({
				templateOwner: provider.template.owner,
				templateRepo: provider.template.repo,
				owner: user.login,
				name: h,
				description: description.trim(),
				isPrivate: visibility === 'private'
			});
			const owner = repo.owner.login;

			// Tag it so it shows up in the listing (non-fatal: repo already exists).
			try {
				await f.setRepoTopics(owner, repo.name, [provider.repoTopic]);
			} catch (err) {
				console.warn('Could not tag new repo with topic:', (err as Error).message);
			}
			// Give the campaign's Actions a read/write token (non-fatal for org limits).
			try {
				await f.setActionsWorkflowPermissions(owner, repo.name);
			} catch (err) {
				console.warn('Could not set Actions workflow permissions:', (err as Error).message);
			}

			// Initialise (Action A). The repo already exists, so on failure we surface
			// a retry hint rather than treating creation itself as failed.
			try {
				const template = await f.waitForRepoContents(owner, repo.name, 'templates/score.template.mei');
				const config = buildCampaignConfig(
					{ title: t, description: description.trim(), license: license.trim() || undefined, composer: composer.trim() },
					user.login
				);
				const mei = stampTemplate(template, {
					title: config.campaign.title,
					composer: config.sources[0].header.composer,
					license: config.campaign.license
				});
				await f.commitFiles(
					owner,
					repo.name,
					[
						{ path: 'config.yaml', content: configToYaml(config) },
						{ path: 'sources/score.mei', content: mei },
						{ path: 'tracking/state.csv', content: buildStateCsv(config) },
						{ path: 'tracking/locks.csv', content: buildLocksCsv() }
					],
					'Initialise campaign'
				);
			} catch (err) {
				console.error('Campaign initialisation failed:', (err as Error).message);
				created = { html_url: repo.html_url, full_name: repo.full_name, initWarning: true };
				submitting = false;
				return;
			}

			// Clean creation: take the organiser straight to the new repo's console.
			// Keep the overlay up through navigation rather than flashing it away.
			await goto(`/campaign/${owner}/${repo.name}`);
		} catch (err) {
			console.error('Repo creation failed:', (err as Error).message);
			error = 'Could not create the repository. Check the handle isn’t already taken, then try again.';
			submitting = false;
		}
	}
</script>

{#if submitting}
	<div class="overlay" role="status" aria-live="polite">
		<div class="overlay-card">
			<div class="spinner" aria-hidden="true"></div>
			<p class="overlay-title">Creating your repository…</p>
			<p class="overlay-sub">Setting up the campaign files. This takes a few seconds.</p>
		</div>
	</div>
{/if}

<section class="hero">
	<h1>Spin up a new repository from a template</h1>
	<p>Log in with GitHub, fill in your campaign details, and we'll create the repository and prepare it for encoding.</p>

	{#if auth.user}
		{#if !showForm}
			<button class="cta" type="button" onclick={() => (showForm = true)}>
				Create a new repository →
			</button>
		{/if}
	{:else}
		<button class="cta github" type="button" onclick={() => login()}>
			<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
			</svg>
			Log in with GitHub
		</button>
	{/if}
</section>

{#if auth.user && showForm}
	<section class="create">
		<h2>Create a repository</h2>
		<p class="template">From template: <code>{templateName}</code></p>

		{#if created}
			<div class="banner ok">
				Created <a href={created.html_url} target="_blank" rel="noreferrer">{created.full_name}</a> 🎉
			</div>
			{#if created.initWarning}
				<div class="banner warn">
					The repository was created, but setting up its campaign files didn't finish. Create it
					again to retry, or check the repository directly.
				</div>
			{/if}
		{:else if error}
			<div class="banner err">{error}</div>
		{/if}

		<form onsubmit={createCampaign}>
			<label>
				Campaign name
				<input bind:value={title} placeholder="e.g. Symphony No. 9 in D minor, Op. 125" required />
			</label>

			<label>
				Handle
				<input
					bind:value={handle}
					oninput={(e) => (handleTouched = e.currentTarget.value.trim() !== '')}
					placeholder="symphony-9-choral"
					required
				/>
				<span class="hint">Used in the URL and as the Git repository name. Auto-filled from the campaign name — edit it if you like.</span>
			</label>

			<details class="extra">
				<summary>Additional metadata</summary>
				<label>
					Composer <span class="muted">(optional)</span>
					<input bind:value={composer} placeholder="e.g. Anonymous" />
				</label>
			</details>

			<details class="extra">
				<summary>Advanced</summary>
				<label>
					Description <span class="muted">(optional)</span>
					<input bind:value={description} placeholder="What is this repo for?" />
				</label>

				<label>
					License
					<input bind:value={license} placeholder="e.g. CC-BY-4.0" />
				</label>

				<fieldset>
					<legend>Visibility (status)</legend>
					<label class="radio">
						<input type="radio" name="visibility" value="private" bind:group={visibility} />
						Private
					</label>
					<label class="radio">
						<input type="radio" name="visibility" value="public" bind:group={visibility} />
						Public
					</label>
				</fieldset>
			</details>

			<button type="submit" disabled={submitting}>
				{submitting ? 'Creating…' : 'Create repository'}
			</button>
		</form>
	</section>
{/if}

<section class="repos">
	<h2>Repositories created from this template</h2>

	{#if listError}
		<p class="muted">Couldn't load the list: {listError}</p>
	{:else if repos.length === 0}
		<p class="muted">None yet. Be the first to create one!</p>
	{:else}
		<ul>
			{#each repos as repo (repo.full_name)}
				<li>
					<div class="row">
						<a href={`/campaign/${repo.owner}/${repo.name}`}>{repo.full_name}</a>
						{#if repo.private}
							<span class="badge" title="Private — only visible to its owner">🔒 Private</span>
						{/if}
						{#if auth.user}
							<a class="gh-link" href={repo.html_url} target="_blank" rel="noreferrer">View on GitHub →</a>
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
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(255, 255, 255, 0.75);
		backdrop-filter: blur(2px);
	}
	.overlay-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.8rem;
		padding: 2rem 2.5rem;
		background: #fff;
		border: 1px solid #e5e5e5;
		border-radius: 12px;
		box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
		text-align: center;
	}
	.spinner {
		width: 38px;
		height: 38px;
		border: 3px solid #e5e5e5;
		border-top-color: #1a1a1a;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.overlay-title {
		margin: 0;
		font-weight: 600;
	}
	.overlay-sub {
		margin: 0;
		color: #777;
		font-size: 0.88rem;
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2s;
		}
	}

	.hero {
		text-align: center;
		padding-top: 2rem;
	}
	h1 {
		font-size: 1.9rem;
		margin-bottom: 0.5rem;
	}
	.hero p {
		color: #555;
		margin-bottom: 2rem;
	}
	.cta {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		text-decoration: none;
		font-weight: 600;
		padding: 0.7rem 1.2rem;
		border-radius: 8px;
		background: #1a1a1a;
		color: #fff;
	}
	.cta:hover {
		background: #000;
	}
	button.cta {
		border: none;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.create {
		margin-top: 3rem;
		border-top: 1px solid #e5e5e5;
		padding-top: 1.5rem;
	}
	.create .template {
		color: #555;
		margin-top: 0;
	}
	.create code {
		background: #eee;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
	}
	.create form {
		display: flex;
		flex-direction: column;
		gap: 1.1rem;
		margin-top: 1.5rem;
	}
	.create label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-weight: 600;
		font-size: 0.9rem;
	}
	.create input:not([type='radio']) {
		font: inherit;
		padding: 0.55rem 0.7rem;
		border: 1px solid #d0d0d0;
		border-radius: 6px;
	}
	.create fieldset {
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		display: flex;
		gap: 1.5rem;
		padding: 0.8rem 1rem;
	}
	.create legend {
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0 0.3rem;
	}
	.create .radio {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
		font-weight: 400;
	}
	.create button[type='submit'] {
		align-self: flex-start;
		font: inherit;
		font-weight: 600;
		padding: 0.6rem 1.1rem;
		border: none;
		border-radius: 8px;
		background: #1a1a1a;
		color: #fff;
		cursor: pointer;
	}
	.create button[disabled] {
		opacity: 0.6;
		cursor: default;
	}
	.create .muted {
		color: #999;
		font-weight: 400;
	}
	.create .hint {
		color: #888;
		font-weight: 400;
		font-size: 0.8rem;
	}
	.create .extra {
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 0 1rem;
	}
	.create .extra[open] {
		padding-bottom: 1rem;
	}
	.create .extra summary {
		cursor: pointer;
		font-weight: 600;
		font-size: 0.9rem;
		padding: 0.7rem 0;
	}
	.create .extra label {
		margin-top: 1rem;
	}
	.banner {
		padding: 0.7rem 1rem;
		border-radius: 8px;
		margin-bottom: 1rem;
	}
	.banner.ok {
		background: #e8f7ec;
		border: 1px solid #b6e2c1;
	}
	.banner.err {
		background: #fdeaea;
		border: 1px solid #f3c0c0;
	}
	.banner.warn {
		background: #fff8e1;
		border: 1px solid #f0dca0;
		color: #6a5300;
	}
	.repos {
		margin-top: 3.5rem;
		border-top: 1px solid #e5e5e5;
		padding-top: 1.5rem;
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
	li {
		border: 1px solid #e5e5e5;
		border-radius: 8px;
		padding: 0.8rem 1rem;
		background: #fff;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}
	.row a {
		font-weight: 600;
		text-decoration: none;
		color: #1a1a1a;
	}
	.row a:hover {
		text-decoration: underline;
	}
	.row a.gh-link {
		margin-left: auto;
		font-size: 0.8rem;
		font-weight: 600;
		color: #3056d3;
	}
	.badge {
		font-size: 0.72rem;
		font-weight: 600;
		color: #8a6d00;
		background: #fff4d6;
		border: 1px solid #f0dca0;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
	}
	.desc {
		margin: 0.35rem 0 0;
		color: #666;
		font-size: 0.88rem;
	}
	.muted {
		color: #888;
	}
	.small {
		font-size: 0.85rem;
		margin-top: 1rem;
	}
</style>
