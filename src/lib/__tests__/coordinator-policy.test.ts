import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommentCsv, parseStateCsv, type CommentRow, type LockRow, type TaskRow } from '../campaign-tables.ts';
import {
	addedRowFromPatch,
	appendedComments,
	classifyPullRequest,
	numberFromConfig,
	pieceKindForPath,
	resolveEncodingTask,
	resolvedCommentDiff,
	shouldCleanupSubmission,
	singleCellDiff,
	taskResetDiff,
	validationVerdict
} from '../coordinator-policy.ts';

const stateCsv =
	'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
	'T0001,,validation_required,encoder,2026-01-01T00:00:00.000Z,\n' +
	'T0001,S0001,validation_required,encoder,2026-01-01T00:00:00.000Z,\n';

test('claim intent accepts exactly one added row and no removals', () => {
	assert.equal(
		addedRowFromPatch(
			'--- a/tracking/lock.csv\n+++ b/tracking/lock.csv\n@@ -1 +1,2 @@\n context\n+T0001,,user,time,encoding'
		),
		'T0001,,user,time,encoding'
	);
	assert.equal(addedRowFromPatch('@@\n+one\n+two'), null);
	assert.equal(addedRowFromPatch('@@\n-old\n+new'), null);
	assert.equal(addedRowFromPatch(undefined), null);
});

test('validation intent requires one cell change with the table structure intact', () => {
	const base = parseStateCsv(stateCsv);
	const head = parseStateCsv(stateCsv.replace(
		'T0001,S0001,validation_required,encoder,2026-01-01T00:00:00.000Z,',
		'T0001,S0001,validation_required,encoder,2026-01-01T00:00:00.000Z,pass'
	));

	assert.deepEqual(singleCellDiff(base, head), {
		task_id: 'T0001',
		subtask_id: 'S0001',
		column: 'validate_status_1',
		value: 'pass'
	});

	const missingRow = parseStateCsv(stateCsv.split('\n').slice(0, -2).join('\n') + '\n');
	assert.equal(singleCellDiff(base, missingRow), null);

	const changedHeader = parseStateCsv(stateCsv.replace('validate_status_1', 'validate_status_2'));
	assert.equal(singleCellDiff(base, changedHeader), null);
});

test('validation verdicts are exact, not pass/fail prefixes', () => {
	assert.equal(validationVerdict('pass'), 'pass');
	assert.equal(validationVerdict('fail'), 'fail');
	assert.equal(validationVerdict('passing'), null);
	assert.equal(validationVerdict('fail|user|time'), null);
});

test('pull requests are classified by their mutation table', () => {
	assert.equal(classifyPullRequest(['tracking/lock.csv']), 'claim');
	assert.equal(classifyPullRequest(['tracking/state.csv']), 'validation');
	assert.equal(classifyPullRequest(['sources/score.mei']), 'encoding');
	assert.equal(classifyPullRequest(['sources/score.mei', 'tracking/lock.csv']), 'claim');
	assert.equal(classifyPullRequest(['tracking/comment.csv']), 'comment');
	// A fail validation carries its comment in the same PR — still a validation.
	assert.equal(classifyPullRequest(['tracking/state.csv', 'tracking/comment.csv']), 'validation');
});

test('a send-back PR reads as the reset of exactly one task', () => {
	const failedCsv =
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
		'T0001,,validation_required,encoder,t,\n' +
		'T0001,S0001,validation_required,,,fail|carol|t\n' +
		'T0002,,encoding_required,,,\n';
	const resetCsv =
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
		'T0001,,encoding_required,,,\n' +
		'T0001,S0001,pending,,,\n' +
		'T0002,,encoding_required,,,\n';
	const base = parseStateCsv(failedCsv);
	assert.deepEqual(taskResetDiff(base, parseStateCsv(resetCsv)), { task_id: 'T0001' });
	// No change at all is not a reset.
	assert.equal(taskResetDiff(base, parseStateCsv(failedCsv)), null);
	// A reset that also touches another task is not a send-back.
	assert.equal(
		taskResetDiff(base, parseStateCsv(resetCsv.replace('T0002,,encoding_required', 'T0002,,completed'))),
		null
	);
	// A "reset" that keeps the encoder is malformed.
	assert.equal(
		taskResetDiff(base, parseStateCsv(resetCsv.replace('T0001,,encoding_required,,,', 'T0001,,encoding_required,encoder,,'))),
		null
	);
	// A single-cell verdict is not a reset.
	assert.equal(
		taskResetDiff(base, parseStateCsv(failedCsv.replace('T0002,,encoding_required', 'T0002,,completed'))),
		null
	);
});

const COMMENT_HEADER =
	'comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n';
const c1 = 'c1,T0001,S0001,question,,,,carol,t1,,,Question?\n';

test('a comment PR is a verbatim append or a single resolve flip', () => {
	const base = parseCommentCsv(COMMENT_HEADER + c1);
	const appended = parseCommentCsv(COMMENT_HEADER + c1 + ',T0001,,addition,,,,me,,,,A note\n');
	const added = appendedComments(base, appended);
	assert.equal(added?.length, 1);
	assert.equal(added?.[0].body, 'A note');
	// Rewriting an existing row is not an append.
	assert.equal(
		appendedComments(base, parseCommentCsv(COMMENT_HEADER + c1.replace('Question?', 'Edited') + ',T0001,,addition,,,,me,,,,x\n')),
		null
	);
	assert.equal(appendedComments(base, base), null);

	const resolved = parseCommentCsv(COMMENT_HEADER + c1.replace(',t1,,,', ',t1,true,,'));
	assert.deepEqual(resolvedCommentDiff(base, resolved), { comment_id: 'c1' });
	// Any other edit alongside the flip is rejected.
	assert.equal(
		resolvedCommentDiff(base, parseCommentCsv(COMMENT_HEADER + c1.replace(',t1,,,Question?', ',t1,true,,Edited'))),
		null
	);
	assert.equal(resolvedCommentDiff(base, base), null);
});

test('rejected encoding branches are retained for correction', () => {
	assert.equal(shouldCleanupSubmission('encoding', false), false);
	assert.equal(shouldCleanupSubmission('encoding', true), true);
	assert.equal(shouldCleanupSubmission('validation', false), true);
});

test('shared-fragment encoding tasks resolve by envelope, branch, or one active lock', () => {
	const tasks: TaskRow[] = [
		{ task_id: 'P0001', subtask_id: '', fragment: 'sources/score.mei', locator: '', allowlist: '', blocklist: '', depends_on: '' },
		{ task_id: 'T0001', subtask_id: '', fragment: 'sources/score.mei', locator: '', allowlist: '', blocklist: '', depends_on: 'P0001' }
	];
	const base = { tasks, locks: [] as LockRow[], changedPaths: ['sources/score.mei'], author: 'alice' };

	assert.equal(
		resolveEncodingTask({
			...base,
			envelope: {
				command: 'campaign.submitZones',
				version: 2,
				user_id: 'alice',
				timestamp: '2026-01-01T00:00:00.000Z',
				input: { task_id: 'P0001' }
			},
			headRef: 'unrelated'
		})?.task_id,
		'P0001'
	);
	assert.equal(resolveEncodingTask({ ...base, envelope: null, headRef: 'encode-T0001' })?.task_id, 'T0001');
	assert.equal(
		resolveEncodingTask({
			...base,
			locks: [
				{ task_id: 'P0001', subtask_id: '', user_id: 'alice', timestamp: 'now', kind: 'encoding' }
			],
			envelope: null,
			headRef: 'unrelated'
		})?.task_id,
		'P0001'
	);
	assert.equal(resolveEncodingTask({ ...base, envelope: null, headRef: 'unrelated' }), undefined);
});

test('pieceKindForPath reads the piece kind from the canonical config shape', () => {
	const config =
		'pieces:\n' +
		'  - id: "piece-01"\n' +
		'    kind: "facsimile"\n' +
		'    path: "sources/piece-01/score.mei"\n' +
		'    zones: []\n' +
		'  - id: "piece-02"\n' +
		'    kind: "physical-only"\n' +
		'    path: "sources/piece-02/score.mei"\n' +
		'    pages: 3\n' +
		'    zones: []\n';
	assert.equal(pieceKindForPath(config, 'sources/piece-01/score.mei'), 'facsimile');
	assert.equal(pieceKindForPath(config, 'sources/piece-02/score.mei'), 'physical-only');
	assert.equal(pieceKindForPath(config, 'sources/piece-09/score.mei'), null);
	assert.equal(pieceKindForPath(null, 'sources/piece-01/score.mei'), null);
});

test('numeric config reads use the configured value or the supplied fallback', () => {
	assert.equal(numberFromConfig('validation:\n  pass_threshold: 2\n', 'pass_threshold', 1), 2);
	assert.equal(numberFromConfig(null, 'pass_threshold', 3), 3);
});
