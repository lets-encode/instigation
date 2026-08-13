import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	parseCsv,
	parseTaskCsv,
	parseStateCsv,
	serializeStateCsv,
	parseLockCsv,
	serializeLockCsv,
	parseHistoryCsv,
	appendHistory,
	parseCommentCsv,
	serializeCommentCsv,
	appendComments,
	findRow,
	isFinalValidation,
	configPieces,
	passThresholdOf
} from '../campaign-tables.ts';
import { buildCampaignConfig, configToYaml } from '../campaign-init.ts';

const STATE =
	'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
	'T0001,,encoding_required,,,\n' +
	'T0001,S0001,pending,,,\n';

test('parseCsv: handles quoted fields with embedded commas', () => {
	assert.deepEqual(parseCsv('a,"b,c",d\n'), [['a', 'b,c', 'd']]);
});

test('parseCsv: handles escaped quotes', () => {
	assert.deepEqual(parseCsv('a,"b""c",d\n'), [['a', 'b"c', 'd']]);
});

test('parseCsv: handles newlines inside quoted fields', () => {
	assert.deepEqual(parseCsv('a,"line 1\nline 2",d\n'), [['a', 'line 1\nline 2', 'd']]);
});

test('parseCsv: no trailing empty row when text ends in newline', () => {
	assert.deepEqual(parseCsv('x,y\n1,2\n'), [
		['x', 'y'],
		['1', '2']
	]);
});

test('parseTaskCsv: task and subtask rows become keyed objects', () => {
	const rows = parseTaskCsv(
		'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n' +
			'T0001,,sources/score.mei,,,,P0002\n' +
			'T0001,S0001,sources/score.mei,m-12,,,\n'
	);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0], {
		task_id: 'T0001',
		subtask_id: '',
		fragment: 'sources/score.mei',
		locator: '',
		allowlist: '',
		blocklist: '',
		depends_on: 'P0002'
	});
	assert.equal(rows[1].subtask_id, 'S0001');
	assert.equal(rows[1].locator, 'm-12');
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
	const header = 'timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input\n';
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
	assert.equal(once, header + 't1,T0001,,bob,claim_encoding,accepted,,,,\n');
	const twice = appendHistory(once, [{ ...row, timestamp: 't2', outcome: 'rejected', detail: 'already_locked' }]);
	assert.equal(
		twice,
		header + 't1,T0001,,bob,claim_encoding,accepted,,,,\n' + 't2,T0001,,bob,claim_encoding,rejected,already_locked,,,\n'
	);
	assert.equal(parseHistoryCsv(twice).length, 2);
});

test('appendHistory: creates the header when the table is missing', () => {
	const out = appendHistory('', [
		{ timestamp: 't', task_id: 'T1', subtask_id: '', user_id: 'u', action: 'reap', outcome: 'released', detail: 'encoding' }
	]);
	assert.match(out, /^timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input\n/);
});

test('appendHistory: adds a newline before appending to a table without one', () => {
	const existing =
		'timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input\n' +
		't1,T0001,,bob,claim_encoding,accepted,,,,';
	const out = appendHistory(existing, [
		{
			timestamp: 't2',
			task_id: 'T0001',
			subtask_id: '',
			user_id: 'bob',
			action: 'reap',
			outcome: 'released',
			detail: 'encoding'
		}
	]);
	assert.equal(out, existing + '\nt2,T0001,,bob,reap,released,encoding,,,\n');
});

test('appendHistory: command columns and their JSON input round-trip through CSV quoting', () => {
	const row = {
		timestamp: '2026-07-13T10:00:00Z',
		task_id: 'T0001',
		subtask_id: 'S0001',
		user_id: 'alice',
		action: 'claim_validation',
		outcome: 'accepted',
		detail: '',
		command: 'campaign.claimValidation',
		version: '1',
		input: '{"task_id":"T0001","subtask_id":"S0001"}'
	};
	const out = appendHistory('', [row]);
	assert.deepEqual(parseHistoryCsv(out), [row]);
});

test('appendHistory: rows without command columns serialise them empty', () => {
	const out = appendHistory('', [
		{ timestamp: 't', task_id: 'T1', subtask_id: '', user_id: 'u', action: 'reap', outcome: 'released', detail: 'encoding' }
	]);
	const [row] = parseHistoryCsv(out);
	assert.equal(row.command, '');
	assert.equal(row.input, '');
});

test('findRow: distinguishes the task row from subtask rows', () => {
	const { rows } = parseStateCsv(STATE);
	assert.equal(findRow(rows, 'T0001', '')!.status, 'encoding_required');
	assert.equal(findRow(rows, 'T0001', 'S0001')!.status, 'pending');
	assert.equal(findRow(rows, 'T0001', 'S9999'), undefined);
});

test('comment.csv: rows round-trip, and appending creates the header when missing', () => {
	const csv =
		'comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n' +
		'c1,T0001,S0001,fail,12,34,35,carol,t1,,,"Slur missing, see source"\n';
	const rows = parseCommentCsv(csv);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].kind, 'fail');
	assert.equal(rows[0].measure_end, '35');
	assert.equal(rows[0].body, 'Slur missing, see source');
	assert.equal(serializeCommentCsv(rows), csv);
	const appended = appendComments('', [rows[0]]);
	assert.equal(appended, csv);
	assert.equal(parseCommentCsv(appendComments(csv, rows)).length, 2);
});

test('isFinalValidation: only pass/fail are final', () => {
	assert.equal(isFinalValidation('pass|alice|t'), true);
	assert.equal(isFinalValidation('fail|alice|t'), true);
	assert.equal(isFinalValidation(''), false);
	assert.equal(isFinalValidation('pass'), false);
	assert.equal(isFinalValidation('pass||t'), false);
	assert.equal(isFinalValidation('fail|alice|'), false);
	assert.equal(isFinalValidation('pass|alice|t|extra'), false);
	assert.equal(isFinalValidation('pending|alice|t'), false);
});

test('configPieces: reads the pieces configToYaml writes, in order', () => {
	const yaml = configToYaml(
		buildCampaignConfig(
			{
				name: 'campaign',
				pieces: [
					{
						id: 'piece-01',
						kind: 'facsimile',
						path: 'pieces/piece-01/score.mei',
						zones: [{ surface: 1, ulx: 0, uly: 0, lrx: 10, lry: 10 }],
						header: { title: 'Prelude', composer: 'Anon.' }
					},
					{
						id: 'piece-02',
						kind: 'encoded',
						path: 'pieces/piece-02/score.mei',
						zones: [],
						header: { title: '', composer: '' }
					}
				]
			},
			'instigator',
			{ central_repository: 'org/automation', ref: 'main', path: '.github/workflows/x.yml' },
			1
		)
	);

	assert.deepEqual(configPieces(yaml), [
		{ id: 'piece-01', path: 'pieces/piece-01/score.mei', title: 'Prelude' },
		{ id: 'piece-02', path: 'pieces/piece-02/score.mei', title: '' }
	]);
});

test('configPieces: a config without pieces yields none', () => {
	assert.deepEqual(configPieces('pieces: []\nfragmentation:\n  strategy: "by-piece"\n'), []);
	assert.deepEqual(configPieces(null), []);
});

test('passThresholdOf: reads the config value, capped by the slot count', () => {
	assert.equal(passThresholdOf('validation:\n  pass_threshold: 2\n', 3), 2);
	assert.equal(passThresholdOf('validation:\n  pass_threshold: 5\n', 2), 2);
});

test('passThresholdOf: defaults to the slot count when the key is absent', () => {
	assert.equal(passThresholdOf(null, 3), 3);
	assert.equal(passThresholdOf('', 1), 1);
	assert.equal(passThresholdOf(null, 0), 1);
});
