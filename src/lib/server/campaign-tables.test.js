import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	parseCsv,
	parseStateCsv,
	parseLocksCsv,
	serializeLocksCsv,
	serializeStateCsv,
	isFinalValidation
} from './campaign-tables.js';

const STATE = 'task_id,fragment,state,encoder,encoded_at,v1\n' + 'T0001,sources/score.mei,encoding_required,,,\n';

test('parseCsv: handles quoted fields with embedded commas', () => {
	assert.deepEqual(parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']]);
});

test('parseCsv: no trailing empty row when text ends in newline', () => {
	assert.deepEqual(parseCsv('x,y\n1,2\n'), [
		['x', 'y'],
		['1', '2']
	]);
});

test('parseStateCsv: exposes validation columns and a keyed row', () => {
	const { validationColumns, rows } = parseStateCsv(STATE);
	assert.deepEqual(validationColumns, ['v1']);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].task_id, 'T0001');
	assert.equal(rows[0].state, 'encoding_required');
	assert.equal(rows[0].fragment, 'sources/score.mei');
	assert.equal(rows[0].encoder, '');
	assert.equal(rows[0].v1, '');
});

test('parseStateCsv: multiple validation columns', () => {
	const { validationColumns } = parseStateCsv(
		'task_id,fragment,state,encoder,encoded_at,v1,v2,v3\nT0001,f,completed,bob,2026-01-01T00:00:00Z,pass|a|t,pass|b|t,fail|c|t\n'
	);
	assert.deepEqual(validationColumns, ['v1', 'v2', 'v3']);
});

test('parseLocksCsv: header-only yields an empty array', () => {
	assert.deepEqual(parseLocksCsv('task_id,locked_by,locked_at,kind\n'), []);
});

test('parseLocksCsv: rows become objects', () => {
	const rows = parseLocksCsv(
		'task_id,locked_by,locked_at,kind\nT0001,bob,2026-06-25T10:00:00Z,encoding\n'
	);
	assert.deepEqual(rows, [
		{ task_id: 'T0001', locked_by: 'bob', locked_at: '2026-06-25T10:00:00Z', kind: 'encoding' }
	]);
});

test('serializeLocksCsv: round-trips with parseLocksCsv', () => {
	const text =
		'task_id,locked_by,locked_at,kind\n' +
		'T0001,bob,2026-06-25T10:00:00Z,encoding\n' +
		'T0001,carol,2026-06-25T10:05:00Z,validation\n';
	assert.equal(serializeLocksCsv(parseLocksCsv(text)), text);
});

test('serializeLocksCsv: empty rows yield a header-only table', () => {
	assert.equal(serializeLocksCsv([]), 'task_id,locked_by,locked_at,kind\n');
});

test('serializeStateCsv: round-trips with parseStateCsv', () => {
	const text =
		'task_id,fragment,state,encoder,encoded_at,v1,v2\n' +
		'T0001,sources/score.mei,completed,bob,2026-06-25T09:00:00Z,pass|carol|t,fail|dave|t\n';
	assert.equal(serializeStateCsv(parseStateCsv(text)), text);
});

test('isFinalValidation: only pass/fail are final', () => {
	assert.equal(isFinalValidation('pass|alice|t'), true);
	assert.equal(isFinalValidation('fail|alice|t'), true);
	assert.equal(isFinalValidation(''), false);
});
