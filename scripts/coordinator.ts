// Campaign coordinator — the single entry point the generic caller runs.
// It branches on the triggering event (EVENT_NAME) and, for pull requests, on
// the PR's changed paths, then hands the decision to the pure modules and
// applies the result with optimistic concurrency. Every outcome — accepted,
// rejected, reaped — is appended to the campaign's history table.
// See DESIGN.md §4 (the caller) & §6 (PR contract).
//
// Runs in the BASE (campaign) repo's context with a write token. The pull
// request is treated purely as DATA: we read its changed-file patches and
// blobs via the API and never check out or execute anything the fork supplies.
//
// Env: GH_TOKEN, BASE_REPO ("owner/repo"), EVENT_NAME;
//      for pull_request_target additionally PR_NUMBER, PR_AUTHOR,
//      HEAD_REPO ("owner/repo" of the PR head), HEAD_SHA, HEAD_REF.

import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	parseTaskCsv,
	parseStateCsv,
	parseLockCsv,
	serializeStateCsv,
	serializeLockCsv,
	appendHistory,
	findRow
} from '../src/lib/campaign-tables.ts';
import type { ParsedState, LockRow, HistoryRow } from '../src/lib/campaign-tables.ts';
import { checkClaim } from '../src/lib/campaign-claim.ts';
import { checkEncoding, checkValidation } from '../src/lib/campaign-submit.ts';
import { reapLocks } from '../src/lib/campaign-reaper.ts';
import {
	getRepoFile,
	getRepoHead,
	getPullRequestFiles,
	commitFiles,
	commentAndClosePr,
	deleteBranch
} from '../src/lib/forge/github-rest.ts';
import type { FileChange } from '../src/lib/forge/github-rest.ts';

const token = process.env.GH_TOKEN ?? '';
const [owner, repo] = (process.env.BASE_REPO ?? '').split('/');
const eventName = process.env.EVENT_NAME ?? '';
const prNumber = Number(process.env.PR_NUMBER);
const author = process.env.PR_AUTHOR ?? '';
const [headOwner, headRepo] = (process.env.HEAD_REPO ?? '').split('/');
const headSha = process.env.HEAD_SHA ?? '';
const headRef = process.env.HEAD_REF ?? '';

const TASK_PATH = 'tracking/task.csv';
const STATE_PATH = 'tracking/state.csv';
const LOCK_PATH = 'tracking/lock.csv';
const HISTORY_PATH = 'tracking/history.csv';
const CONFIG_PATH = 'config.yaml';
const MAX_ATTEMPTS = 3;
const DEFAULT_STALE_MINUTES = 120;

// The machine-check schema, pinned to the version the campaign template
// declares in its <?xml-model?> processing instruction.
const MEI_SCHEMA_URL = 'https://music-encoding.org/schema/5.0/mei-CMN.rng';

type Verdict = { ok: boolean; reason?: string };

// ---------------------------------------------------------------------------
// Shared helpers

// Delete the PR's head branch once we've closed it — but only when it lives in
// this repo (owner/collaborator PR). A volunteer's branch lives in their fork,
// which this token can't touch; it stays harmlessly in the fork.
async function cleanupHeadBranch(): Promise<void> {
	if (headOwner !== owner || headRepo !== repo || !headRef) return;
	try {
		await deleteBranch(token, owner, repo, headRef);
	} catch (e) {
		console.warn(`Branch cleanup skipped: ${(e as Error).message}`);
	}
}

// Machine-check: well-formed XML AND valid against the pinned MEI schema, via
// xmllint --relaxng (which implies the well-formedness check). The schema is
// fetched once per run; a fetch failure fails the run loudly rather than
// letting content through unchecked.
let schemaPath: string | null = null;
async function isValidMei(content: string): Promise<boolean> {
	if (!schemaPath) {
		const res = await fetch(MEI_SCHEMA_URL);
		if (!res.ok) throw new Error(`Failed to fetch MEI schema (${res.status} ${MEI_SCHEMA_URL})`);
		const path = join(tmpdir(), 'mei-schema.rng');
		await writeFile(path, await res.text());
		schemaPath = path;
	}
	const r = spawnSync('xmllint', ['--noout', '--relaxng', schemaPath, '-'], { input: content });
	if (r.status !== 0) console.warn(`MEI machine-check failed:\n${r.stderr}`);
	return r.status === 0;
}

// Targeted reads of the machine-generated config.yaml (fixed shape, so no YAML
// dependency is needed).
function numberFromConfig(configText: string | null, key: string, fallback: number): number {
	const m = new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm').exec(configText ?? '');
	return m ? Number(m[1]) : fallback;
}

// ---------------------------------------------------------------------------
// Claim (a PR adding one row to lock.csv)

// Pull the single added line out of a unified-diff patch. Returns null unless
// exactly one line was added and none removed — a claim adds one lock row.
function addedRowFromPatch(patch: string | undefined): string | null {
	if (!patch) return null;
	const added: string[] = [];
	let removed = 0;
	for (const line of patch.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('---')) continue;
		if (line.startsWith('+')) added.push(line.slice(1));
		else if (line.startsWith('-')) removed++;
	}
	return removed === 0 && added.length === 1 ? added[0] : null;
}

async function attemptClaim(
	changedPaths: string[],
	intent: { task_id: string; subtask_id: string; kind: string } | null
): Promise<Verdict & { lock?: LockRow }> {
	const { sha } = await getRepoHead(token, owner, repo);
	const [stateCsv, lockCsv, historyCsv] = await Promise.all([
		getRepoFile(token, owner, repo, STATE_PATH, sha),
		getRepoFile(token, owner, repo, LOCK_PATH, sha),
		getRepoFile(token, owner, repo, HISTORY_PATH, sha)
	]);
	const locks = parseLockCsv(lockCsv ?? '');
	const now = new Date().toISOString();

	const verdict: Verdict & { lock?: LockRow } = intent
		? checkClaim({
				state: parseStateCsv(stateCsv ?? ''),
				locks,
				intent,
				author,
				changedPaths,
				now
			})
		: { ok: false, reason: 'malformed_claim' };

	const history: HistoryRow = {
		timestamp: now,
		task_id: intent?.task_id ?? '',
		subtask_id: intent?.subtask_id ?? '',
		user_id: author,
		action: `claim_${intent?.kind || 'unknown'}`,
		outcome: verdict.ok ? 'accepted' : 'rejected',
		detail: verdict.ok ? '' : verdict.reason!
	};
	const files: FileChange[] = [{ path: HISTORY_PATH, content: appendHistory(historyCsv ?? '', [history]) }];
	if (verdict.ok) files.push({ path: LOCK_PATH, content: serializeLockCsv([...locks, verdict.lock!]) });

	const message = verdict.ok
		? `Lock ${verdict.lock!.task_id}${verdict.lock!.subtask_id && '/' + verdict.lock!.subtask_id} for ${author} (${verdict.lock!.kind})`
		: `Reject claim by ${author} (${verdict.reason})`;
	// Non-fast-forward update fails if `main` moved since `sha` → we retry.
	await commitFiles(token, owner, repo, files, message, { baseSha: sha });
	return verdict;
}

async function runClaim(files: Awaited<ReturnType<typeof getPullRequestFiles>>): Promise<void> {
	const changedPaths = files.map((f) => f.filename);
	const lockFile = files.find((f) => f.filename === LOCK_PATH);
	const addedRow = lockFile && addedRowFromPatch(lockFile.patch);
	const cells = addedRow ? addedRow.split(',') : null;
	const intent = cells
		? {
				task_id: cells[0]?.trim() ?? '',
				subtask_id: cells[1]?.trim() ?? '',
				kind: cells[4]?.trim() ?? ''
			}
		: null;

	let verdict: Verdict & { lock?: LockRow } = { ok: false, reason: 'malformed_claim' };
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		try {
			verdict = await attemptClaim(changedPaths, intent);
			break;
		} catch (e) {
			if (i === MAX_ATTEMPTS - 1) throw e;
			console.warn(`Apply raced (attempt ${i + 1}), retrying: ${(e as Error).message}`);
		}
	}

	const target = verdict.lock
		? `\`${verdict.lock.task_id}${verdict.lock.subtask_id && '/' + verdict.lock.subtask_id}\``
		: '';
	const body = verdict.ok
		? `✅ Claim accepted — ${target} locked for @${author} (${verdict.lock!.kind}).`
		: `❌ Claim rejected: \`${verdict.reason}\`. No changes were made.`;
	await commentAndClosePr(token, owner, repo, prNumber, body);
	await cleanupHeadBranch();
}

// ---------------------------------------------------------------------------
// Submission (encoding: the PR edits the task's fragment; validation: the PR
// records a pass/fail in state.csv)

// The single ((task_id, subtask_id), column, value) that differs between two
// parsed state tables, or null if not exactly one cell changed. Used to read a
// validation PR's intent (which subtask, pass/fail) from its proposed state.csv.
function singleCellDiff(
	base: ParsedState,
	head: ParsedState
): { task_id: string; subtask_id: string; column: string; value: string } | null {
	const diffs: Array<{ task_id: string; subtask_id: string; column: string; value: string }> = [];
	for (const headRow of head.rows) {
		const baseRow = findRow(base.rows, headRow.task_id, headRow.subtask_id);
		if (!baseRow) continue;
		for (const col of head.header) {
			if ((headRow[col] ?? '') !== (baseRow[col] ?? '')) {
				diffs.push({
					task_id: headRow.task_id,
					subtask_id: headRow.subtask_id,
					column: col,
					value: headRow[col] ?? ''
				});
			}
		}
	}
	return diffs.length === 1 ? diffs[0] : null;
}

interface SubmitOutcome extends Verdict {
	files: FileChange[];
	message: string;
	history: HistoryRow;
}

async function decideEncoding(
	sha: string,
	state: ParsedState,
	locks: LockRow[],
	changedPaths: string[],
	now: string
): Promise<Omit<SubmitOutcome, 'files' | 'message' | 'history'> & Partial<SubmitOutcome>> {
	const taskCsv = await getRepoFile(token, owner, repo, TASK_PATH, sha);
	const tasks = parseTaskCsv(taskCsv ?? '');
	const task = tasks.find((t) => t.subtask_id === '' && changedPaths.includes(t.fragment));
	if (!task) return { ok: false, reason: 'unknown_task' };

	const mei = await getRepoFile(token, headOwner, headRepo, task.fragment, headSha);
	const verdict = checkEncoding({
		tasks,
		state,
		locks,
		intent: { task_id: task.task_id },
		author,
		changedPaths,
		meiValid: mei != null && (await isValidMei(mei)),
		now
	});

	const history: HistoryRow = {
		timestamp: now,
		task_id: task.task_id,
		subtask_id: '',
		user_id: author,
		action: 'submit_encoding',
		outcome: verdict.ok ? 'accepted' : 'rejected',
		detail: verdict.ok ? '' : verdict.reason
	};
	if (!verdict.ok) return { ok: false, reason: verdict.reason, history };

	return {
		ok: true,
		history,
		files: [
			{ path: task.fragment, content: mei! },
			{ path: STATE_PATH, content: serializeStateCsv(verdict.state) },
			{ path: LOCK_PATH, content: serializeLockCsv(verdict.locks) }
		],
		message: `Accept encoding of ${task.task_id} by ${author}\n\nCo-authored-by: ${author} <${author}@users.noreply.github.com>`
	};
}

async function decideValidation(
	sha: string,
	state: ParsedState,
	locks: LockRow[],
	changedPaths: string[],
	now: string
): Promise<Omit<SubmitOutcome, 'files' | 'message' | 'history'> & Partial<SubmitOutcome>> {
	const headStateCsv = await getRepoFile(token, headOwner, headRepo, STATE_PATH, headSha);
	const diff = headStateCsv == null ? null : singleCellDiff(state, parseStateCsv(headStateCsv));
	if (!diff || !state.validationColumns.includes(diff.column)) {
		return { ok: false, reason: 'malformed_validation' };
	}
	const status = diff.value.startsWith('pass') ? 'pass' : diff.value.startsWith('fail') ? 'fail' : null;
	if (!status) return { ok: false, reason: 'invalid_verdict' };

	const configText = await getRepoFile(token, owner, repo, CONFIG_PATH, sha);
	const verdict = checkValidation({
		state,
		locks,
		intent: { task_id: diff.task_id, subtask_id: diff.subtask_id, verdict: status },
		author,
		changedPaths,
		passThreshold: numberFromConfig(configText, 'pass_threshold', state.validationColumns.length),
		now
	});

	const history: HistoryRow = {
		timestamp: now,
		task_id: diff.task_id,
		subtask_id: diff.subtask_id,
		user_id: author,
		action: 'submit_validation',
		outcome: verdict.ok ? 'accepted' : 'rejected',
		detail: verdict.ok ? status : verdict.reason
	};
	if (!verdict.ok) return { ok: false, reason: verdict.reason, history };

	return {
		ok: true,
		history,
		files: [
			{ path: STATE_PATH, content: serializeStateCsv(verdict.state) },
			{ path: LOCK_PATH, content: serializeLockCsv(verdict.locks) }
		],
		message: `Record ${status} validation of ${diff.task_id}/${diff.subtask_id} by ${author}`
	};
}

// One decide-and-apply pass, pinned to the branch head we read. Throws only if
// the commit races (caller retries); returns the verdict otherwise.
async function attemptSubmit(kind: 'encoding' | 'validation', changedPaths: string[]): Promise<Verdict> {
	const { sha } = await getRepoHead(token, owner, repo);
	const [stateCsv, lockCsv, historyCsv] = await Promise.all([
		getRepoFile(token, owner, repo, STATE_PATH, sha),
		getRepoFile(token, owner, repo, LOCK_PATH, sha),
		getRepoFile(token, owner, repo, HISTORY_PATH, sha)
	]);
	const state = parseStateCsv(stateCsv ?? '');
	const locks = parseLockCsv(lockCsv ?? '');
	const now = new Date().toISOString();

	const outcome =
		kind === 'validation'
			? await decideValidation(sha, state, locks, changedPaths, now)
			: await decideEncoding(sha, state, locks, changedPaths, now);

	const history: HistoryRow = outcome.history ?? {
		timestamp: now,
		task_id: '',
		subtask_id: '',
		user_id: author,
		action: `submit_${kind}`,
		outcome: 'rejected',
		detail: outcome.reason ?? 'rejected'
	};
	const files: FileChange[] = [
		...(outcome.files ?? []),
		{ path: HISTORY_PATH, content: appendHistory(historyCsv ?? '', [history]) }
	];
	const message = outcome.ok
		? outcome.message!
		: `Reject ${kind} submission by ${author} (${outcome.reason})`;
	await commitFiles(token, owner, repo, files, message, { baseSha: sha });
	return outcome;
}

async function runSubmit(
	kind: 'encoding' | 'validation',
	files: Awaited<ReturnType<typeof getPullRequestFiles>>
): Promise<void> {
	const changedPaths = files.map((f) => f.filename);

	let verdict: Verdict = { ok: false, reason: 'no_changes' };
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		try {
			verdict = await attemptSubmit(kind, changedPaths);
			break;
		} catch (e) {
			if (i === MAX_ATTEMPTS - 1) throw e;
			console.warn(`Apply raced (attempt ${i + 1}), retrying: ${(e as Error).message}`);
		}
	}

	const body = verdict.ok
		? `✅ Submission accepted (${kind}).`
		: `❌ Submission rejected: \`${verdict.reason}\`. No changes were made.`;
	await commentAndClosePr(token, owner, repo, prNumber, body);
	await cleanupHeadBranch();
}

// ---------------------------------------------------------------------------
// Reaper (scheduled / manually dispatched)

async function attemptReap(): Promise<void> {
	const { sha } = await getRepoHead(token, owner, repo);
	const [lockCsv, historyCsv, configText] = await Promise.all([
		getRepoFile(token, owner, repo, LOCK_PATH, sha),
		getRepoFile(token, owner, repo, HISTORY_PATH, sha),
		getRepoFile(token, owner, repo, CONFIG_PATH, sha)
	]);
	const now = new Date().toISOString();

	const { kept, removed } = reapLocks({
		locks: parseLockCsv(lockCsv ?? ''),
		staleAfterMinutes: numberFromConfig(configText, 'stale_after_minutes', DEFAULT_STALE_MINUTES),
		now
	});
	if (removed.length === 0) {
		console.log('No stale locks.');
		return;
	}

	const history: HistoryRow[] = removed.map((l) => ({
		timestamp: now,
		task_id: l.task_id,
		subtask_id: l.subtask_id,
		user_id: l.user_id,
		action: 'reap',
		outcome: 'released',
		detail: l.kind
	}));
	await commitFiles(
		token,
		owner,
		repo,
		[
			{ path: LOCK_PATH, content: serializeLockCsv(kept) },
			{ path: HISTORY_PATH, content: appendHistory(historyCsv ?? '', history) }
		],
		`Release ${removed.length} stale lock(s): ${removed.map((l) => l.task_id).join(', ')}`,
		{ baseSha: sha }
	);
	console.log(`Released ${removed.length} stale lock(s).`);
}

async function runReap(): Promise<void> {
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		try {
			await attemptReap();
			return;
		} catch (e) {
			if (i === MAX_ATTEMPTS - 1) throw e;
			console.warn(`Reap raced (attempt ${i + 1}), retrying: ${(e as Error).message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Entry: route by event, then (for PRs) by the operation the changed paths imply
// — lock.csv → claim, state.csv → validation, anything else → encoding. The
// boundary check inside each decision rejects mixed or out-of-bounds PRs.

async function run(): Promise<void> {
	if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
		return runReap();
	}
	if (eventName !== 'pull_request_target') {
		throw new Error(`Unsupported event: ${eventName}`);
	}

	const files = await getPullRequestFiles(token, owner, repo, prNumber);
	const changedPaths = files.map((f) => f.filename);
	if (changedPaths.includes(LOCK_PATH)) return runClaim(files);
	return runSubmit(changedPaths.includes(STATE_PATH) ? 'validation' : 'encoding', files);
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
