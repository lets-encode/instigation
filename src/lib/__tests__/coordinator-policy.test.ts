import { test } from 'node:test';
import assert from 'node:assert/strict';

import { findRow, parseLockCsv, parseStateCsv, type LockRow, type TaskRow } from '../campaign-tables.ts';
import { checkValidation } from '../campaign-submit.ts';
import {
	addedRowFromPatch,
	appendedCommentsFromPatch,
	classifyPullRequest,
	touchesCampaignPaths,
	pieceKindForPath,
	resolveEncodingTask,
	resolvedCommentFromPatch,
	shouldCleanupSubmission,
	taskResetFromPatch,
	validationIntentFromPatch,
	validationVerdict
} from '../coordinator-policy.ts';

const STATE_HEADER = ['task_id', 'subtask_id', 'status', 'encoder', 'encoded_at', 'validate_status_1'];

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

test('validation intent is one changed cell in the PR patch (merge-base relative)', () => {
	const patch =
		'@@ -2,2 +2,2 @@\n' +
		' T0001,,validation_required,encoder,t,\n' +
		'-T0001,S0001,validation_required,encoder,t,\n' +
		'+T0001,S0001,validation_required,encoder,t,pass';
	assert.deepEqual(validationIntentFromPatch(patch, STATE_HEADER), {
		task_id: 'T0001',
		subtask_id: 'S0001',
		column: 'validate_status_1',
		value: 'pass'
	});

	// Two changed cells in one row are not a verdict.
	assert.equal(
		validationIntentFromPatch(
			'@@\n-T0001,S0001,validation_required,encoder,t,\n+T0001,S0001,completed,encoder,t,pass',
			STATE_HEADER
		),
		null
	);
	// Two changed rows are not a verdict.
	assert.equal(
		validationIntentFromPatch(
			'@@\n-T0001,,validation_required,encoder,t,\n-T0001,S0001,validation_required,encoder,t,\n' +
				'+T0001,,completed,encoder,t,\n+T0001,S0001,validation_required,encoder,t,pass',
			STATE_HEADER
		),
		null
	);
	// A row addition or removal is not a verdict.
	assert.equal(validationIntentFromPatch('@@\n+T0002,S0001,validation_required,,,pass', STATE_HEADER), null);
	assert.equal(validationIntentFromPatch(undefined, STATE_HEADER), null);
});

test('a verdict intent re-applies to tables that moved after the PR was opened', () => {
	// The PR set validate_status_1 against its merge base, but another
	// validator's verdict landed there since: checkValidation re-slots the
	// intent into the next open cell instead of rejecting the PR as malformed.
	const header = [...STATE_HEADER, 'validate_status_2'];
	const patch =
		'@@\n' +
		'-T0001,S0001,validation_required,,,,\n' +
		'+T0001,S0001,validation_required,,,pass,';
	const intent = validationIntentFromPatch(patch, header);
	assert.deepEqual(intent, { task_id: 'T0001', subtask_id: 'S0001', column: 'validate_status_1', value: 'pass' });

	const fresh = parseStateCsv(
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n' +
			'T0001,,validation_required,bob,t,,\n' +
			'T0001,S0001,validation_required,,,pass|dave|t,\n'
	);
	const locks = parseLockCsv('task_id,subtask_id,user_id,timestamp,kind\nT0001,S0001,carol,t,validation\n');
	const v = checkValidation({
		state: fresh,
		locks,
		intent: { task_id: intent!.task_id, subtask_id: intent!.subtask_id, verdict: intent!.value },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 2,
		failComment: null,
		now: '2026-06-25T10:00:00Z'
	});
	assert.equal(v.ok, true);
	if (v.ok) {
		assert.equal(findRow(v.state.rows, 'T0001', 'S0001')!.validate_status_2, 'pass|carol|2026-06-25T10:00:00Z');
	}
});

test('validation verdicts are exact, not pass/fail prefixes', () => {
	assert.equal(validationVerdict('pass'), 'pass');
	assert.equal(validationVerdict('fail'), 'fail');
	assert.equal(validationVerdict('passing'), null);
	assert.equal(validationVerdict('fail|user|time'), null);
});

test('pull requests are classified by their mutation table', () => {
	assert.equal(touchesCampaignPaths(['README.md', 'docs/x.md']), false);
	assert.equal(touchesCampaignPaths(['README.md', 'sources/piece-1/score.mei']), true);
	assert.equal(classifyPullRequest(['tracking/lock.csv']), 'claim');
	assert.equal(classifyPullRequest(['tracking/state.csv']), 'validation');
	assert.equal(classifyPullRequest(['sources/score.mei']), 'encoding');
	assert.equal(classifyPullRequest(['sources/score.mei', 'tracking/lock.csv']), 'claim');
	assert.equal(classifyPullRequest(['tracking/comment.csv']), 'comment');
	// A fail validation carries its comment in the same PR — still a validation.
	assert.equal(classifyPullRequest(['tracking/state.csv', 'tracking/comment.csv']), 'validation');
});

test('a send-back patch reads as the reset of exactly one task', () => {
	const resetPatch =
		'@@ -2,3 +2,3 @@\n' +
		'-T0001,,validation_required,encoder,t,\n' +
		'-T0001,S0001,validation_required,,,fail|carol|t\n' +
		'+T0001,,encoding_required,,,\n' +
		'+T0001,S0001,pending,,,\n' +
		' T0002,,encoding_required,,,\n';
	assert.deepEqual(taskResetFromPatch(resetPatch, STATE_HEADER, ['validate_status_1']), { task_id: 'T0001' });
	// A reset that also touches another task is not a send-back.
	assert.equal(
		taskResetFromPatch(
			resetPatch.replace(' T0002', '-T0002').replace(/$/, '+T0002,,completed,,,\n'),
			STATE_HEADER,
			['validate_status_1']
		),
		null
	);
	// A "reset" that keeps the encoder is malformed.
	assert.equal(
		taskResetFromPatch(
			resetPatch.replace('+T0001,,encoding_required,,,', '+T0001,,encoding_required,encoder,,'),
			STATE_HEADER,
			['validate_status_1']
		),
		null
	);
	// A single-cell verdict is not a reset.
	assert.equal(
		taskResetFromPatch(
			'@@\n-T0001,S0001,validation_required,,,\n+T0001,S0001,validation_required,,,pass',
			STATE_HEADER,
			['validate_status_1']
		),
		null
	);
	assert.equal(taskResetFromPatch(undefined, STATE_HEADER, ['validate_status_1']), null);
});

test('a comment patch is a pure append or a set of resolve flips', () => {
	// One appended row; the base rows show up only as context.
	const added = appendedCommentsFromPatch(
		'@@ -1,2 +1,3 @@\n c1,T0001,S0001,question,,,,carol,t1,,,Question?\n+,T0001,,addition,,,,me,,,,A note'
	);
	assert.equal(added?.length, 1);
	assert.equal(added?.[0].kind, 'addition');
	assert.equal(added?.[0].body, 'A note');
	// A quoted body spanning several patch lines is one appended row.
	const multiline = appendedCommentsFromPatch('@@\n+,T0001,,question,,,,me,,,,"line 1\n+line 2"');
	assert.equal(multiline?.length, 1);
	assert.equal(multiline?.[0].body, 'line 1\nline 2');
	// Rewriting an existing row is not an append.
	assert.equal(
		appendedCommentsFromPatch('@@\n-c1,T0001,S0001,question,,,,carol,t1,,,Question?\n+c1,T0001,S0001,question,,,,carol,t1,,,Edited'),
		null
	);
	assert.equal(appendedCommentsFromPatch(undefined), null);
});

test('a resolve patch flips resolved on one top-level comment (replies may ride along)', () => {
	const c1 = 'c1,T0001,S0001,question,,,,carol,t1,,,Question?';
	const c1Resolved = 'c1,T0001,S0001,question,,,,carol,t1,true,,Question?';
	const reply = 'c2,T0001,S0001,reply,,,,dave,t2,,c1,An answer';
	const replyResolved = 'c2,T0001,S0001,reply,,,,dave,t2,true,c1,An answer';

	assert.deepEqual(resolvedCommentFromPatch(`@@\n-${c1}\n+${c1Resolved}`), { comment_id: 'c1' });
	// The console flips the root and its replies together — the root is the intent.
	assert.deepEqual(
		resolvedCommentFromPatch(`@@\n-${c1}\n-${reply}\n+${c1Resolved}\n+${replyResolved}`),
		{ comment_id: 'c1' }
	);
	// Any other edit alongside the flip is rejected.
	assert.equal(
		resolvedCommentFromPatch(`@@\n-${c1}\n+c1,T0001,S0001,question,,,,carol,t1,true,,Edited`),
		null
	);
	// Two top-level flips carry no single intent.
	const c3 = 'c3,T0001,,addition,,,,erin,t3,,,A note';
	const c3Resolved = 'c3,T0001,,addition,,,,erin,t3,true,,A note';
	assert.equal(resolvedCommentFromPatch(`@@\n-${c1}\n-${c3}\n+${c1Resolved}\n+${c3Resolved}`), null);
	// A reply-only flip has no top-level intent.
	assert.equal(resolvedCommentFromPatch(`@@\n-${reply}\n+${replyResolved}`), null);
	assert.equal(resolvedCommentFromPatch(undefined), null);
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
