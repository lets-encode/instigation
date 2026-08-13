import { test } from 'node:test';
import assert from 'node:assert/strict';

import { orphanedFails } from '../campaign-board.ts';
import { parseCommentCsv } from '../campaign-tables.ts';
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
