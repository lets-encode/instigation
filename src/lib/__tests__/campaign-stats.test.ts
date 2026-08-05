import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskCsv, parseStateCsv, parseLockCsv, parseCommentCsv } from '../campaign-tables.ts';
import {
	commentsOnMyWork,
	isNearlyDone,
	myTasksIn,
	readyCount
} from '../campaign-stats.ts';
import type { CampaignStats } from '../campaign-stats.ts';

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
	nearlyDone: false,
	contributorIds: [],
	logins: { '7': 'lisa', '9': 'tcrane' },
	lastActivity: '',
	createdAt: '',
	staleAfterMinutes: 120,
	preview: null,
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

test('isNearlyDone: from 80% up, but never when finished', () => {
	assert.equal(isNearlyDone(10, 12), true);
	assert.equal(isNearlyDone(7, 12), false);
	assert.equal(isNearlyDone(12, 12), false);
	assert.equal(isNearlyDone(0, 0), false);
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

test("commentsOnMyWork: others' comments on the viewer's encodings, not their own", () => {
	const feed = commentsOnMyWork(stats, '7');
	assert.deepEqual(
		feed.map((f) => f.comment.comment_id),
		['c1', 'c2']
	);
	assert.equal(feed[0].campaignSlug, 'fledermaus');
	assert.equal(feed[1].taskTitle, 'a · p. 4');
});
