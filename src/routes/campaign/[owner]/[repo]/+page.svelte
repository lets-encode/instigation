<script>
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	let { data, form } = $props();
	let busy = $state(false);

	// A bare submit handler: flips `busy`, then refreshes the result.
	const copy = (text) => navigator.clipboard?.writeText(text).catch(() => {});

	const run = () => {
		busy = true;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'success' && result.data?.meiFriendUrl) {
				// "Open in mei-friend" — open the score in a new tab.
				window.open(result.data.meiFriendUrl, '_blank', 'noopener');
			}
			if (result.type === 'success' && result.data?.rawUrl) {
				// "Copy raw link" — best-effort copy; the banner also shows it to copy by hand.
				copy(result.data.rawUrl);
			}
			await update({ reset: false });
		};
	};

	const lockFor = (taskId, kind) =>
		data.locks.find((l) => l.task_id === taskId && l.kind === kind);
	const myEncodingLock = (taskId) =>
		data.locks.find(
			(l) => l.task_id === taskId && l.kind === 'encoding' && l.locked_by === data.viewer
		);
</script>

<p class="back"><a href="/">← All campaigns</a></p>

<header>
	<h1>Campaign console</h1>
	<p class="repo">
		<a href={`https://github.com/${data.owner}/${data.repo}`} target="_blank" rel="noreferrer">
			{data.owner}/{data.repo}
		</a>
	</p>
	<p class="muted">
		Drive the campaign Actions: open the score in mei-friend (which also claims the encoding
		task), submit work, validate, and run the reaper. Each opens the same kind of pull request a
		volunteer client would. The workflows run on GitHub and take a few seconds; use
		<strong>Refresh</strong> to re-read the tables afterwards.
	</p>
</header>

{#if form?.error}
	<div class="banner err">{form.error}</div>
{:else if form?.ok}
	<div class="banner ok">
		{form.message}
		{#if form.prUrl}
			<a href={form.prUrl} target="_blank" rel="noreferrer">View PR →</a>
		{/if}
		{#if form.meiFriendUrl}
			<div class="rawlink">
				<input readonly value={form.meiFriendUrl} onfocus={(e) => e.target.select()} />
				<button type="button" onclick={() => copy(form.meiFriendUrl)}>Copy</button>
			</div>
			<span class="muted">
				<a href={form.meiFriendUrl} target="_blank" rel="noreferrer">Open in mei-friend ↗</a>
				(if the tab didn't open automatically)
			</span>
		{/if}
		{#if form.rawUrl}
			<div class="rawlink">
				<input readonly value={form.rawUrl} onfocus={(e) => e.target.select()} />
				<button type="button" onclick={() => copy(form.rawUrl)}>Copy</button>
			</div>
			{#if data.isPrivate}
				<span class="muted">The token in this link expires within minutes — use it promptly.</span>
			{/if}
		{/if}
	</div>
{/if}

{#if data.notInitialised}
	<div class="banner warn">
		This repository has no <code>tracking/state.csv</code> / <code>tracking/locks.csv</code> yet —
		it may not have been initialised. Create it through the home page so Action A runs.
	</div>
{:else}
	<div class="toolbar">
		<button type="button" onclick={() => invalidateAll()} disabled={busy}>Refresh tables</button>
		<form method="POST" action="?/reaper" use:enhance={run}>
			<button type="submit" disabled={busy}>Run stale-lock reaper</button>
		</form>
	</div>

	<h2>Tasks</h2>
	<table>
		<thead>
			<tr>
				<th>Task</th><th>State</th><th>Encoder</th>
				{#each data.validationColumns as v}<th>{v}</th>{/each}
				<th>Actions</th>
			</tr>
		</thead>
		<tbody>
			{#each data.tasks as task (task.task_id)}
				<tr>
					<td><code>{task.task_id}</code></td>
					<td><span class="state {task.state}">{task.state}</span></td>
					<td>{task.encoder || '—'}</td>
					{#each data.validationColumns as v}<td class="cell">{task[v] || '—'}</td>{/each}
					<td class="actions">
						<form method="POST" action="?/editor" use:enhance={run}>
							<input type="hidden" name="task_id" value={task.task_id} />
							<button
								type="submit"
								disabled={busy || !(task.state === 'encoding_required' || myEncodingLock(task.task_id))}
								title="Opens score.mei in mei-friend; claims the encoding task if not already yours"
							>
								Open in mei-friend
							</button>
							<button type="submit" formaction="?/rawlink" disabled={busy} title="Get the tokenised raw link to paste into mei-friend manually">
								Copy raw link
							</button>
						</form>

						<form method="POST" action="?/claim" use:enhance={run}>
							<input type="hidden" name="task_id" value={task.task_id} />
							<button name="kind" value="validation" disabled={busy || task.state !== 'validation_required'}>
								Claim (validate)
							</button>
						</form>

						<form method="POST" action="?/encode" use:enhance={run}>
							<input type="hidden" name="task_id" value={task.task_id} />
							<button type="submit" disabled={busy || !lockFor(task.task_id, 'encoding')}>
								Submit encoding
							</button>
						</form>

						<form method="POST" action="?/validate" use:enhance={run}>
							<input type="hidden" name="task_id" value={task.task_id} />
							<button name="verdict" value="pass" disabled={busy || !lockFor(task.task_id, 'validation')}>
								Validate: pass
							</button>
							<button name="verdict" value="fail" disabled={busy || !lockFor(task.task_id, 'validation')}>
								fail
							</button>
						</form>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>

	<h2>Active locks</h2>
	{#if data.locks.length === 0}
		<p class="muted">None.</p>
	{:else}
		<table>
			<thead><tr><th>Task</th><th>Locked by</th><th>At</th><th>Kind</th></tr></thead>
			<tbody>
				{#each data.locks as lock}
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
		{#if data.isPrivate}
			from a short-lived tokenised raw URL (so it works for this private repo) — open it promptly,
			the token expires within minutes
		{:else}
			from its public raw URL
		{/if}
		and, at the same time, opens an encoding claim PR (Action B). Saving the edit back is a separate
		step (mei-friend's GitHub commit, or <strong>Submit encoding</strong> here).<br />
		A task's <strong>encoder cannot validate their own work</strong> (peer review): logged in as
		<code>{data.viewer}</code>, you'll need a second GitHub account to test a passing validation.
		Buttons enable only when the relevant state/lock allows the action.
	</p>
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
	.toolbar {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		margin: 1.2rem 0;
	}
	.toolbar form {
		margin: 0;
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
	.actions form {
		display: flex;
		gap: 0.3rem;
		margin: 0;
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
