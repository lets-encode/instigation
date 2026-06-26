// Action B shell — claim (lock) handling for a `pull_request_target` run.
//
// Runs in the BASE (campaign) repo's context with a write token. The pull
// request is treated purely as DATA: we read its changed-file patch via the
// API and never check out or execute anything the fork supplies. The actual
// decision is the pure `checkClaim`; this shell only does the GitHub I/O.
//
// Invoked by the campaign repo's .github/workflows/claim.yml after it checks
// this (central) repo out at a pinned ref, as:  node central/scripts/claim.mjs
//
// Env: GH_TOKEN, BASE_REPO ("owner/repo"), PR_NUMBER, PR_AUTHOR.

import { parseStateCsv, parseLocksCsv, serializeLocksCsv } from '../src/lib/server/campaign-tables.js';
import { checkClaim } from '../src/lib/server/campaign-claim.js';
import {
	getRepoFile,
	getRepoHead,
	getPullRequestFiles,
	commitFiles,
	commentAndClosePr
} from '../src/lib/server/github.js';

const token = process.env.GH_TOKEN;
const [owner, repo] = (process.env.BASE_REPO ?? '').split('/');
const prNumber = Number(process.env.PR_NUMBER);
const author = process.env.PR_AUTHOR;

const STATE_PATH = 'tracking/state.csv';
const LOCKS_PATH = 'tracking/locks.csv';
const MAX_ATTEMPTS = 3;

// Pull the single added line out of a unified-diff patch. Returns null unless
// exactly one line was added and none removed — a claim adds one lock row.
function addedRowFromPatch(patch) {
	if (!patch) return null;
	const added = [];
	let removed = 0;
	for (const line of patch.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('---')) continue;
		if (line.startsWith('+')) added.push(line.slice(1));
		else if (line.startsWith('-')) removed++;
	}
	return removed === 0 && added.length === 1 ? added[0] : null;
}

// Read the PR's intent: the task_id and kind from the row it adds to locks.csv.
async function readIntent() {
	const files = await getPullRequestFiles(token, owner, repo, prNumber);
	const changedPaths = files.map((f) => f.filename);
	const locksFile = files.find((f) => f.filename === LOCKS_PATH);
	const addedRow = locksFile && addedRowFromPatch(locksFile.patch);
	if (!addedRow) return { changedPaths, intent: null };
	const cells = addedRow.split(',');
	return { changedPaths, intent: { task_id: cells[0]?.trim(), kind: cells[3]?.trim() } };
}

// One decide-and-apply pass, pinned to the branch head we read. Returns the
// verdict; throws only if applying the commit races (caller retries).
async function attempt(changedPaths, intent) {
	const { sha } = await getRepoHead(token, owner, repo);
	const [stateCsv, locksCsv] = await Promise.all([
		getRepoFile(token, owner, repo, STATE_PATH, sha),
		getRepoFile(token, owner, repo, LOCKS_PATH, sha)
	]);

	const verdict = checkClaim({
		tasks: parseStateCsv(stateCsv),
		locks: parseLocksCsv(locksCsv),
		intent,
		author,
		changedPaths,
		now: new Date().toISOString()
	});
	if (!verdict.ok) return verdict;

	const nextLocks = serializeLocksCsv([...parseLocksCsv(locksCsv), verdict.lock]);
	// Non-fast-forward update fails if `main` moved since `sha` → we retry.
	await commitFiles(
		token,
		owner,
		repo,
		[{ path: LOCKS_PATH, content: nextLocks }],
		`Lock ${verdict.lock.task_id} for ${author} (${verdict.lock.kind})`,
		{ baseSha: sha }
	);
	return verdict;
}

async function run() {
	const { changedPaths, intent } = await readIntent();

	let verdict = { ok: false, reason: 'malformed_claim' };
	if (intent) {
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			try {
				verdict = await attempt(changedPaths, intent);
				break;
			} catch (e) {
				if (i === MAX_ATTEMPTS - 1) throw e;
				console.warn(`Apply raced (attempt ${i + 1}), retrying: ${e.message}`);
			}
		}
	}

	const body = verdict.ok
		? `✅ Claim accepted — \`${verdict.lock.task_id}\` locked for @${author} (${verdict.lock.kind}).`
		: `❌ Claim rejected: \`${verdict.reason}\`. No changes were made.`;
	await commentAndClosePr(token, owner, repo, prNumber, body);
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
