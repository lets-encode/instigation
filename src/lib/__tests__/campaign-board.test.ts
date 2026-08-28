import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBoard, cardTitle, orphanedFails } from '../campaign-board.ts';
import { parseCommentCsv, parseStateCsv, parseTaskCsv } from '../campaign-tables.ts';
import type { NodeSlot } from '../campaign-graph.ts';

const COMMENT_HEADER =
	'comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n';

const slot = (over: Partial<NodeSlot>): NodeSlot => ({
	sub: 'S0001',
	slot: 0,
	key: 'open',
	label: '',
	who: '',
	running: false,
	claimable: false,
	user: '',
	ts: '',
	...over
});

test('cardTitle names the piece: config name, else piece directory, else basename', () => {
	const names = { 'sources/piece-1/score.mei': 'Sonata in C' };
	assert.equal(cardTitle('sources/piece-1/score.mei', 'surface-3', names), 'Sonata in C · p. 3');
	assert.equal(cardTitle('sources/piece-1/score.mei', 'score-setup', names), 'Sonata in C · setup');
	// Unnamed pieces fall back to the path's piece directory…
	assert.equal(cardTitle('sources/piece-2/score.mei', '', names), 'piece-2');
	// …and paths outside the sources/<piece>/score.mei layout to the basename.
	assert.equal(cardTitle('sources/score.mei', '', names), 'score');
	assert.equal(cardTitle('sources/anthem.mei', 'surface-1', {}), 'anthem · p. 1');
});

test('orphanedFails returns unresolved fail comments without a matching fail cell', () => {
	const comments = parseCommentCsv(
		COMMENT_HEADER +
			'c1,T0002,S0001,fail,1,1,2,111,2026-08-12T10:21:03.348Z,,,Not the correct notes\n' +
			'c2,T0002,S0001,fail,3,,,222,2026-08-12T10:37:24.390Z,true,,resolved earlier\n' +
			'c3,T0002,,question,,,,333,2026-08-12T10:40:00.000Z,,,a question\n' +
			'c4,T0001,S0001,fail,1,1,1,111,2026-08-12T09:00:00.000Z,,,other task\n'
	);
	// After a send-back the slot is open again — no fail cell matches c1.
	const card = { task: 'T0002', slots: [slot({})] };
	const orphans = orphanedFails(card, comments);
	assert.deepEqual(
		orphans.map((c) => c.comment_id),
		['c1']
	);
});

test('orphanedFails skips a fail comment its fail cell still matches', () => {
	const comments = parseCommentCsv(
		COMMENT_HEADER + 'c1,T0002,S0001,fail,1,1,2,111,2026-08-12T10:21:03.348Z,,,Not the correct notes\n'
	);
	const card = {
		task: 'T0002',
		slots: [slot({ key: 'fail', user: '111', ts: '2026-08-12T10:21:03.348Z' })]
	};
	assert.deepEqual(orphanedFails(card, comments), []);
});

test('attention counts skip replies once their root comment is resolved', () => {
	const d = {
		taskDefs: parseTaskCsv(
			'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n' +
				'T0001,,sources/a.mei,,,,\n' +
				'T0001,S0001,sources/a.mei,,,,\n'
		),
		rows: parseStateCsv(
			'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
				'T0001,,validation_required,7,t,\n' +
				'T0001,S0001,validation_required,,,\n'
		).rows,
		validationColumns: ['validate_status_1'],
		locks: [],
		passThreshold: 1
	};
	// c1 answered and resolved: its reply c2 stays unresolved (replies have no
	// resolve control) but needs no attention. c3 is a live question with a
	// reply c4 — both still count.
	const comments = parseCommentCsv(
		COMMENT_HEADER +
			'c1,T0001,,question,,,,9,t1,true,,Answered?\n' +
			'c2,T0001,,reply,,,,7,t2,,c1,Yes\n' +
			'c3,T0001,,question,,,,9,t3,,,Still open?\n' +
			'c4,T0001,,reply,,,,7,t4,,c3,Looking into it\n'
	);
	const board = buildBoard(d, comments, []);
	const card = board.columns.find((c) => c.key === 'validation')!.cards[0];
	assert.deepEqual(card.counts, { fails: 0, comments: 1, questions: 1 });
	assert.equal(board.attention, 2);
});
