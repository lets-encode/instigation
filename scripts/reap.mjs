// Action E shell — stale-lock reaper for a scheduled (cron) run. Reads the lock
// table and the timeout from config.yaml, drops stale locks via the pure
// `reapLocks`, and commits the trimmed table (only if anything changed) with
// optimistic concurrency. See DESIGN.md §5/§6.
//
// Env: GH_TOKEN, BASE_REPO ("owner/repo").

import { parseLocksCsv, serializeLocksCsv } from '../src/lib/campaign-tables.ts';
import { reapLocks } from '../src/lib/campaign-reaper.ts';
import { getRepoFile, getRepoHead, commitFiles } from '../src/lib/forge/github-rest.ts';

const token = process.env.GH_TOKEN;
const [owner, repo] = (process.env.BASE_REPO ?? '').split('/');

const LOCKS_PATH = 'tracking/locks.csv';
const CONFIG_PATH = 'config.yaml';
const DEFAULT_STALE_MINUTES = 120;
const MAX_ATTEMPTS = 3;

// locking.stale_after_minutes from the machine-generated config.yaml (targeted
// read, no YAML dependency — mirrors submit.mjs's pass_threshold read).
function staleAfterMinutesFrom(configText, fallback) {
	const m = /^\s*stale_after_minutes:\s*(\d+)/m.exec(configText ?? '');
	return m ? Number(m[1]) : fallback;
}

async function attempt() {
	const { sha } = await getRepoHead(token, owner, repo);
	const [locksCsv, configText] = await Promise.all([
		getRepoFile(token, owner, repo, LOCKS_PATH, sha),
		getRepoFile(token, owner, repo, CONFIG_PATH, sha)
	]);

	const { kept, removed } = reapLocks({
		locks: parseLocksCsv(locksCsv),
		staleAfterMinutes: staleAfterMinutesFrom(configText, DEFAULT_STALE_MINUTES),
		now: new Date().toISOString()
	});
	if (removed.length === 0) {
		console.log('No stale locks.');
		return;
	}

	await commitFiles(
		token,
		owner,
		repo,
		[{ path: LOCKS_PATH, content: serializeLocksCsv(kept) }],
		`Release ${removed.length} stale lock(s): ${removed.map((l) => l.task_id).join(', ')}`,
		{ baseSha: sha }
	);
	console.log(`Released ${removed.length} stale lock(s).`);
}

async function run() {
	for (let i = 0; i < MAX_ATTEMPTS; i++) {
		try {
			await attempt();
			return;
		} catch (e) {
			if (i === MAX_ATTEMPTS - 1) throw e;
			console.warn(`Reap raced (attempt ${i + 1}), retrying: ${e.message}`);
		}
	}
}

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
