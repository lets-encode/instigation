import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskCsv, parseStateCsv, parseLockCsv } from '../campaign-tables.ts';
import type { TaskRow } from '../campaign-tables.ts';
import { checkPlan, nextTaskId, taskStarted } from '../campaign-plan.ts';

const STATE_HEADER = 'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n';
const TASK_HEADER = 'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n';
const LOCK_HEADER = 'task_id,subtask_id,user_id,timestamp,kind\n';

const twoTasks = parseTaskCsv(
	TASK_HEADER +
		'T0001,,sources/score.mei,surface-1,,,\n' +
		'T0001,S0001,sources/score.mei,surface-1,,,\n' +
		'T0002,,sources/score.mei,surface-2,,,T0001\n' +
		'T0002,S0001,sources/score.mei,surface-2,,,\n'
);
const freshState = parseStateCsv(
	STATE_HEADER +
		'T0001,,encoding_required,,,\n' +
		'T0001,S0001,pending,,,\n' +
		'T0002,,encoding_required,,,\n' +
		'T0002,S0001,pending,,,\n'
);
const startedState = parseStateCsv(
	STATE_HEADER +
		'T0001,,validation_required,42,2026-07-01T09:00:00Z,\n' +
		'T0001,S0001,validation_required,,,\n' +
		'T0002,,encoding_required,,,\n' +
		'T0002,S0001,pending,,,\n'
);
const encodingLock = parseLockCsv(LOCK_HEADER + 'T0001,,42,2026-07-01T09:00:00Z,encoding\n');

const copy = (rows: TaskRow[]): TaskRow[] => rows.map((r) => ({ ...r }));

test('taskStarted: untouched, locked, and encoded tasks', () => {
	assert.equal(taskStarted(freshState, [], 'T0001'), false);
	assert.equal(taskStarted(freshState, encodingLock, 'T0001'), true);
	assert.equal(taskStarted(startedState, [], 'T0001'), true);
});

test('a fresh plan may reorder, rewire, remove and add tasks', () => {
	const plan = copy(twoTasks);
	plan[2].depends_on = ''; // unwire T0002 from T0001
	const v = checkPlan(twoTasks, freshState, [], plan);
	assert.equal(v.ok, true);
});

test('state rows follow the plan: kept rows carried over, new tasks start fresh', () => {
	const plan = copy(twoTasks).concat([
		{ task_id: 'T0003', subtask_id: '', fragment: 'sources/score.mei', locator: 'surface-3', allowlist: '', blocklist: '', depends_on: 'T0002' },
		{ task_id: 'T0003', subtask_id: 'S0001', fragment: 'sources/score.mei', locator: 'surface-3', allowlist: '', blocklist: '', depends_on: '' }
	]);
	const v = checkPlan(twoTasks, startedState, [], plan);
	assert.equal(v.ok, true);
	if (!v.ok) return;
	assert.equal(v.stateRows.length, 6);
	// The encoded task keeps its state row untouched.
	assert.equal(v.stateRows[0].status, 'validation_required');
	assert.equal(v.stateRows[0].encoder, '42');
	// The new task starts at encoding_required with a pending subtask.
	assert.equal(v.stateRows[4].status, 'encoding_required');
	assert.equal(v.stateRows[5].status, 'pending');
	assert.equal(v.stateRows[5].validate_status_1, '');
});

test('removing or editing a started task is rejected', () => {
	// Removed: only T0002 remains.
	const removed = copy(twoTasks).filter((r) => r.task_id !== 'T0001');
	removed[0].depends_on = '';
	assert.deepEqual(checkPlan(twoTasks, startedState, [], removed), {
		ok: false,
		reason: 'task_in_progress'
	});
	// Edited: the started task's locator changes.
	const edited = copy(twoTasks);
	edited[0].locator = 'surface-9';
	assert.deepEqual(checkPlan(twoTasks, startedState, [], edited), {
		ok: false,
		reason: 'task_in_progress'
	});
	// A lock alone also counts as started.
	assert.deepEqual(checkPlan(twoTasks, freshState, encodingLock, removed), {
		ok: false,
		reason: 'task_in_progress'
	});
});

test('dependency validation: unknown targets and cycles are rejected', () => {
	const unknown = copy(twoTasks);
	unknown[2].depends_on = 'T0009';
	assert.deepEqual(checkPlan(twoTasks, freshState, [], unknown), {
		ok: false,
		reason: 'unknown_dependency'
	});
	const cycle = copy(twoTasks);
	cycle[0].depends_on = 'T0002'; // T0001 → T0002 → T0001
	assert.deepEqual(checkPlan(twoTasks, freshState, [], cycle), {
		ok: false,
		reason: 'dependency_cycle'
	});
	const self = copy(twoTasks);
	self[0].depends_on = 'T0001';
	assert.deepEqual(checkPlan(twoTasks, freshState, [], self), {
		ok: false,
		reason: 'dependency_cycle'
	});
});

test('structural validation: empty plans, duplicates and orphans are rejected', () => {
	assert.deepEqual(checkPlan(twoTasks, freshState, [], []), { ok: false, reason: 'empty_plan' });
	const dupe = copy(twoTasks).concat([{ ...twoTasks[0] }]);
	assert.deepEqual(checkPlan(twoTasks, freshState, [], dupe), {
		ok: false,
		reason: 'duplicate_row'
	});
	const orphan = copy(twoTasks).concat([
		{ task_id: 'T0009', subtask_id: 'S0001', fragment: 'sources/score.mei', locator: '', allowlist: '', blocklist: '', depends_on: '' }
	]);
	assert.deepEqual(checkPlan(twoTasks, freshState, [], orphan), {
		ok: false,
		reason: 'orphan_subtask'
	});
});

test('nextTaskId continues after the highest T#### in use', () => {
	assert.equal(nextTaskId(twoTasks), 'T0003');
	assert.equal(nextTaskId([]), 'T0001');
	const withPre = parseTaskCsv(TASK_HEADER + 'P0001,,sources/score.mei,measure-zones,,,\n');
	assert.equal(nextTaskId(withPre), 'T0001');
});
