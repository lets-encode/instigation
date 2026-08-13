import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, blockedBy } from '../campaign-graph.ts';
import type { GraphData } from '../campaign-graph.ts';
import type { StateRow, TaskRow } from '../campaign-tables.ts';

const task = (task_id: string, locator = '', depends_on = ''): TaskRow => ({
	task_id,
	subtask_id: '',
	fragment: 'sources/score.mei',
	locator,
	allowlist: '',
	blocklist: '',
	depends_on
});
const subDef = (task_id: string): TaskRow => ({ ...task(task_id), subtask_id: 'S0001' });

const state = (
	task_id: string,
	subtask_id: string,
	status: string,
	encoder = '',
	vals: string[] = []
): StateRow => ({
	task_id,
	subtask_id,
	status,
	encoder,
	encoded_at: encoder ? '2026-07-14T08:12:00Z' : '',
	validate_status_1: vals[0] ?? '',
	validate_status_2: vals[1] ?? ''
});

// A facsimile campaign: a measure-correction pre-task P0001 (with a validation
// subtask), a subtask-less task P0002 depending on it, and one encoding task
// with one validation subtask, two validation slots.
function facsimileData(): GraphData {
	return {
		taskDefs: [task('P0001', 'measure-zones'), subDef('P0001'), task('P0002', '', 'P0001'), task('T0001', '', 'P0002'), subDef('T0001')],
		rows: [
			state('P0001', '', 'completed', 'alice'),
			state('P0001', 'S0001', 'completed', '', ['pass|carol|2026-07-14T06:44:00Z']),
			state('P0002', '', 'completed', 'alice'),
			state('T0001', '', 'validation_required', 'bob', []),
			state('T0001', 'S0001', 'validation_required', '', ['pass|carol|2026-07-14T09:00:00Z'])
		],
		validationColumns: ['validate_status_1', 'validate_status_2'],
		locks: [
			{
				task_id: 'T0001',
				subtask_id: 'S0001',
				user_id: 'dan',
				timestamp: '2026-07-14T09:30:00Z',
				kind: 'validation'
			}
		],
		passThreshold: 2
	};
}

test('buildGraph: one node per task in task.csv order, slots inside', () => {
	const nodes = buildGraph(facsimileData());
	assert.deepEqual(nodes.map((n) => n.task), ['P0001', 'P0002', 'T0001']);
	assert.deepEqual(nodes.map((n) => n.slots.length), [2, 0, 2]);
	assert.deepEqual(nodes.map((n) => n.kind), ['pre', 'encode', 'encode']);
});

test('buildGraph: slot states — final verdict, active review lock, open', () => {
	const nodes = buildGraph(facsimileData());
	const slots = nodes.find((n) => n.task === 'T0001')!.slots;
	assert.equal(slots[0].key, 'pass');
	assert.equal(slots[1].key, 'review');
	assert.ok(slots[1].running);
});

test('buildGraph assigns concurrent validation locks to separate slots', () => {
	const d = facsimileData();
	d.rows[4] = state('T0001', 'S0001', 'validation_required');
	d.locks = [
		{ task_id: 'T0001', subtask_id: 'S0001', user_id: 'carol', timestamp: 't1', kind: 'validation' },
		{ task_id: 'T0001', subtask_id: 'S0001', user_id: 'dan', timestamp: 't2', kind: 'validation' }
	];

	const slots = buildGraph(d, 'carol').find((n) => n.task === 'T0001')!.slots;
	assert.deepEqual(slots.map((slot) => [slot.key, slot.who]), [
		['review', '@carol · in review'],
		['review', '@dan · in review']
	]);

	// With one of two slots reserved, the other remains available to a different
	// reviewer. Parsed tables are replaced, never mutated — lookups are indexed
	// per array identity.
	d.locks = d.locks.slice(0, -1);
	const available = buildGraph(d, 'you').find((n) => n.task === 'T0001')!;
	assert.deepEqual(available.slots.map((slot) => slot.key), ['review', 'open']);
	assert.equal(available.slots[1].claimable, true);
	assert.equal(available.nextUp, true);
});

test('buildGraph: a blocked task is marked as such', () => {
	const d = facsimileData();
	// P0002 not completed → T0001 blocked.
	d.rows[2] = state('P0002', '', 'encoding_required');
	assert.equal(blockedBy(d, 'T0001'), 'P0002');
	const nodes = buildGraph(d);
	assert.equal(nodes.find((n) => n.task === 'T0001')?.statusKey, 'blocked');
});

test('buildGraph: nextUp marks the first task the viewer can act on', () => {
	// dan holds T0001's validation lock, so nothing is claimable for "you" —
	// except once the lock is gone, the open T0001 slot is next.
	const d = facsimileData();
	assert.deepEqual(buildGraph(d, 'you').map((n) => n.nextUp), [false, false, false]);
	d.locks = [];
	assert.deepEqual(buildGraph(d, 'you').map((n) => n.nextUp), [false, false, true]);
	// The encoder cannot validate their own work, so bob has no next step.
	assert.deepEqual(buildGraph(d, 'bob').map((n) => n.nextUp), [false, false, false]);
	// Held work wins: a lock of yours is always your next step.
	d.locks = [{ task_id: 'T0001', subtask_id: 'S0001', user_id: 'you', timestamp: '', kind: 'validation' }];
	assert.deepEqual(buildGraph(d, 'you').map((n) => n.nextUp), [false, false, true]);
});

test('buildGraph: passes count against the threshold, malformed cells excluded', () => {
	const d = facsimileData();
	// A pass-like but malformed cell must not count in the UI when campaign
	// decisions would still treat it as an open validation slot.
	d.rows[4].validate_status_2 = 'pass||2026-07-14T09:30:00Z';
	const node = buildGraph(d).find((n) => n.task === 'T0001')!;
	assert.equal(node.passes, 1);
	assert.equal(node.threshold, 2);
	assert.equal(node.slots[1].key, 'pending');
});

test('anonymous viewers can inspect the projection but cannot claim work', () => {
	const nodes = buildGraph(facsimileData(), '');
	assert.equal(nodes.some((node) => node.nextUp), false);
	assert.equal(nodes.flatMap((node) => node.slots).some((slot) => slot.claimable), false);
});

test('buildGraph: a validator with a recorded verdict is not offered the next slot', () => {
	const d = facsimileData();
	d.locks = [];
	// carol recorded the slot-1 pass on T0001/S0001; the open slot needs
	// someone else.
	const asCarol = buildGraph(d, 'carol').find((n) => n.task === 'T0001')!.slots;
	assert.equal(asCarol[1].claimable, false);
	assert.equal(asCarol[1].who, 'open — needs another volunteer');
	const asOther = buildGraph(d, 'you').find((n) => n.task === 'T0001')!.slots;
	assert.equal(asOther[1].claimable, true);
	// The self-validation flag lifts the rule.
	d.allowSelfValidation = true;
	const allowed = buildGraph(d, 'carol').find((n) => n.task === 'T0001')!.slots;
	assert.equal(allowed[1].claimable, true);
});

test('buildGraph: a reviewer already holding a slot is not offered the next one', () => {
	const d = facsimileData();
	d.rows[4] = state('T0001', 'S0001', 'validation_required');
	d.locks = [
		{ task_id: 'T0001', subtask_id: 'S0001', user_id: 'carol', timestamp: 't1', kind: 'validation' }
	];
	const slots = buildGraph(d, 'carol').find((n) => n.task === 'T0001')!.slots;
	assert.equal(slots.some((slot) => slot.claimable), false);
});

test('buildGraph: the encoder sees an open slot needs another volunteer, not a claim', () => {
	const d = facsimileData();
	// Alice encoded P0001; her open validation slot is not hers to claim.
	d.rows[0] = state('P0001', '', 'validation_required', 'alice');
	d.rows[1] = state('P0001', 'S0001', 'validation_required', '');
	const slotFor = (viewer: string) =>
		buildGraph(d, viewer).find((n) => n.task === 'P0001')!.slots[0];
	const asEncoder = slotFor('alice');
	assert.equal(asEncoder.claimable, false);
	assert.equal(asEncoder.who, 'open — needs another volunteer');
	const asOther = slotFor('you');
	assert.equal(asOther.claimable, true);
	assert.equal(asOther.who, 'open — claim to review');
});

// The tables key people by their stable numeric id; slot text shows a login
// when one is supplied, and falls back to the raw id when it isn't resolved.
test('buildGraph: numeric user ids render as logins via the map', () => {
	const data: GraphData = {
		taskDefs: [task('T0001'), subDef('T0001')],
		rows: [
			state('T0001', '', 'validation_required', 'bob'),
			state('T0001', 'S0001', 'validation_required', '', ['pass|12345|2026-07-14T09:00:00Z'])
		],
		validationColumns: ['validate_status_1'],
		locks: [],
		passThreshold: 1
	};
	const logins = { '12345': 'octocat' };

	const withLogin = buildGraph(data, '', logins).find((n) => n.task === 'T0001');
	assert.equal(withLogin?.slots[0].who, '@octocat · pass');
	// No map entry → the id stands in for the login, never a blank.
	const withoutLogin = buildGraph(data, '').find((n) => n.task === 'T0001');
	assert.equal(withoutLogin?.slots[0].who, '@12345 · pass');
});
