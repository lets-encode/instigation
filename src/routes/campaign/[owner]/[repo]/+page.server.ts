import { error, redirect, fail } from '@sveltejs/kit';
import {
	getRepoFile,
	getRepoFileDownloadUrl,
	getRepoHead,
	getRepoIsPrivate,
	openChangePr,
	dispatchWorkflow
} from '$lib/server/github.js';
import {
	parseStateCsv,
	parseLocksCsv,
	serializeStateCsv,
	serializeLocksCsv
} from '$lib/server/campaign-tables.js';
import type { PageServerLoad, Actions } from './$types';

const STATE_PATH = 'tracking/state.csv';
const LOCKS_PATH = 'tracking/locks.csv';

const MEI_FRIEND = 'https://mei-friend.mdw.ac.at';

const rand = (): string => crypto.randomUUID().slice(0, 8);

// Open a PR that adds a lock row (the Action re-authors who/when). Shared by the
// claim action and the "open in mei-friend" action (where opening == claiming).
async function openClaimPr(
	token: string,
	owner: string,
	repo: string,
	user: string,
	task_id: string,
	kind: string
): Promise<{ number: number; html_url: string }> {
	const locks = parseLocksCsv((await getRepoFile(token, owner, repo, LOCKS_PATH)) ?? '');
	locks.push({ task_id, locked_by: user, locked_at: new Date().toISOString(), kind });
	return openChangePr(token, owner, repo, {
		branch: `claim-${task_id}-${rand()}`,
		files: [{ path: LOCKS_PATH, content: serializeLocksCsv(locks) }],
		message: `Claim ${task_id} (${kind})`,
		title: `Claim ${task_id} (${kind})`,
		body: `Reserves task ${task_id} for ${kind} work by @${user}. Opened from the campaign console.`
	});
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(302, '/');
	const { owner, repo } = params;

	let stateCsv: string | null, locksCsv: string | null, isPrivate: boolean;
	try {
		[stateCsv, locksCsv, isPrivate] = await Promise.all([
			getRepoFile(locals.token!, owner, repo, STATE_PATH),
			getRepoFile(locals.token!, owner, repo, LOCKS_PATH),
			getRepoIsPrivate(locals.token!, owner, repo)
		]);
	} catch (e) {
		throw error(502, `Could not read ${owner}/${repo}: ${(e as Error).message}`);
	}

	if (stateCsv == null || locksCsv == null) {
		return { owner, repo, viewer: locals.user.login, isPrivate, notInitialised: true, tasks: [], validationColumns: [], locks: [] };
	}
	const state = parseStateCsv(stateCsv);
	return {
		owner,
		repo,
		viewer: locals.user.login,
		isPrivate,
		notInitialised: false,
		tasks: state.rows,
		validationColumns: state.validationColumns,
		locks: parseLocksCsv(locksCsv)
	};
};

export const actions = {
	// Action B — claim a task (validation claims use this; encoding is claimed by
	// opening the editor below).
	claim: async ({ params, request, locals }) => {
		const { owner, repo } = params;
		const form = await request.formData();
		const task_id = String(form.get('task_id') ?? '');
		const kind = String(form.get('kind') ?? '');
		try {
			const pr = await openClaimPr(locals.token!, owner, repo, locals.user!.login, task_id, kind);
			return { ok: true, prUrl: pr.html_url, message: `Opened claim PR #${pr.number} for ${task_id} (${kind}).` };
		} catch (e) {
			return fail(502, { error: `Claim failed: ${(e as Error).message}` });
		}
	},

	// Open the task's score in mei-friend; opening for editing also opens an
	// encoding claim PR (unless you already hold the lock). Returns a mei-friend
	// URL the client opens in a new tab; the score loads via `?file=` from a
	// short-lived tokenised raw URL (works for private repos).
	editor: async ({ params, request, locals }) => {
		const { owner, repo } = params;
		const form = await request.formData();
		const task_id = String(form.get('task_id') ?? '');
		try {
			const state = parseStateCsv((await getRepoFile(locals.token!, owner, repo, STATE_PATH)) ?? '');
			const task = state.rows.find((r) => r.task_id === task_id);
			if (!task) return fail(400, { error: `Unknown task ${task_id}.` });

			const downloadUrl = await getRepoFileDownloadUrl(locals.token!, owner, repo, task.fragment);
			if (!downloadUrl) return fail(502, { error: `Could not get a download URL for ${task.fragment}.` });

			// Volunteers (no push access) work through a fork, so mei-friend needs
			// `fork=true` to commit the encoding back via a fork PR. Owners/collaborators
			// commit directly and don't.
			const { canPush } = await getRepoHead(locals.token!, owner, repo);
			const meiFriendUrl =
				`${MEI_FRIEND}/?file=${encodeURIComponent(downloadUrl)}` + (canPush ? '' : '&fork=true');

			const locks = parseLocksCsv((await getRepoFile(locals.token!, owner, repo, LOCKS_PATH)) ?? '');
			const mine = locks.some(
				(l) => l.task_id === task_id && l.kind === 'encoding' && l.locked_by === locals.user!.login
			);
			let prUrl: string | undefined;
			let message = 'Opening the score in mei-friend.';
			if (task.state === 'encoding_required' && !mine) {
				const pr = await openClaimPr(locals.token!, owner, repo, locals.user!.login, task_id, 'encoding');
				prUrl = pr.html_url;
				message = `Opening the score in mei-friend; opened encoding claim PR #${pr.number}.`;
			}
			return { ok: true, meiFriendUrl, prUrl, message };
		} catch (e) {
			return fail(502, { error: `Open in mei-friend failed: ${(e as Error).message}` });
		}
	},

	// Just the tokenised raw URL of the score (no claim) — for pasting into
	// mei-friend manually, or anywhere a direct link is handy.
	rawlink: async ({ params, request, locals }) => {
		const { owner, repo } = params;
		const form = await request.formData();
		const task_id = String(form.get('task_id') ?? '');
		try {
			const state = parseStateCsv((await getRepoFile(locals.token!, owner, repo, STATE_PATH)) ?? '');
			const task = state.rows.find((r) => r.task_id === task_id);
			if (!task) return fail(400, { error: `Unknown task ${task_id}.` });
			const rawUrl = await getRepoFileDownloadUrl(locals.token!, owner, repo, task.fragment);
			if (!rawUrl) return fail(502, { error: `Could not get a raw link for ${task.fragment}.` });
			return { ok: true, rawUrl, message: `Raw link for ${task.fragment}:` };
		} catch (e) {
			return fail(502, { error: `Raw link failed: ${(e as Error).message}` });
		}
	},

	// Action C — open a PR that edits the task's fragment (a well-formed marker).
	encode: async ({ params, request, locals }) => {
		const { owner, repo } = params;
		const form = await request.formData();
		const task_id = String(form.get('task_id') ?? '');
		try {
			const stateCsv = await getRepoFile(locals.token!, owner, repo, STATE_PATH);
			const task = parseStateCsv(stateCsv ?? '').rows.find((r) => r.task_id === task_id);
			if (!task) return fail(400, { error: `Unknown task ${task_id}.` });

			const current = await getRepoFile(locals.token!, owner, repo, task.fragment);
			if (current == null) return fail(400, { error: `Fragment ${task.fragment} not found.` });
			const marker = `  <!-- test encoding by ${locals.user!.login} (${new Date().toISOString()}) -->\n`;
			const edited = current.includes('</mei>')
				? current.replace('</mei>', `${marker}</mei>`)
				: `${current}\n${marker}`;

			const pr = await openChangePr(locals.token!, owner, repo, {
				branch: `encode-${task_id}-${rand()}`,
				files: [{ path: task.fragment, content: edited }],
				message: `Encode ${task_id}`,
				title: `Encode ${task_id}`,
				body: `Submits an encoding for task ${task_id}. Opened from the campaign console (adds a marker comment to the score for testing).`
			});
			return { ok: true, prUrl: pr.html_url, message: `Opened encoding PR #${pr.number} for ${task_id}.` };
		} catch (e) {
			return fail(502, { error: `Encode failed: ${(e as Error).message}` });
		}
	},

	// Action C — open a PR that sets the first open validation cell (pass/fail).
	validate: async ({ params, request, locals }) => {
		const { owner, repo } = params;
		const form = await request.formData();
		const task_id = String(form.get('task_id') ?? '');
		const verdict = String(form.get('verdict') ?? '');
		try {
			const state = parseStateCsv((await getRepoFile(locals.token!, owner, repo, STATE_PATH)) ?? '');
			const task = state.rows.find((r) => r.task_id === task_id);
			if (!task) return fail(400, { error: `Unknown task ${task_id}.` });
			const slot = state.validationColumns.find((c) => (task[c] ?? '') === '');
			if (!slot) return fail(400, { error: `No open validation slot on ${task_id}.` });
			task[slot] = verdict; // the Action re-authors this to `verdict|user|time`

			const pr = await openChangePr(locals.token!, owner, repo, {
				branch: `validate-${task_id}-${rand()}`,
				files: [{ path: STATE_PATH, content: serializeStateCsv(state) }],
				message: `Validate ${task_id} (${verdict})`,
				title: `Validate ${task_id} (${verdict})`,
				body: `Submits a ${verdict} validation for task ${task_id}. Opened from the campaign console.`
			});
			return { ok: true, prUrl: pr.html_url, message: `Opened validation PR #${pr.number} for ${task_id} (${verdict}).` };
		} catch (e) {
			return fail(502, { error: `Validate failed: ${(e as Error).message}` });
		}
	},

	// Action E — manually dispatch the scheduled reaper.
	reaper: async ({ params, locals }) => {
		const { owner, repo } = params;
		try {
			const { branch } = await getRepoHead(locals.token!, owner, repo);
			await dispatchWorkflow(locals.token!, owner, repo, 'reaper.yml', branch);
			return { ok: true, message: 'Triggered the stale-lock reaper.' };
		} catch (e) {
			return fail(502, { error: `Reaper dispatch failed: ${(e as Error).message}` });
		}
	}
} satisfies Actions;
