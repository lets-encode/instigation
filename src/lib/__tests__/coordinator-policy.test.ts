import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStateCsv, type LockRow, type TaskRow } from '../campaign-tables.ts';
import {
	addedRowFromPatch,
	classifyPullRequest,
	numberFromConfig,
	resolveEncodingTask,
	shouldCleanupSubmission,
	singleCellDiff,
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

test('numeric config reads use the configured value or the supplied fallback', () => {
	assert.equal(numberFromConfig('validation:\n  pass_threshold: 2\n', 'pass_threshold', 1), 2);
	assert.equal(numberFromConfig(null, 'pass_threshold', 3), 3);
});
