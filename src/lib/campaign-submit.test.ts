import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStateCsv, parseLocksCsv, serializeStateCsv, serializeLocksCsv } from './campaign-tables.js';
import type { ParsedState, LockRow } from './campaign-tables.js';
import { checkEncoding, checkValidation } from './campaign-submit.js';
import type { CheckEncodingArgs, CheckValidationArgs } from './campaign-submit.js';

// A relaxed view of the submit result for assertions, where the accepted-branch
// fields are read directly without narrowing each result.
type SubmitView = { ok: boolean; reason?: string; tasks?: ParsedState; locks?: LockRow[] };

const enc = (args: CheckEncodingArgs): SubmitView => checkEncoding(args);
const val = (args: CheckValidationArgs): SubmitView => checkValidation(args);

const NOW = '2026-06-25T10:00:00Z';
const LOCKS_HEADER = 'task_id,locked_by,locked_at,kind\n';

const encodingState = () =>
	parseStateCsv('task_id,fragment,state,encoder,encoded_at,v1\nT0001,sources/score.mei,encoding_required,,,\n');
const validationState = () =>
	parseStateCsv(
		'task_id,fragment,state,encoder,encoded_at,v1\nT0001,sources/score.mei,validation_required,bob,2026-06-25T09:00:00Z,\n'
	);
const encodingLock = parseLocksCsv(LOCKS_HEADER + 'T0001,bob,2026-06-25T08:00:00Z,encoding\n');
const validationLock = parseLocksCsv(LOCKS_HEADER + 'T0001,carol,2026-06-25T09:30:00Z,validation\n');

// --- Encoding submission ---------------------------------------------------

test('encoding: accepted submission advances state and clears the lock', () => {
	const v = enc({
		tasks: encodingState(),
		locks: encodingLock,
		intent: { task_id: 'T0001' },
		author: 'bob',
		changedPaths: ['sources/score.mei'],
		meiValid: true,
		now: NOW
	});
	assert.equal(v.ok, true);
	assert.equal(
		serializeStateCsv(v.tasks!),
		'task_id,fragment,state,encoder,encoded_at,v1\n' +
			`T0001,sources/score.mei,validation_required,bob,${NOW},\n`
	);
	assert.equal(serializeLocksCsv(v.locks!), LOCKS_HEADER);
});

test('encoding: rejects a PR that touches anything but the fragment', () => {
	const v = enc({
		tasks: encodingState(),
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
		tasks: encodingState(),
		locks: encodingLock, // held by bob
		intent: { task_id: 'T0001' },
		author: 'mallory',
		changedPaths: ['sources/score.mei'],
		meiValid: true,
		now: NOW
	});
	assert.equal(v.reason, 'not_lock_holder');
});

test('encoding: rejects invalid MEI and the wrong state', () => {
	const base = {
		locks: encodingLock,
		intent: { task_id: 'T0001' },
		author: 'bob',
		changedPaths: ['sources/score.mei'],
		now: NOW
	};
	assert.equal(enc({ ...base, tasks: encodingState(), meiValid: false }).reason, 'mei_invalid');
	assert.equal(enc({ ...base, tasks: validationState(), meiValid: true }).reason, 'wrong_state');
});

test('encoding: rejects an unknown task', () => {
	const v = enc({
		tasks: encodingState(),
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

test('validation: a pass meeting the threshold completes the task and clears the lock', () => {
	const v = val({
		tasks: validationState(),
		locks: validationLock,
		intent: { task_id: 'T0001', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	assert.equal(v.ok, true);
	assert.equal(
		serializeStateCsv(v.tasks!),
		'task_id,fragment,state,encoder,encoded_at,v1\n' +
			`T0001,sources/score.mei,completed,bob,2026-06-25T09:00:00Z,pass|carol|${NOW}\n`
	);
	assert.equal(serializeLocksCsv(v.locks!), LOCKS_HEADER);
});

test('validation: a fail records the cell but does not complete', () => {
	const v = val({
		tasks: validationState(),
		locks: validationLock,
		intent: { task_id: 'T0001', verdict: 'fail' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	assert.equal(v.tasks!.rows[0].state, 'validation_required');
	assert.equal(v.tasks!.rows[0].v1, `fail|carol|${NOW}`);
});

test('validation: below threshold stays validation_required, writing the next open slot', () => {
	const tasks = parseStateCsv(
		'task_id,fragment,state,encoder,encoded_at,v1,v2\nT0001,sources/score.mei,validation_required,bob,t,,\n'
	);
	const v = val({
		tasks,
		locks: validationLock,
		intent: { task_id: 'T0001', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 2,
		now: NOW
	});
	assert.equal(v.tasks!.rows[0].v1, `pass|carol|${NOW}`);
	assert.equal(v.tasks!.rows[0].v2, '');
	assert.equal(v.tasks!.rows[0].state, 'validation_required');
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
		val({ ...base, tasks: validationState(), intent: { task_id: 'T0001', verdict: 'maybe' } }).reason,
		'invalid_verdict'
	);
	assert.equal(
		val({ ...base, tasks: encodingState(), intent: { task_id: 'T0001', verdict: 'pass' } }).reason,
		'wrong_state'
	);
	assert.equal(
		val({
			...base,
			tasks: validationState(),
			author: 'eve',
			intent: { task_id: 'T0001', verdict: 'pass' }
		}).reason,
		'not_lock_holder'
	);
});

test('validation: rejects when no open slot remains', () => {
	const tasks = parseStateCsv(
		'task_id,fragment,state,encoder,encoded_at,v1\nT0001,sources/score.mei,validation_required,bob,t,fail|dave|t\n'
	);
	const v = val({
		tasks,
		locks: validationLock,
		intent: { task_id: 'T0001', verdict: 'pass' },
		author: 'carol',
		changedPaths: ['tracking/state.csv'],
		passThreshold: 1,
		now: NOW
	});
	assert.equal(v.reason, 'no_open_validation_slot');
});
