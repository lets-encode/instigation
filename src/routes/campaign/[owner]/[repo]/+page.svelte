<script lang="ts">
	import { page } from '$app/state';
	import { auth, login, forge } from '$lib/auth.svelte.ts';
	import { meiFriendUrl } from '$lib/forge/config.ts';
	import type { ForgeClient } from '$lib/forge/types.ts';
	import {
		parseStateCsv,
		parseLocksCsv,
		serializeStateCsv,
		serializeLocksCsv
	} from '$lib/campaign-tables.ts';
	import type { StateRow, LockRow } from '$lib/campaign-tables.ts';

	const STATE_PATH = 'tracking/state.csv';
	const LOCKS_PATH = 'tracking/locks.csv';
	const rand = () => crypto.randomUUID().slice(0, 8);

	// Guaranteed present by the [owner]/[repo] route.
	const owner = $derived(page.params.owner!);
	const repo = $derived(page.params.repo!);
	const viewer = $derived(auth.user?.login ?? '');

	type Result = {
		ok?: boolean;
		error?: string;
		message?: string;
		prUrl?: string;
		meiFriendUrl?: string;
		rawUrl?: string;
	} | null;

	let loading = $state(false);
	let loaded = $state(false);
	let loadError = $state<string | null>(null);
	let notInitialised = $state(false);
	let isPrivate = $state(false);
	let tasks = $state<StateRow[]>([]);
	let validationColumns = $state<string[]>([]);
	let locks = $state<LockRow[]>([]);

	let busy = $state(false);
	let result = $state<Result>(null);

	const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

	const lockFor = (taskId: string, kind: string) =>
		locks.find((l) => l.task_id === taskId && l.kind === kind);
	const myEncodingLock = (taskId: string) =>
		locks.find((l) => l.task_id === taskId && l.kind === 'encoding' && l.locked_by === viewer);

	// Read the tracking tables (and privacy) for the console. Only the first read
	// shows the loading state; refreshes update the tables in place.
	async function load() {
		const f = forge();
		if (!f) return;
		if (!loaded) loading = true;
		loadError = null;
		try {
			const [stateCsv, locksCsv, priv] = await Promise.all([
				f.getRepoFile(owner, repo, STATE_PATH),
				f.getRepoFile(owner, repo, LOCKS_PATH),
				f.getRepoIsPrivate(owner, repo)
			]);
			isPrivate = priv;
			if (stateCsv == null || locksCsv == null) {
				notInitialised = true;
				tasks = [];
				validationColumns = [];
				locks = [];
			} else {
				notInitialised = false;
				const state = parseStateCsv(stateCsv);
				tasks = state.rows;
				validationColumns = state.validationColumns;
				locks = parseLocksCsv(locksCsv);
			}
			loaded = true;
		} catch (e) {
			loadError = `Could not read ${owner}/${repo}: ${(e as Error).message}`;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (auth.status === 'authenticated' && owner && repo && !loaded) load();
	});

	// Run an action: flip busy, capture its result banner, then refresh the tables.
	async function run(action: (f: ForgeClient) => Promise<Result>) {
		const f = forge();
		if (!f) return;
		busy = true;
		try {
			result = await action(f);
		} finally {
			busy = false;
		}
		await load();
	}

	// Open a PR that adds a lock row (the Action re-authors who/when). Shared by the
	// claim action and "open in mei-friend" (where opening == claiming).
	async function openClaimPr(f: ForgeClient, task_id: string, kind: string) {
		const rows = parseLocksCsv((await f.getRepoFile(owner, repo, LOCKS_PATH)) ?? '');
		rows.push({ task_id, locked_by: viewer, locked_at: new Date().toISOString(), kind });
		return f.openChangePr(owner, repo, {
			branch: `claim-${task_id}-${rand()}`,
			files: [{ path: LOCKS_PATH, content: serializeLocksCsv(rows) }],
			message: `Claim ${task_id} (${kind})`,
			title: `Claim ${task_id} (${kind})`,
			body: `Reserves task ${task_id} for ${kind} work by @${viewer}. Opened from the campaign console.`
		});
	}

	const claim = (task_id: string) =>
		run(async (f) => {
			try {
				const pr = await openClaimPr(f, task_id, 'validation');
				return { ok: true, prUrl: pr.html_url, message: `Opened claim PR #${pr.number} for ${task_id} (validation).` };
			} catch (e) {
				return { error: `Claim failed: ${(e as Error).message}` };
			}
		});

	// Open the task's score in mei-friend; opening for editing also opens an
	// encoding claim PR (unless you already hold the lock).
	const editor = (task_id: string) =>
		run(async (f) => {
			try {
				const state = parseStateCsv((await f.getRepoFile(owner, repo, STATE_PATH)) ?? '');
				const task = state.rows.find((r) => r.task_id === task_id);
				if (!task) return { error: `Unknown task ${task_id}.` };

				const { sha, canPush } = await f.getRepoHead(owner, repo);

				// Owner/collaborator: commit on a branch in the repo itself (can't fork
				// your own repo), bound via connect=true. Volunteer: fork=true.
				let ref: string | undefined;
				let meiParam: string;
				if (canPush) {
					ref = `encode-${task_id}`;
					try {
						await f.createBranch(owner, repo, ref, sha);
					} catch (e) {
						if (!/already exists|\b422\b/i.test((e as Error).message)) throw e;
					}
					meiParam = '&connect=true';
				} else {
					meiParam = '&fork=true';
				}

				const downloadUrl = await f.getRepoFileDownloadUrl(owner, repo, task.fragment, ref);
				if (!downloadUrl) return { error: `Could not get a download URL for ${task.fragment}.` };
				const url = `${meiFriendUrl}/?file=${encodeURIComponent(downloadUrl)}${meiParam}`;

				const mine = parseLocksCsv((await f.getRepoFile(owner, repo, LOCKS_PATH)) ?? '').some(
					(l) => l.task_id === task_id && l.kind === 'encoding' && l.locked_by === viewer
				);
				let prUrl: string | undefined;
				let message = 'Opening the score in mei-friend. After committing there, use “Submit encoding”.';
				if (task.state === 'encoding_required' && !mine) {
					const pr = await openClaimPr(f, task_id, 'encoding');
					prUrl = pr.html_url;
					message = `Opening the score in mei-friend; opened encoding claim PR #${pr.number}. After committing in mei-friend, use “Submit encoding”.`;
				}
				window.open(url, '_blank', 'noopener');
				return { ok: true, meiFriendUrl: url, prUrl, message };
			} catch (e) {
				return { error: `Open in mei-friend failed: ${(e as Error).message}` };
			}
		});

	// After committing an encoding in mei-friend (which only pushes to a branch),
	// open the submission PR that triggers Action C and advances to validation.
	const submitpr = (task_id: string) =>
		run(async (f) => {
			try {
				const { branch: base, canPush } = await f.getRepoHead(owner, repo);
				let head: string;
				if (canPush) {
					head = `encode-${task_id}`;
				} else {
					const fork = await f.ensureFork(owner, repo);
					const { branch: forkBranch } = await f.getRepoHead(fork.owner, fork.repo);
					head = `${fork.owner}:${forkBranch}`;
				}
				const pr = await f.createPullRequest(owner, repo, {
					title: `Encoding of ${task_id}`,
					head,
					base,
					body: `Submits the encoding of ${task_id} by @${viewer}, edited in mei-friend. Opened from the campaign console.`
				});
				return { ok: true, prUrl: pr.html_url, message: `Opened submission PR #${pr.number} for ${task_id}.` };
			} catch (e) {
				return { error: `Submission PR failed: ${(e as Error).message}` };
			}
		});

	// Just the tokenised raw URL of the score (no claim) — copied to the clipboard.
	const rawlink = (task_id: string) =>
		run(async (f) => {
			try {
				const state = parseStateCsv((await f.getRepoFile(owner, repo, STATE_PATH)) ?? '');
				const task = state.rows.find((r) => r.task_id === task_id);
				if (!task) return { error: `Unknown task ${task_id}.` };
				const rawUrl = await f.getRepoFileDownloadUrl(owner, repo, task.fragment);
				if (!rawUrl) return { error: `Could not get a raw link for ${task.fragment}.` };
				copy(rawUrl);
				return { ok: true, rawUrl, message: `Raw link for ${task.fragment}:` };
			} catch (e) {
				return { error: `Raw link failed: ${(e as Error).message}` };
			}
		});

	// Action C — open a PR that sets the first open validation cell (pass/fail).
	const validate = (task_id: string, verdict: string) =>
		run(async (f) => {
			try {
				const state = parseStateCsv((await f.getRepoFile(owner, repo, STATE_PATH)) ?? '');
				const task = state.rows.find((r) => r.task_id === task_id);
				if (!task) return { error: `Unknown task ${task_id}.` };
				const slot = state.validationColumns.find((c) => (task[c] ?? '') === '');
				if (!slot) return { error: `No open validation slot on ${task_id}.` };
				task[slot] = verdict; // the Action re-authors this to `verdict|user|time`
				const pr = await f.openChangePr(owner, repo, {
					branch: `validate-${task_id}-${rand()}`,
					files: [{ path: STATE_PATH, content: serializeStateCsv(state) }],
					message: `Validate ${task_id} (${verdict})`,
					title: `Validate ${task_id} (${verdict})`,
					body: `Submits a ${verdict} validation for task ${task_id}. Opened from the campaign console.`
				});
				return { ok: true, prUrl: pr.html_url, message: `Opened validation PR #${pr.number} for ${task_id} (${verdict}).` };
			} catch (e) {
				return { error: `Validate failed: ${(e as Error).message}` };
			}
		});

	// Action E — manually dispatch the scheduled reaper.
	const reaper = () =>
		run(async (f) => {
			try {
				const { branch } = await f.getRepoHead(owner, repo);
				await f.dispatchWorkflow(owner, repo, 'reaper.yml', branch);
				return { ok: true, message: 'Triggered the stale-lock reaper.' };
			} catch (e) {
				return { error: `Reaper dispatch failed: ${(e as Error).message}` };
			}
		});
</script>

<p class="back"><a href="/">← All campaigns</a></p>

<header>
	<h1>Campaign console</h1>
	<p class="repo">
		<a href={`https://github.com/${owner}/${repo}`} target="_blank" rel="noreferrer">
			{owner}/{repo}
		</a>
	</p>
	<p class="muted">
		Drive the campaign Actions: open the score in mei-friend (which also claims the encoding
		task), submit work, validate, and run the reaper. Each opens the same kind of pull request a
		volunteer client would. The workflows run on GitHub and take a few seconds; use
		<strong>Refresh</strong> to re-read the tables afterwards.
	</p>
</header>

{#if auth.status === 'loading'}
	<p class="muted">Loading…</p>
{:else if !auth.user}
	<div class="banner warn">
		Please <button type="button" class="linkish" onclick={() => login()}>log in with GitHub</button>
		to drive this campaign.
	</div>
{:else}
	{#if result && result.error}
		<div class="banner err">{result.error}</div>
	{:else if result && result.ok}
		<div class="banner ok">
			{result.message}
			{#if result.prUrl}
				<a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
			{/if}
			{#if result.meiFriendUrl}
				<div class="rawlink">
					<input readonly value={result.meiFriendUrl} onfocus={(e) => (e.target as HTMLInputElement).select()} />
					<button type="button" onclick={() => copy(result!.meiFriendUrl!)}>Copy</button>
				</div>
				<span class="muted">
					<a href={result.meiFriendUrl} target="_blank" rel="noreferrer">Open in mei-friend ↗</a>
					(if the tab didn't open automatically)
				</span>
			{/if}
			{#if result.rawUrl}
				<div class="rawlink">
					<input readonly value={result.rawUrl} onfocus={(e) => (e.target as HTMLInputElement).select()} />
					<button type="button" onclick={() => copy(result!.rawUrl!)}>Copy</button>
				</div>
				{#if isPrivate}
					<span class="muted">The token in this link expires within minutes — use it promptly.</span>
				{/if}
			{/if}
		</div>
	{/if}

	{#if loading}
		<p class="muted">Loading campaign…</p>
	{:else if loadError}
		<div class="banner err">{loadError}</div>
	{:else if notInitialised}
		<div class="banner warn">
			This repository has no <code>tracking/state.csv</code> / <code>tracking/locks.csv</code> yet —
			it may not have been initialised. Create it through the home page to initialise it.
		</div>
	{:else}
		<div class="toolbar">
			<button type="button" onclick={() => load()} disabled={busy || loading}>Refresh tables</button>
			<button type="button" onclick={() => reaper()} disabled={busy}>Run stale-lock reaper</button>
		</div>

		<h2>Tasks</h2>
		<table>
			<thead>
				<tr>
					<th>Task</th><th>State</th><th>Encoder</th>
					{#each validationColumns as v}<th>{v}</th>{/each}
					<th>Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each tasks as task (task.task_id)}
					<tr>
						<td><code>{task.task_id}</code></td>
						<td><span class="state {task.state}">{task.state}</span></td>
						<td>{task.encoder || '—'}</td>
						{#each validationColumns as v}<td class="cell">{task[v] || '—'}</td>{/each}
						<td class="actions">
							<div class="btnrow">
								<button
									type="button"
									onclick={() => editor(task.task_id)}
									disabled={busy || !(task.state === 'encoding_required' || myEncodingLock(task.task_id))}
									title="Opens score.mei in mei-friend; claims the encoding task if not already yours"
								>
									Open in mei-friend
								</button>
								<button type="button" onclick={() => rawlink(task.task_id)} disabled={busy} title="Get the tokenised raw link to paste into mei-friend manually">
									Copy raw link
								</button>
							</div>

							<div class="btnrow">
								<button
									type="button"
									onclick={() => submitpr(task.task_id)}
									disabled={busy || !myEncodingLock(task.task_id)}
									title="After committing your encoding in mei-friend, open the submission PR (advances the task to validation)"
								>
									Submit encoding
								</button>
							</div>

							<div class="btnrow">
								<button type="button" onclick={() => claim(task.task_id)} disabled={busy || task.state !== 'validation_required'}>
									Claim (validate)
								</button>
							</div>

							<div class="btnrow">
								<button type="button" onclick={() => validate(task.task_id, 'pass')} disabled={busy || !lockFor(task.task_id, 'validation')}>
									Validate: pass
								</button>
								<button type="button" onclick={() => validate(task.task_id, 'fail')} disabled={busy || !lockFor(task.task_id, 'validation')}>
									fail
								</button>
							</div>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<h2>Active locks</h2>
		{#if locks.length === 0}
			<p class="muted">None.</p>
		{:else}
			<table>
				<thead><tr><th>Task</th><th>Locked by</th><th>At</th><th>Kind</th></tr></thead>
				<tbody>
					{#each locks as lock}
						<tr>
							<td><code>{lock.task_id}</code></td>
							<td>{lock.locked_by}</td>
							<td class="muted">{lock.locked_at}</td>
							<td>{lock.kind}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}

		<p class="note">
			<strong>Open in mei-friend</strong> loads the score
			{#if isPrivate}
				from a short-lived tokenised raw URL (so it works for this private repo) — open it promptly,
				the token expires within minutes
			{:else}
				from its public raw URL
			{/if}
			and, at the same time, opens an encoding claim PR. You add the content in mei-friend
			and commit it there (to a branch, or to your fork if you can't push); then
			<strong>Submit encoding</strong> opens the submission PR that advances the task to
			validation.<br />
			A task's <strong>encoder cannot validate their own work</strong> (peer review): logged in as
			<code>{viewer}</code>, you'll need a second GitHub account to test a passing validation.
			Buttons enable only when the relevant state/lock allows the action.
		</p>
	{/if}
{/if}

<style>
	.back {
		margin: 0 0 1rem;
	}
	.back a {
		color: #555;
		text-decoration: none;
	}
	header h1 {
		margin-bottom: 0.2rem;
	}
	.repo {
		margin: 0 0 0.6rem;
		font-weight: 600;
	}
	.repo a {
		color: #1a1a1a;
	}
	.muted {
		color: #777;
		font-size: 0.9rem;
	}
	.linkish {
		font: inherit;
		color: #3056d3;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		text-decoration: underline;
	}
	.toolbar {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		margin: 1.2rem 0;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 0.88rem;
		margin-bottom: 1.5rem;
	}
	th,
	td {
		border: 1px solid #e5e5e5;
		padding: 0.45rem 0.6rem;
		text-align: left;
		vertical-align: top;
	}
	th {
		background: #fafafa;
		font-size: 0.8rem;
	}
	.cell {
		font-family: ui-monospace, monospace;
		font-size: 0.78rem;
	}
	.state {
		font-size: 0.75rem;
		padding: 0.1rem 0.4rem;
		border-radius: 999px;
		border: 1px solid #ddd;
	}
	.state.encoding_required {
		background: #fff4d6;
		border-color: #f0dca0;
	}
	.state.validation_required {
		background: #e8f1fd;
		border-color: #bcd4f3;
	}
	.state.completed {
		background: #e8f7ec;
		border-color: #b6e2c1;
	}
	.actions {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.btnrow {
		display: flex;
		gap: 0.3rem;
	}
	button {
		font: inherit;
		font-size: 0.8rem;
		padding: 0.3rem 0.6rem;
		border: 1px solid #ccc;
		border-radius: 6px;
		background: #fff;
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.note {
		font-size: 0.85rem;
		color: #6a5300;
		background: #fff8e1;
		border: 1px solid #f0dca0;
		border-radius: 8px;
		padding: 0.6rem 0.8rem;
	}
	.rawlink {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	.rawlink input {
		flex: 1;
		font: inherit;
		font-size: 0.78rem;
		font-family: ui-monospace, monospace;
		padding: 0.3rem 0.5rem;
		border: 1px solid #b6e2c1;
		border-radius: 6px;
		background: #fff;
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
	}
</style>
