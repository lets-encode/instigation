import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	parseCsv,
	parseTaskCsv,
	serializeTaskCsv,
	parseStateCsv,
	serializeStateCsv,
	parseLockCsv,
	serializeLockCsv,
	parseHistoryCsv,
	appendHistory,
	findRow,
	isFinalValidation
} from './campaign-tables.js';

const STATE =
	'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
	'T0001,,encoding_required,,,\n' +
	'T0001,S0001,pending,,,\n';

test('parseCsv: handles quoted fields with embedded commas', () => {
	assert.deepEqual(parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']]);
});

test('parseCsv: no trailing empty row when text ends in newline', () => {
	assert.deepEqual(parseCsv('x,y\n1,2\n'), [
		['x', 'y'],
		['1', '2']
	]);
});

test('parseTaskCsv: task and subtask rows become keyed objects', () => {
	const rows = parseTaskCsv(
		'task_id,subtask_id,fragment,locator,allowlist,blocklist\n' +
			'T0001,,sources/score.mei,,,\n' +
			'T0001,S0001,sources/score.mei,m-12,,\n'
	);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0], {
		task_id: 'T0001',
		subtask_id: '',
		fragment: 'sources/score.mei',
		locator: '',
		allowlist: '',
		blocklist: ''
	});
	assert.equal(rows[1].subtask_id, 'S0001');
	assert.equal(rows[1].locator, 'm-12');
});

test('serializeTaskCsv: round-trips with parseTaskCsv', () => {
	const text =
		'task_id,subtask_id,fragment,locator,allowlist,blocklist\n' +
		'T0001,,sources/score.mei,,,\n' +
		'T0001,S0001,sources/score.mei,,,\n';
	assert.equal(serializeTaskCsv(parseTaskCsv(text)), text);
});

test('parseStateCsv: exposes validation columns and keyed task/subtask rows', () => {
	const { validationColumns, rows } = parseStateCsv(STATE);
	assert.deepEqual(validationColumns, ['validate_status_1']);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].task_id, 'T0001');
	assert.equal(rows[0].subtask_id, '');
	assert.equal(rows[0].status, 'encoding_required');
	assert.equal(rows[1].subtask_id, 'S0001');
	assert.equal(rows[1].status, 'pending');
	assert.equal(rows[1].validate_status_1, '');
});

test('parseStateCsv: multiple validation columns', () => {
	const { validationColumns } = parseStateCsv(
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2,validate_status_3\n' +
			'T0001,S0001,completed,,,pass|a|t,pass|b|t,fail|c|t\n'
	);
	assert.deepEqual(validationColumns, ['validate_status_1', 'validate_status_2', 'validate_status_3']);
});

test('serializeStateCsv: round-trips with parseStateCsv', () => {
	assert.equal(serializeStateCsv(parseStateCsv(STATE)), STATE);
});

test('parseLockCsv: header-only yields an empty array', () => {
	assert.deepEqual(parseLockCsv('task_id,subtask_id,user_id,timestamp,kind\n'), []);
});

test('parseLockCsv: rows become objects', () => {
	const rows = parseLockCsv(
		'task_id,subtask_id,user_id,timestamp,kind\nT0001,,bob,2026-06-25T10:00:00Z,encoding\n'
	);
	assert.deepEqual(rows, [
		{ task_id: 'T0001', subtask_id: '', user_id: 'bob', timestamp: '2026-06-25T10:00:00Z', kind: 'encoding' }
	]);
});

test('serializeLockCsv: round-trips with parseLockCsv', () => {
	const text =
		'task_id,subtask_id,user_id,timestamp,kind\n' +
		'T0001,,bob,2026-06-25T10:00:00Z,encoding\n' +
		'T0001,S0001,carol,2026-06-25T10:05:00Z,validation\n';
	assert.equal(serializeLockCsv(parseLockCsv(text)), text);
});

test('serializeLockCsv: empty rows yield a header-only table', () => {
	assert.equal(serializeLockCsv([]), 'task_id,subtask_id,user_id,timestamp,kind\n');
});

test('appendHistory: appends rows, keeping existing lines verbatim', () => {
	const header = 'timestamp,task_id,subtask_id,user_id,action,outcome,detail\n';
	const row = {
		timestamp: 't1',
		task_id: 'T0001',
		subtask_id: '',
		user_id: 'bob',
		action: 'claim_encoding',
		outcome: 'accepted',
		detail: ''
	};
	const once = appendHistory(header, [row]);
	assert.equal(once, header + 't1,T0001,,bob,claim_encoding,accepted,\n');
	const twice = appendHistory(once, [{ ...row, timestamp: 't2', outcome: 'rejected', detail: 'already_locked' }]);
	assert.equal(
		twice,
		header + 't1,T0001,,bob,claim_encoding,accepted,\n' + 't2,T0001,,bob,claim_encoding,rejected,already_locked\n'
	);
	assert.equal(parseHistoryCsv(twice).length, 2);
});

test('appendHistory: creates the header when the table is missing', () => {
	const out = appendHistory('', [
		{ timestamp: 't', task_id: 'T1', subtask_id: '', user_id: 'u', action: 'reap', outcome: 'released', detail: 'encoding' }
	]);
	assert.match(out, /^timestamp,task_id,subtask_id,user_id,action,outcome,detail\n/);
});

test('findRow: distinguishes the task row from subtask rows', () => {
	const { rows } = parseStateCsv(STATE);
	assert.equal(findRow(rows, 'T0001', '')!.status, 'encoding_required');
	assert.equal(findRow(rows, 'T0001', 'S0001')!.status, 'pending');
	assert.equal(findRow(rows, 'T0001', 'S9999'), undefined);
});

test('isFinalValidation: only pass/fail are final', () => {
	assert.equal(isFinalValidation('pass|alice|t'), true);
	assert.equal(isFinalValidation('fail|alice|t'), true);
	assert.equal(isFinalValidation(''), false);
});
