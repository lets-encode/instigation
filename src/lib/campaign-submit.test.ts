import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskCsv, parseStateCsv, parseLockCsv, serializeStateCsv, serializeLockCsv, findRow } from './campaign-tables.js';
import type { ParsedState, LockRow } from './campaign-tables.js';
import { checkEncoding, checkValidation } from './campaign-submit.js';
import type { CheckEncodingArgs, CheckValidationArgs } from './campaign-submit.js';

// A relaxed view of the submit result for assertions, where the accepted-branch
// fields are read directly without narrowing each result.
type SubmitView = { ok: boolean; reason?: string; state?: ParsedState; locks?: LockRow[] };

const enc = (args: CheckEncodingArgs): SubmitView => checkEncoding(args);
const val = (args: CheckValidationArgs): SubmitView => checkValidation(args);

const NOW = '2026-06-25T10:00:00Z';
const LOCK_HEADER = 'task_id,subtask_id,user_id,timestamp,kind\n';
const STATE_HEADER = 'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n';

const TASKS = parseTaskCsv(
	'task_id,subtask_id,fragment,locator,allowlist,blocklist\n' +
		'T0001,,sources/score.mei,,,\n' +
		'T0001,S0001,sources/score.mei,,,\n'
);

const encodingState = () =>
	parseStateCsv(STATE_HEADER + 'T0001,,encoding_required,,,\n' + 'T0001,S0001,pending,,,\n');
const validationState = () =>
	parseStateCsv(
		STATE_HEADER + 'T0001,,validation_required,bob,2026-06-25T09:00:00Z,\n' + 'T0001,S0001,validation_required,,,\n'
	);
const encodingLock = parseLockCsv(LOCK_HEADER + 'T0001,,bob,2026-06-25T08:00:00Z,encoding\n');
const validationLock = parseLockCsv(LOCK_HEADER + 'T0001,S0001,carol,2026-06-25T09:30:00Z,validation\n');

// --- Encoding submission ---------------------------------------------------

test('encoding: accepted submission advances the task and its subtasks, clears the lock', () => {
	const v = enc({
		tasks: TASKS,
		state: encodingState(),
		locks: encodingLock,
		intent: { task_id: 'T0001' },
		author: 'bob',
		changedPaths: ['sources/score.mei'],
		meiValid: true,
		now: NOW
	});
	assert.equal(v.ok, true);
	assert.equal(
		serializeStateCsv(v.state!),
		STATE_HEADER + `T0001,,validation_required,bob,${NOW},\n` + 'T0001,S0001,validation_required,,,\n'
	);
	assert.equal(serializeLockCsv(v.locks!), LOCK_HEADER);
});

test('encoding: rejects a PR that touches anything but the fragment', () => {
	const v = enc({
		tasks: TASKS,
		state: encodingState(),
		locks: encodingLock,
		intent: { task_id: 'T0001' },
		author: 'bob',
		changedPaths: ['sources/score.mei', 'tracking/state.csv'],
		meiValid: true,
		now: NOW
	});
	assert.deepEqual(v, { ok: false, reason: 'out_of_bounds' });
});

test('encoding: rejects when the author does not hold the encoding lock', () => {
	const v = enc({
		tasks: TASKS,
		state: encodingState(),
		locks: encodingLock, // held by bob
		intent: { task_id: 'T0001' },
		author: 'mallory',
		changedPaths: ['sources/score.mei'],
		meiValid: true,
		now: NOW
	});
	assert.equal(v.reason, 'not_lock_holder');
});

test('encoding: a validation lock is not an encoding lock', () => {
	const locks = parseLockCsv(LOCK_HEADER + 'T0001,S0001,bob,t,validation\n');
	const v = enc({
		tasks: TASKS,
		state: encodingState(),
		locks,
		intent: { task_id: 'T0001' },
		author: 'bob',
		changedPaths: ['sources/score.mei'],
		meiValid: true,
		now: NOW
	});
	assert.equal(v.reason, 'not_lock_holder');
});

test('encoding: rejects invalid MEI and the wrong state', () => {
	const base = {
		tasks: TASKS,
		locks: encodingLock,
		intent: { task_id: 'T0001' },
		author: 'bob',
		changedPaths: ['sources/score.mei'],
		now: NOW
	};
	assert.equal(enc({ ...base, state: encodingState(), meiValid: false }).reason, 'mei_invalid');
	assert.equal(enc({ ...base, state: validationState(), meiValid: true }).reason, 'wrong_state');
});

test('encoding: rejects an unknown task', () => {
	const v = enc({
		tasks: TASKS,
		state: encodingState(),
		locks: encodingLock,
		intent: { task_id: 'T9999' },
		author: 'bob',
		changedPaths: ['sources/score.mei'],
		meiValid: true,
		now: NOW
	});
	assert.equal(v.reason, 'unknown_task');
});

// --- Validation outcome ----------------------------------------------------

test('validation: a pass meeting the threshold completes the subtask AND the task', () => {
	const v = val({
		state: validationState(),
		locks: validationLock,
		intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	assert.equal(v.ok, true);
	assert.equal(
		serializeStateCsv(v.state!),
		STATE_HEADER + 'T0001,,completed,bob,2026-06-25T09:00:00Z,\n' + `T0001,S0001,completed,,,pass|carol|${NOW}\n`
	);
	assert.equal(serializeLockCsv(v.locks!), LOCK_HEADER);
});

test('validation: the task stays open while another subtask is unfinished', () => {
	const state = parseStateCsv(
		STATE_HEADER +
			'T0001,,validation_required,bob,t,\n' +
			'T0001,S0001,validation_required,,,\n' +
			'T0001,S0002,validation_required,,,\n'
	);
	const v = val({
		state,
		locks: validationLock,
		intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	assert.equal(findRow(v.state!.rows, 'T0001', 'S0001')!.status, 'completed');
	assert.equal(findRow(v.state!.rows, 'T0001', 'S0002')!.status, 'validation_required');
	assert.equal(findRow(v.state!.rows, 'T0001', '')!.status, 'validation_required');
});

test('validation: a fail records the cell but does not complete', () => {
	const v = val({
		state: validationState(),
		locks: validationLock,
		intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'fail' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	const row = findRow(v.state!.rows, 'T0001', 'S0001')!;
	assert.equal(row.status, 'validation_required');
	assert.equal(row.validate_status_1, `fail|carol|${NOW}`);
	assert.equal(findRow(v.state!.rows, 'T0001', '')!.status, 'validation_required');
});

test('validation: below threshold stays validation_required, writing the next open slot', () => {
	const state = parseStateCsv(
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\n' +
			'T0001,,validation_required,bob,t,,\n' +
			'T0001,S0001,validation_required,,,,\n'
	);
	const v = val({
		state,
		locks: validationLock,
		intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 2,
		now: NOW
	});
	const row = findRow(v.state!.rows, 'T0001', 'S0001')!;
	assert.equal(row.validate_status_1, `pass|carol|${NOW}`);
	assert.equal(row.validate_status_2, '');
	assert.equal(row.status, 'validation_required');
});

test('validation: rejects an invalid verdict, wrong state, and non-lock-holders', () => {
	const base = {
		locks: validationLock,
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	};
	assert.equal(
		val({ ...base, state: validationState(), intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'maybe' } })
			.reason,
		'invalid_verdict'
	);
	assert.equal(
		val({ ...base, state: encodingState(), intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'pass' } })
			.reason,
		'wrong_state'
	);
	assert.equal(
		val({
			...base,
			state: validationState(),
			author: 'eve',
			intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'pass' }
		}).reason,
		'not_lock_holder'
	);
});

test('validation: rejects the task row as a target', () => {
	const v = val({
		state: validationState(),
		locks: validationLock,
		intent: { task_id: 'T0001', subtask_id: '', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	assert.equal(v.reason, 'unknown_task');
});

test('validation: rejects when no open slot remains', () => {
	const state = parseStateCsv(
		STATE_HEADER + 'T0001,,validation_required,bob,t,\n' + 'T0001,S0001,validation_required,,,fail|dave|t\n'
	);
	const v = val({
		state,
		locks: validationLock,
		intent: { task_id: 'T0001', subtask_id: 'S0001', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	assert.equal(v.reason, 'no_open_validation_slot');
});
