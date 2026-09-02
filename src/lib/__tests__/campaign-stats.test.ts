import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskCsv, parseStateCsv, parseLockCsv, parseCommentCsv } from '../campaign-tables.ts';
import {
	attentionCount,
	commentsOnMyWork,
	isNearlyDone,
	loadAllCampaignStats,
	myTasksIn,
	nextTask,
	readyCount,
	validationReadyCount
} from '../campaign-stats.ts';
import type { CampaignStats } from '../campaign-stats.ts';
import { RateLimitError } from '../forge/github-rest.ts';
import type { RepoSummary } from '../forge/github-rest.ts';
import type { ForgeClient } from '../forge/types.ts';

const STATE_HEADER = 'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n';
const TASK_HEADER = 'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n';
const LOCK_HEADER = 'task_id,subtask_id,user_id,timestamp,kind\n';
const COMMENT_HEADER =
	'comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n';

const taskDefs = parseTaskCsv(
	TASK_HEADER +
		'T0001,,sources/a.mei,surface-1,,,\n' +
		'T0001,S0001,sources/a.mei,surface-1,,,\n' +
		'T0002,,sources/a.mei,surface-2,,,T0001\n' +
		'T0002,S0001,sources/a.mei,surface-2,,,\n' +
		'T0003,,sources/a.mei,surface-3,,,\n' +
		'T0003,S0001,sources/a.mei,surface-3,,,\n' +
		'T0004,,sources/a.mei,surface-4,,,\n' +
		'T0004,S0001,sources/a.mei,surface-4,,,\n'
);
// T0001 open · T0002 blocked by it · T0003 encoded by 7 with one fail ·
// T0004 encoded by 7, one pass, awaiting the second.
const state = parseStateCsv(
	STATE_HEADER +
		'T0001,,encoding_required,,,,\n' +
		'T0001,S0001,pending,,,,\n' +
		'T0002,,encoding_required,,,,\n' +
		'T0002,S0001,pending,,,,\n' +
		'T0003,,validation_required,7,2026-07-30T10:00:00Z,,\n' +
		'T0003,S0001,validation_required,,,fail|9|2026-07-31T08:00:00Z,\n' +
		'T0004,,validation_required,7,2026-07-29T10:00:00Z,,\n' +
		'T0004,S0001,validation_required,,,pass|9|2026-07-30T08:00:00Z,\n'
);
const locks = parseLockCsv(LOCK_HEADER + 'T0001,,7,2026-08-01T10:00:00Z,encoding\n');
const comments = parseCommentCsv(
	COMMENT_HEADER +
		'c1,T0003,S0001,fail,3,24,31,9,2026-07-31T08:00:00Z,,,Slurs missing\n' +
		'c2,T0004,,question,4,40,,9,2026-08-01T09:00:00Z,,,Ossia staff?\n' +
		'c3,T0004,,reply,,,,7,2026-08-01T10:00:00Z,,c2,Yes on purpose\n'
);

const stats: CampaignStats = {
	repoId: 1,
	owner: 'lisa',
	repo: 'fledermaus',
	name: 'fledermaus',
	isPrivate: false,
	title: 'Die Fledermaus',
	composer: '',
	pages: 4,
	done: 0,
	total: 4,
	ready: 0,
	toValidate: 0,
	nearlyDone: false,
	contributorIds: [],
	logins: { '7': 'lisa', '9': 'tcrane' },
	lastActivity: '',
	createdAt: '',
	staleAfterMinutes: 120,
	allowSelfValidation: false,
	pieceNames: {},
	taskDefs,
	rows: state.rows,
	validationColumns: state.validationColumns,
	locks,
	history: [],
	comments,
	passThreshold: 2
};

test('readyCount: locked and blocked tasks are not claimable', () => {
	// T0001 is locked, T0002 blocked by it, T0003/T0004 already encoded.
	assert.equal(readyCount({ taskDefs, rows: state.rows, locks }), 0);
	// Without the lock, only T0001 opens up (T0002 stays blocked).
	assert.equal(readyCount({ taskDefs, rows: state.rows, locks: [] }), 1);
});

test('validationReadyCount: tasks with an undecided, unlocked validation slot', () => {
	// T0003 and T0004 each have one verdict and one open slot.
	const d = { rows: state.rows, validationColumns: state.validationColumns, locks };
	assert.equal(validationReadyCount(d), 2);
	// A validation lock on T0004's remaining slot takes it out of the count.
	const reviewing = parseLockCsv(LOCK_HEADER + 'T0004,S0001,9,2026-08-01T10:00:00Z,validation\n');
	assert.equal(validationReadyCount({ ...d, locks: reviewing }), 1);
});

test('isNearlyDone: from 80% up, but never when finished', () => {
	assert.equal(isNearlyDone(10, 12), true);
	assert.equal(isNearlyDone(7, 12), false);
	assert.equal(isNearlyDone(12, 12), false);
	assert.equal(isNearlyDone(0, 0), false);
});

test('attentionCount: tasks whose validation records a fail', () => {
	// Only T0003 carries a fail; T0004 has a pass and an open slot.
	assert.equal(attentionCount(stats), 1);
	const clean = {
		...stats,
		rows: stats.rows.map((r) => ({ ...r, validate_status_1: '' }))
	};
	assert.equal(attentionCount(clean), 0);
});

test("myTasksIn groups the viewer's tasks by what needs doing", () => {
	const mine = myTasksIn(stats, '7');
	const byGroup = Object.fromEntries(mine.map((t) => [t.group, t]));
	// The held claim → encoding, with the reaper-derived expiry.
	assert.equal(byGroup.encoding.task, 'T0001');
	assert.equal(byGroup.encoding.claimedAt, '2026-08-01T10:00:00Z');
	assert.equal(byGroup.encoding.expiresAt, '2026-08-01T12:00:00.000Z');
	// The failed encoding → fix requested, quoting the validator's comment.
	assert.equal(byGroup.fix.task, 'T0003');
	assert.equal(byGroup.fix.failComment?.body, 'Slurs missing');
	// The passing encoding → awaiting validation with its dots.
	assert.equal(byGroup.awaiting.task, 'T0004');
	assert.equal(byGroup.awaiting.passes, 1);
	assert.deepEqual(byGroup.awaiting.dots, ['pass', 'open']);
	assert.equal(myTasksIn(stats, '').length, 0);
});

test('myTasksIn includes held validation claims with the reaper-derived expiry', () => {
	const reviewing = {
		...stats,
		locks: parseLockCsv(LOCK_HEADER + 'T0003,S0001,9,2026-08-01T10:00:00Z,validation\n')
	};
	const mine = myTasksIn(reviewing, '9');
	const validating = mine.find((t) => t.group === 'validating');
	assert.equal(validating?.task, 'T0003');
	assert.equal(validating?.claimedAt, '2026-08-01T10:00:00Z');
	assert.equal(validating?.expiresAt, '2026-08-01T12:00:00.000Z');
});

test('nextTask: an open validation slot the viewer may take → review', () => {
	// T0001 is locked, T0002 blocked; T0003 is the first open review slot.
	const next = nextTask(stats, '5');
	assert.equal(next?.task, 'T0003');
	assert.equal(next?.action, 'review');
	assert.equal(next?.subtask, 'S0001');
	assert.equal(next?.title, 'a · p. 3');
	assert.equal(next?.kind, 'validation');
});

test('nextTask: an unclaimed, unblocked encoding task → encode', () => {
	const unlocked = { ...stats, locks: [] };
	const next = nextTask(unlocked, '5');
	assert.equal(next?.task, 'T0001');
	assert.equal(next?.action, 'encode');
	assert.equal(next?.pre, false);
	assert.equal(next?.kind, 'encoding');
});

test("nextTask: work the viewer already holds → continue, not a claim", () => {
	// 7 holds T0001's encoding claim.
	const next = nextTask(stats, '7');
	assert.equal(next?.task, 'T0001');
	assert.equal(next?.action, 'continue');
	assert.equal(next?.kind, 'encoding');
	// A held validation claim reads as validation.
	const reviewing = {
		...stats,
		locks: parseLockCsv(
			LOCK_HEADER +
				'T0001,,7,2026-08-01T10:00:00Z,encoding\n' +
				'T0003,S0001,9,2026-08-01T10:00:00Z,validation\n'
		)
	};
	assert.equal(nextTask(reviewing, '9')?.kind, 'validation');
});

test('nextTask: tasks open only to others show without an action', () => {
	// 9 already recorded verdicts on T0003 and T0004 and may not validate again.
	const next = nextTask(stats, '9');
	assert.equal(next?.task, 'T0003');
	assert.equal(next?.action, '');
	// With self-validation allowed, the slot opens up for 9 again.
	const selfOk = { ...stats, allowSelfValidation: true };
	assert.equal(nextTask(selfOk, '9')?.action, 'review');
});

test('nextTask: logged out, the first task open to anyone, without an action', () => {
	const next = nextTask(stats, '');
	assert.equal(next?.task, 'T0003');
	assert.equal(next?.action, '');
	assert.equal(next?.kind, 'validation');
});

test('nextTask: nothing open → null', () => {
	const finished = {
		...stats,
		rows: stats.rows.map((r) => ({ ...r, status: 'completed' })),
		locks: []
	};
	assert.equal(nextTask(finished, '5'), null);
	assert.equal(nextTask(finished, ''), null);
});

// A minimal forge for the listing loader: a topic search result plus a
// per-repo file reader. Repo ids must be unique per test — loadCampaignStats
// caches by id for the session.
const summary = (id: number, name: string): RepoSummary => ({
	id,
	full_name: `o/${name}`,
	name,
	owner: 'o',
	html_url: `https://github.com/o/${name}`,
	private: false,
	description: null,
	updated_at: '',
	created_at: ''
});
const fakeForge = (
	repos: RepoSummary[],
	getRepoFile: (owner: string, repo: string, path: string) => Promise<string | null>
): ForgeClient =>
	({
		searchReposByTopic: async () => repos,
		getRepoFile,
		getUserLogin: async () => null
	}) as unknown as ForgeClient;

const rateLimit = () =>
	new RateLimitError({
		source: 'github',
		resource: 'core',
		limit: 60,
		remaining: 0,
		used: 60,
		resetAt: null,
		retryAfterSeconds: null
	});

test('loadAllCampaignStats: one unreadable repository is skipped but reported', async () => {
	const f = fakeForge([summary(9101, 'ok'), summary(9102, 'broken')], async (_o, repo) => {
		if (repo === 'broken') throw new Error('boom');
		return null;
	});
	const listing = await loadAllCampaignStats(f, 'topic');
	assert.deepEqual(
		listing.stats.map((s) => s.name),
		['ok']
	);
	assert.equal(listing.failed, 1);
	assert.equal(listing.failureMessage, 'boom');
});

test('loadAllCampaignStats: every repository failing throws instead of listing nothing', async () => {
	const f = fakeForge([summary(9201, 'a'), summary(9202, 'b')], async () => {
		throw rateLimit();
	});
	await assert.rejects(loadAllCampaignStats(f, 'topic'), RateLimitError);
});

test('the campaign slug comes from config campaign.name, not the repo name', async () => {
	const files: Record<string, string> = {
		'tracking/task.csv': TASK_HEADER,
		'tracking/state.csv': STATE_HEADER,
		'tracking/lock.csv': LOCK_HEADER,
		'tracking/history.csv': '',
		'tracking/comment.csv': COMMENT_HEADER,
		'config.yaml': 'campaign:\n  name: "stable-slug"\n  title: "A Title"\n'
	};
	const f = fakeForge([summary(9301, 'renamed-repo')], async (_o, _r, path) => files[path] ?? null);
	const listing = await loadAllCampaignStats(f, 'topic');
	assert.equal(listing.stats[0].name, 'stable-slug');
	// Without a config, the repo name is the fallback.
	const bare = fakeForge([summary(9302, 'bare-repo')], async () => null);
	assert.equal((await loadAllCampaignStats(bare, 'topic')).stats[0].name, 'bare-repo');
});

test('loadAllCampaignStats: an empty search result is not an error', async () => {
	const f = fakeForge([], async () => null);
	assert.deepEqual(await loadAllCampaignStats(f, 'topic'), {
		stats: [],
		failed: 0,
		failureMessage: ''
	});
});

test("commentsOnMyWork: others' comments on the viewer's encodings, not their own", () => {
	const feed = commentsOnMyWork(stats, '7');
	assert.deepEqual(
		feed.map((f) => f.comment.comment_id),
		['c1', 'c2']
	);
	assert.equal(feed[0].campaignSlug, 'fledermaus');
	assert.equal(feed[1].taskTitle, 'a · p. 4');
});
