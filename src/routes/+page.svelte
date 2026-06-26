<script>
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	// Open the create form once a submission has come back (success or error).
	let showForm = $state(Boolean(form));
	let submitting = $state(false);

	let visibility = $state(form ? (form.isPrivate === false ? 'public' : 'private') : 'public');
</script>

<section class="hero">
	<h1>Spin up a new repository from a template</h1>
	<p>Log in with GitHub, fill in your campaign details, and we'll create the repository and prepare it for encoding.</p>

	{#if data.user}
		{#if !showForm}
			<button class="cta" type="button" onclick={() => (showForm = true)}>
				Create a new repository →
			</button>
		{/if}
	{:else}
		{#if data.denied === 'login'}
			<div class="banner warn">
				Login cancelled — access was declined on GitHub. We need you to authorize the app to
				continue. Try again below.
			</div>
		{/if}
		<a class="cta github" href="/login">
			<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="currentColor">
				<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
			</svg>
			Log in with GitHub
		</a>
	{/if}
</section>

{#if data.user && showForm}
	<section class="create">
		<h2>Create a repository</h2>
		<p class="template">From template: <code>{data.template}</code></p>

		{#if form?.success}
			<div class="banner ok">
				Created <a href={form.html_url} target="_blank" rel="noreferrer">{form.full_name}</a> 🎉
			</div>
			{#if form.initWarning}
				<div class="banner warn">
					The repository was created, but setting up its campaign files didn't finish. Create it
					again to retry, or check the repository directly.
				</div>
			{/if}
		{:else if form?.error}
			<div class="banner err">{form.error}</div>
		{/if}

		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}
		>
			<label>
				Repository name
				<input name="name" value={form?.name ?? ''} placeholder="my-new-project" required />
			</label>

			<label>
				Campaign title
				<input name="title" value={form?.title ?? ''} placeholder="Title shown on the score and platform" required />
			</label>

			<label>
				Description <span class="muted">(optional)</span>
				<input name="description" value={form?.description ?? ''} placeholder="What is this repo for?" />
			</label>

			<label>
				License
				<input name="license" value={form?.license ?? 'CC-BY-4.0'} placeholder="e.g. CC-BY-4.0" />
			</label>

			<label>
				Composer <span class="muted">(optional)</span>
				<input name="composer" value={form?.composer ?? ''} placeholder="e.g. Anonymous" />
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

			<button type="submit" disabled={submitting}>
				{submitting ? 'Creating…' : 'Create repository'}
			</button>
		</form>
	</section>
{/if}

<section class="repos">
	<h2>Repositories created from this template</h2>

	{#if data.listError}
		<p class="muted">Couldn't load the list: {data.listError}</p>
	{:else if data.repos.length === 0}
		<p class="muted">None yet. Be the first to create one!</p>
	{:else}
		<ul>
			{#each data.repos as repo (repo.full_name)}
				<li>
					<div class="row">
						<a href={repo.html_url} target="_blank" rel="noreferrer">{repo.full_name}</a>
						{#if repo.private}
							<span class="badge" title="Private — only visible to its owner">🔒 Private</span>
						{/if}
					</div>
					{#if repo.description}
						<p class="desc">{repo.description}</p>
					{/if}
				</li>
			{/each}
		</ul>
		{#if !data.user}
			<p class="muted small">Log in to also see your own private repositories here.</p>
		{/if}
	{/if}
</section>

<style>
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
	.banner.info {
		background: #e8f1fd;
		border: 1px solid #bcd4f3;
	}
	.banner.warn {
		background: #fff8e1;
		border: 1px solid #f0dca0;
		color: #6a5300;
	}
	.banner.warn code {
		background: #f4e9c5;
		padding: 0.05rem 0.3rem;
		border-radius: 4px;
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
