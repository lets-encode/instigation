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
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	parseTaskCsv,
	parseStateCsv,
	parseLockCsv,
	serializeStateCsv,
	serializeLockCsv,
	appendHistory
} from '../src/lib/campaign-tables.ts';
import type { ParsedState, TaskRow, LockRow, HistoryRow } from '../src/lib/campaign-tables.ts';
import { envelopeFromPrBody, envelopeColumns } from '../src/lib/command-envelope.ts';
import type { CommandEnvelope } from '../src/lib/command-envelope.ts';
import { checkClaim } from '../src/lib/campaign-claim.ts';
import { checkEncoding, checkValidation } from '../src/lib/campaign-submit.ts';
import { splicePage } from '../src/lib/mei-page-splice.ts';
import { reapLocks } from '../src/lib/campaign-reaper.ts';
import {
	addedRowFromPatch,
	classifyPullRequest,
	numberFromConfig,
	resolveEncodingTask,
	shouldCleanupSubmission,
	singleCellDiff,
	validationVerdict
} from '../src/lib/coordinator-policy.ts';
import {
	getRepoFile,
	getRepoHead,
	getPullRequestFiles,
	getPullRequestDetails,
	commitFiles,
	commentAndClosePr,
	deleteBranch,
	getGitHubRequestTelemetry
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
const MEI_SCHEMA_SHA256 = 'fa2081b4e0c858e1dcde339b1b733b8e6350212a46c0db50b94cc71bbe68ca4c';

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
		const schema = new Uint8Array(await res.arrayBuffer());
		const digest = createHash('sha256').update(schema).digest('hex');
		if (digest !== MEI_SCHEMA_SHA256) {
			throw new Error(`MEI schema integrity check failed (expected ${MEI_SCHEMA_SHA256}, received ${digest})`);
		}
		const path = join(tmpdir(), 'mei-schema.rng');
		await writeFile(path, schema);
		schemaPath = path;
	}
	const r = spawnSync('xmllint', ['--noout', '--relaxng', schemaPath, '-'], { input: content });
	if (r.status !== 0) console.warn(`MEI machine-check failed:\n${r.stderr}`);
	return r.status === 0;
}

// ---------------------------------------------------------------------------
// Claim (a PR adding one row to lock.csv)

async function attemptClaim(
	changedPaths: string[],
	intent: { task_id: string; subtask_id: string; kind: string } | null,
	envelope: CommandEnvelope | null
): Promise<Verdict & { lock?: LockRow }> {
	const { sha } = await getRepoHead(token, owner, repo);
	const [taskCsv, stateCsv, lockCsv, historyCsv, configText] = await Promise.all([
		getRepoFile(token, owner, repo, TASK_PATH, sha),
		getRepoFile(token, owner, repo, STATE_PATH, sha),
		getRepoFile(token, owner, repo, LOCK_PATH, sha),
		getRepoFile(token, owner, repo, HISTORY_PATH, sha),
		getRepoFile(token, owner, repo, CONFIG_PATH, sha)
	]);
	const now = new Date().toISOString();
	const { kept: locks, removed } = reapLocks({
		locks: parseLockCsv(lockCsv ?? ''),
		staleAfterMinutes: numberFromConfig(configText, 'stale_after_minutes', DEFAULT_STALE_MINUTES),
		now
	});

	const verdict: Verdict & { lock?: LockRow } = intent
		? checkClaim({
				tasks: parseTaskCsv(taskCsv ?? ''),
				state: parseStateCsv(stateCsv ?? ''),
				locks,
				intent,
				author,
				changedPaths,
				now
			})
		: { ok: false, reason: 'malformed_claim' };

	const reapedHistory: HistoryRow[] = removed.map((lock) => ({
		timestamp: now,
		task_id: lock.task_id,
		subtask_id: lock.subtask_id,
		user_id: lock.user_id,
		action: 'reap',
		outcome: 'released',
		detail: lock.kind
	}));
	const history: HistoryRow = {
		timestamp: now,
		task_id: intent?.task_id ?? '',
		subtask_id: intent?.subtask_id ?? '',
		user_id: author,
		action: `claim_${intent?.kind || 'unknown'}`,
		outcome: verdict.ok ? 'accepted' : 'rejected',
		detail: verdict.ok ? '' : verdict.reason!,
		...envelopeColumns(envelope)
	};
	const files: FileChange[] = [
		{ path: HISTORY_PATH, content: appendHistory(historyCsv ?? '', [...reapedHistory, history]) }
	];
	if (verdict.ok || removed.length) {
		files.push({
			path: LOCK_PATH,
			content: serializeLockCsv(verdict.ok ? [...locks, verdict.lock!] : locks)
		});
	}

	const message = verdict.ok
		? `Lock ${verdict.lock!.task_id}${verdict.lock!.subtask_id && '/' + verdict.lock!.subtask_id} for ${author} (${verdict.lock!.kind})`
		: `Reject claim by ${author} (${verdict.reason})`;
	// Non-fast-forward update fails if `main` moved since `sha` → we retry.
	await commitFiles(token, owner, repo, files, message, { baseSha: sha });
	return verdict;
}

async function runClaim(
	files: Awaited<ReturnType<typeof getPullRequestFiles>>,
	envelope: CommandEnvelope | null
): Promise<void> {
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
			verdict = await attemptClaim(changedPaths, intent, envelope);
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
		? `✅ Claim accepted — ${target} locked for ${author} (${verdict.lock!.kind}).`
		: `❌ Claim rejected: \`${verdict.reason}\`. No changes were made.`;
	await commentAndClosePr(token, owner, repo, prNumber, body);
	await cleanupHeadBranch();
}

// ---------------------------------------------------------------------------
// Submission (encoding: the PR edits the task's fragment; validation: the PR
// records a pass/fail in state.csv)

interface SubmitOutcome extends Verdict {
	files: FileChange[];
	message: string;
	history: HistoryRow;
}

async function decideEncoding(
	sha: string,
	tasks: TaskRow[],
	state: ParsedState,
	locks: LockRow[],
	changedPaths: string[],
	envelope: CommandEnvelope | null,
	now: string
): Promise<Omit<SubmitOutcome, 'files' | 'message' | 'history'> & Partial<SubmitOutcome>> {
	const task = resolveEncodingTask({ tasks, locks, changedPaths, envelope, headRef, author });
	if (!task) return { ok: false, reason: 'unknown_task' };

	// A page task (locator `surface-N`) contributes only its page's measures: we
	// splice the fork's page into the base score, leaving other pages as they
	// stand. Whole-file tasks (empty locator) and pre-tasks take the fork verbatim.
	const forkMei = await getRepoFile(token, headOwner, headRepo, task.fragment, headSha);
	let mei = forkMei;
	if (forkMei != null && task.locator.startsWith('surface-')) {
		const baseMei = await getRepoFile(token, owner, repo, task.fragment, sha);
		try {
			mei = baseMei == null ? null : splicePage(baseMei, forkMei, task.locator);
		} catch (err) {
			console.warn(`Page splice failed for ${task.task_id} (${task.locator}): ${(err as Error).message}`);
			mei = null;
		}
	}
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
	const status = validationVerdict(diff.value);
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

	const files: FileChange[] = [
		{ path: STATE_PATH, content: serializeStateCsv(verdict.state) },
		{ path: LOCK_PATH, content: serializeLockCsv(verdict.locks) }
	];
	const message = `Record ${status} validation of ${diff.task_id}/${diff.subtask_id} by ${author}`;

	return { ok: true, history, files, message };
}

// One decide-and-apply pass, pinned to the branch head we read. Throws only if
// the commit races (caller retries); returns the verdict otherwise.
async function attemptSubmit(
	kind: 'encoding' | 'validation',
	changedPaths: string[],
	envelope: CommandEnvelope | null
): Promise<Verdict> {
	const { sha } = await getRepoHead(token, owner, repo);
	const [taskCsv, stateCsv, lockCsv, historyCsv] = await Promise.all([
		getRepoFile(token, owner, repo, TASK_PATH, sha),
		getRepoFile(token, owner, repo, STATE_PATH, sha),
		getRepoFile(token, owner, repo, LOCK_PATH, sha),
		getRepoFile(token, owner, repo, HISTORY_PATH, sha)
	]);
	const tasks = parseTaskCsv(taskCsv ?? '');
	const state = parseStateCsv(stateCsv ?? '');
	const locks = parseLockCsv(lockCsv ?? '');
	const now = new Date().toISOString();

	const outcome =
		kind === 'validation'
			? await decideValidation(sha, state, locks, changedPaths, now)
			: await decideEncoding(sha, tasks, state, locks, changedPaths, envelope, now);

	const history: HistoryRow = {
		...(outcome.history ?? {
			timestamp: now,
			task_id: '',
			subtask_id: '',
			user_id: author,
			action: `submit_${kind}`,
			outcome: 'rejected',
			detail: outcome.reason ?? 'rejected'
		}),
		...envelopeColumns(envelope)
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
	files: Awaited<ReturnType<typeof getPullRequestFiles>>,
	envelope: CommandEnvelope | null
): Promise<void> {
	const changedPaths = files.map((f) => f.filename);

	let verdict: Verdict = { ok: false, reason: 'no_changes' };
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		try {
			verdict = await attemptSubmit(kind, changedPaths, envelope);
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
	if (shouldCleanupSubmission(kind, verdict.ok)) await cleanupHeadBranch();
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

	const details = await getPullRequestDetails(token, owner, repo, prNumber);
	const files = await getPullRequestFiles(token, owner, repo, prNumber, details.changedFiles);
	// The PR body may carry the console command's envelope; treated as data,
	// it feeds the command columns of the history row this run authors.
	const envelope = envelopeFromPrBody(details.body);
	const changedPaths = files.map((f) => f.filename);
	const kind = classifyPullRequest(changedPaths);
	if (kind === 'claim') return runClaim(files, envelope);
	return runSubmit(kind, files, envelope);
}

run()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(() => console.info('[github-api-summary]', getGitHubRequestTelemetry()));
