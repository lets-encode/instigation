import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskCsv, parseStateCsv, parseLockCsv } from '../campaign-tables.ts';
import type { LockRow } from '../campaign-tables.ts';
import { boundaryCheck, checkClaim } from '../campaign-claim.ts';
import type { CheckClaimArgs } from '../campaign-claim.ts';

// A relaxed view of the claim result for assertions, where the branch-specific
// fields are read directly without narrowing each result.
type ClaimView = { ok: boolean; reason?: string; lock?: LockRow };

const NOW = '2026-06-25T10:00:00Z';
const LOCK_HEADER = 'task_id,subtask_id,user_id,timestamp,kind\n';
const STATE_HEADER = 'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n';
const TASK_HEADER = 'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n';

const TASKS = parseTaskCsv(
	TASK_HEADER + 'T0001,,sources/score.mei,,,,\n' + 'T0001,S0001,sources/score.mei,,,,\n'
);

// State builders for the scenarios under test. Encoding targets the task row
// (empty subtask_id); validation targets the S0001 subtask row.
const encodingRequired = parseStateCsv(STATE_HEADER + 'T0001,,encoding_required,,,\n' + 'T0001,S0001,pending,,,\n');
const validationRequired = parseStateCsv(
	STATE_HEADER + 'T0001,,validation_required,bob,2026-06-25T09:00:00Z,\n' + 'T0001,S0001,validation_required,,,\n'
);
const validationTwoSlots = parseStateCsv(
	'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n' +
		'T0001,,validation_required,bob,2026-06-25T09:00:00Z,,\n' +
		'T0001,S0001,validation_required,,,,\n'
);

const claim = (over: Partial<CheckClaimArgs> = {}): ClaimView =>
	checkClaim({
		tasks: TASKS,
		state: encodingRequired,
		locks: [],
		intent: { task_id: 'T0001', subtask_id: '', kind: 'encoding' },
		author: 'carol',
		changedPaths: ['tracking/lock.csv'],
		now: NOW,
		...over
	});

const validationIntent = { task_id: 'T0001', subtask_id: 'S0001', kind: 'validation' };

test('dependency gate: a claim on a task whose depends_on is not completed is rejected', () => {
	const tasks = parseTaskCsv(
		TASK_HEADER +
			'P0001,,sources/score.mei,measure-zones,,,\n' +
			'P0002,,sources/score.mei,,,,P0001\n'
	);
	const state = parseStateCsv(
		STATE_HEADER + 'P0001,,encoding_required,,,\n' + 'P0002,,encoding_required,,,\n'
	);
	const v = claim({ tasks, state, intent: { task_id: 'P0002', subtask_id: '', kind: 'encoding' } });
	assert.deepEqual(v, { ok: false, reason: 'dependency_incomplete' });
});

test('dependency gate: the claim opens once the depended-on task is completed', () => {
	const tasks = parseTaskCsv(
		TASK_HEADER +
			'P0001,,sources/score.mei,measure-zones,,,\n' +
			'P0002,,sources/score.mei,,,,P0001\n'
	);
	const state = parseStateCsv(
		STATE_HEADER + 'P0001,,completed,alice,2026-06-25T09:00:00Z,\n' + 'P0002,,encoding_required,,,\n'
	);
	const v = claim({ tasks, state, intent: { task_id: 'P0002', subtask_id: '', kind: 'encoding' } });
	assert.equal(v.ok, true);
});

test('boundaryCheck: only allowed paths, and at least one change', () => {
	assert.equal(boundaryCheck(['tracking/lock.csv'], ['tracking/lock.csv']), true);
	assert.equal(boundaryCheck(['sources/score.mei'], ['tracking/lock.csv']), false);
	assert.equal(boundaryCheck([], ['tracking/lock.csv']), false);
});

test('encoding claim on a free task is accepted with an Action-authored lock', () => {
	const v = claim();
	assert.deepEqual(v, {
		ok: true,
		lock: { task_id: 'T0001', subtask_id: '', user_id: 'carol', timestamp: NOW, kind: 'encoding' }
	});
});

test('lock identity comes from the author, never the fork', () => {
	// Even if a fork tried to smuggle a different login, only `author` is used.
	const v = claim({ author: 'dave' });
	assert.equal(v.lock!.user_id, 'dave');
});

test('rejects a PR that strays outside lock.csv', () => {
	assert.deepEqual(claim({ changedPaths: ['tracking/lock.csv', 'sources/score.mei'] }), {
		ok: false,
		reason: 'out_of_bounds'
	});
});

test('rejects an unknown task and an invalid kind', () => {
	assert.equal(claim({ intent: { task_id: 'T9999', subtask_id: '', kind: 'encoding' } }).reason, 'unknown_task');
	assert.equal(claim({ intent: { task_id: 'T0001', subtask_id: '', kind: 'review' } }).reason, 'invalid_kind');
});

test('rejects a claim whose key does not match its kind', () => {
	// Encoding is task-level: a subtask key is invalid.
	assert.equal(
		claim({ intent: { task_id: 'T0001', subtask_id: 'S0001', kind: 'encoding' } }).reason,
		'invalid_target'
	);
	// Validation is subtask-level: the task key is invalid.
	assert.equal(
		claim({ state: validationRequired, intent: { task_id: 'T0001', subtask_id: '', kind: 'validation' } }).reason,
		'invalid_target'
	);
});

test('encoding claim is rejected when already locked', () => {
	const locks = parseLockCsv(LOCK_HEADER + 'T0001,,bob,2026-06-25T09:30:00Z,encoding\n');
	assert.equal(claim({ locks }).reason, 'already_locked');
});

test('encoding claim is rejected in the wrong state', () => {
	assert.equal(claim({ state: validationRequired }).reason, 'wrong_state');
});

test('validation claim on an open subtask by a different person is accepted', () => {
	const v = claim({ state: validationRequired, intent: validationIntent, author: 'carol' });
	assert.equal(v.ok, true);
	assert.equal(v.lock!.kind, 'validation');
	assert.equal(v.lock!.subtask_id, 'S0001');
});

test('validation claim on a pending subtask is rejected (task not yet encoded)', () => {
	const v = claim({ state: encodingRequired, intent: validationIntent, author: 'carol' });
	assert.equal(v.reason, 'wrong_state');
});

test("validation claim by the task's encoder is rejected (no self-validation)", () => {
	const v = claim({ state: validationRequired, intent: validationIntent, author: 'bob' });
	assert.equal(v.reason, 'self_validation');
});

test('validation claim is rejected when the only slot is already a final outcome', () => {
	const state = parseStateCsv(
		STATE_HEADER + 'T0001,,validation_required,bob,t,\n' + 'T0001,S0001,validation_required,,,pass|carol|t\n'
	);
	const v = claim({ state, intent: validationIntent, author: 'dave' });
	assert.equal(v.reason, 'no_open_validation_slot');
});

test('validation claim is rejected when active locks already fill the slots', () => {
	const locks = parseLockCsv(LOCK_HEADER + 'T0001,S0001,carol,t,validation\n');
	const v = claim({ state: validationRequired, locks, intent: validationIntent, author: 'dave' });
	assert.equal(v.reason, 'no_open_validation_slot');
});

test('two-slot subtask: same validator cannot claim twice, a second validator can', () => {
	const locks = parseLockCsv(LOCK_HEADER + 'T0001,S0001,carol,t,validation\n');
	const base = { state: validationTwoSlots, locks, intent: validationIntent };
	assert.equal(claim({ ...base, author: 'carol' }).reason, 'already_locked');
	assert.equal(claim({ ...base, author: 'dave' }).ok, true);
});

test('locks on other subtasks do not block a claim', () => {
	// A validation lock on S0001 is irrelevant to an encoding claim on the task
	// row, and vice versa — the composite key separates them.
	const locks = parseLockCsv(LOCK_HEADER + 'T0001,S0001,carol,t,validation\n');
	assert.equal(claim({ locks }).ok, true);
});
