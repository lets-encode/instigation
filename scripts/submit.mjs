// Action C/D shell — submission (encoding or validation) for a
// pull_request_target run. Runs in the BASE (campaign) repo's context, treats
// the PR as data (no fork checkout / no fork code executed), and applies the
// Action-authored result with optimistic concurrency. See DESIGN.md §6.
//
// Env: GH_TOKEN, BASE_REPO ("owner/repo"), PR_NUMBER, PR_AUTHOR,
//      HEAD_REPO ("owner/repo" of the PR head), HEAD_SHA.

import { spawnSync } from 'node:child_process';
import {
	parseStateCsv,
	parseLocksCsv,
	serializeStateCsv,
	serializeLocksCsv
} from '../src/lib/server/campaign-tables.ts';
import { checkEncoding, checkValidation } from '../src/lib/server/campaign-submit.ts';
import {
	getRepoFile,
	getRepoHead,
	getPullRequestFiles,
	commitFiles,
	commentAndClosePr,
	deleteBranch
} from '../src/lib/server/github.ts';

const token = process.env.GH_TOKEN;
const [owner, repo] = (process.env.BASE_REPO ?? '').split('/');
const prNumber = Number(process.env.PR_NUMBER);
const author = process.env.PR_AUTHOR;
const [headOwner, headRepo] = (process.env.HEAD_REPO ?? '').split('/');
const headSha = process.env.HEAD_SHA;
const headRef = process.env.HEAD_REF;

// Delete the PR's head branch once we've closed it — but only when it lives in
// this repo (owner/collaborator PR). A volunteer's branch lives in their fork,
// which this token can't touch; it stays harmlessly in the fork.
async function cleanupHeadBranch() {
	if (headOwner !== owner || headRepo !== repo || !headRef) return;
	try {
		await deleteBranch(token, owner, repo, headRef);
	} catch (e) {
		console.warn(`Branch cleanup skipped: ${e.message}`);
	}
}

const STATE_PATH = 'tracking/state.csv';
const LOCKS_PATH = 'tracking/locks.csv';
const CONFIG_PATH = 'config.yaml';
const MAX_ATTEMPTS = 3;

// Well-formedness via xmllint (reads stdin; exit 0 = well-formed). MEI schema
// validation is a future step — see DESIGN.md §6 / the hardening checklist.
function isWellFormedXml(content) {
	const r = spawnSync('xmllint', ['--noout', '-'], { input: content });
	return r.status === 0;
}

// pass_threshold lives in config.yaml, which the GUI machine-generates in a
// fixed shape — a targeted read avoids pulling in a YAML dependency.
function passThresholdFrom(configText, fallback) {
	const m = /^\s*pass_threshold:\s*(\d+)/m.exec(configText ?? '');
	return m ? Number(m[1]) : fallback;
}

// The single (task_id, column, value) that differs between two parsed state
// tables, or null if not exactly one cell changed. Used to read a validation
// PR's intent (which task, pass/fail) from its proposed state.csv.
function singleCellDiff(base, head) {
	const diffs = [];
	for (const headRow of head.rows) {
		const baseRow = base.rows.find((r) => r.task_id === headRow.task_id);
		if (!baseRow) continue;
		for (const col of head.header) {
			if ((headRow[col] ?? '') !== (baseRow[col] ?? '')) {
				diffs.push({ task_id: headRow.task_id, column: col, value: headRow[col] ?? '' });
			}
		}
	}
	return diffs.length === 1 ? diffs[0] : null;
}

async function applyEncoding(sha, tasks, locks, changedPaths, now) {
	const task = tasks.rows.find((r) => changedPaths.includes(r.fragment));
	if (!task) return { ok: false, reason: 'unknown_task' };

	const mei = await getRepoFile(token, headOwner, headRepo, task.fragment, headSha);
	const verdict = checkEncoding({
		tasks,
		locks,
		intent: { task_id: task.task_id },
		author,
		changedPaths,
		meiValid: mei != null && isWellFormedXml(mei),
		now
	});
	if (!verdict.ok) return verdict;

	await commitFiles(
		token,
		owner,
		repo,
		[
			{ path: task.fragment, content: mei },
			{ path: STATE_PATH, content: serializeStateCsv(verdict.tasks) },
			{ path: LOCKS_PATH, content: serializeLocksCsv(verdict.locks) }
		],
		`Accept encoding of ${task.task_id} by ${author}\n\nCo-authored-by: ${author} <${author}@users.noreply.github.com>`,
		{ baseSha: sha }
	);
	return verdict;
}

async function applyValidation(sha, tasks, locks, changedPaths, now) {
	const headStateCsv = await getRepoFile(token, headOwner, headRepo, STATE_PATH, headSha);
	const diff = headStateCsv == null ? null : singleCellDiff(tasks, parseStateCsv(headStateCsv));
	if (!diff || !tasks.validationColumns.includes(diff.column)) {
		return { ok: false, reason: 'malformed_validation' };
	}
	const status = diff.value.startsWith('pass') ? 'pass' : diff.value.startsWith('fail') ? 'fail' : null;
	if (!status) return { ok: false, reason: 'invalid_verdict' };

	const configText = await getRepoFile(token, owner, repo, CONFIG_PATH, sha);
	const verdict = checkValidation({
		tasks,
		locks,
		intent: { task_id: diff.task_id, verdict: status },
		author,
		changedPaths,
		passThreshold: passThresholdFrom(configText, tasks.validationColumns.length),
		now
	});
	if (!verdict.ok) return verdict;

	await commitFiles(
		token,
		owner,
		repo,
		[
			{ path: STATE_PATH, content: serializeStateCsv(verdict.tasks) },
			{ path: LOCKS_PATH, content: serializeLocksCsv(verdict.locks) }
		],
		`Record ${status} validation of ${diff.task_id} by ${author}`,
		{ baseSha: sha }
	);
	return verdict;
}

// One decide-and-apply pass, pinned to the branch head we read. Throws only if
// the commit races (caller retries); returns the verdict otherwise.
async function attempt(kind, changedPaths) {
	const { sha } = await getRepoHead(token, owner, repo);
	const [stateCsv, locksCsv] = await Promise.all([
		getRepoFile(token, owner, repo, STATE_PATH, sha),
		getRepoFile(token, owner, repo, LOCKS_PATH, sha)
	]);
	const tasks = parseStateCsv(stateCsv);
	const locks = parseLocksCsv(locksCsv);
	const now = new Date().toISOString();

	return kind === 'validation'
		? applyValidation(sha, tasks, locks, changedPaths, now)
		: applyEncoding(sha, tasks, locks, changedPaths, now);
}

async function run() {
	const files = await getPullRequestFiles(token, owner, repo, prNumber);
	const changedPaths = files.map((f) => f.filename);
	// A validation PR edits state.csv; anything else is treated as an encoding
	// (the boundary check inside each verdict rejects mixed/stray changes).
	const kind = changedPaths.includes(STATE_PATH) ? 'validation' : 'encoding';

	let verdict = { ok: false, reason: 'no_changes' };
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		try {
			verdict = await attempt(kind, changedPaths);
			break;
		} catch (e) {
			if (i === MAX_ATTEMPTS - 1) throw e;
			console.warn(`Apply raced (attempt ${i + 1}), retrying: ${e.message}`);
		}
	}

	const body = verdict.ok
		? `✅ Submission accepted (${kind}).`
		: `❌ Submission rejected: \`${verdict.reason}\`. No changes were made.`;
	await commentAndClosePr(token, owner, repo, prNumber, body);
	await cleanupHeadBranch();
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
