import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, buildPanel, blockedBy } from './campaign-graph.ts';
import type { GraphData } from './campaign-graph.ts';
import type { HistoryRow, StateRow, TaskRow } from './campaign-tables.ts';

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

// A facsimile campaign as initialised by buildTaskCsv/buildStateCsv: two
// pre-tasks (P0001 with a validation subtask, P0002 without) and one encoding
// task with one validation subtask, two validation slots.
function facsimileData(): GraphData {
	return {
		taskDefs: [task('P0001', 'measure-zones'), subDef('P0001'), task('P0002', 'breaks', 'P0001'), task('T0001', '', 'P0002'), subDef('T0001')],
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

test('buildGraph: one node per task, slots inside, edges between neighbours', () => {
	const g = buildGraph(facsimileData());
	assert.deepEqual(g.nodes.map((n) => n.task), ['P0001', 'P0002', 'T0001']);
	// P0001 and T0001 each carry 2 validation slots; P0002 has none.
	assert.deepEqual(g.nodes.map((n) => n.slots.length), [2, 0, 2]);
	assert.equal(g.edges.length, 2);
	// Left-to-right order, all inside the canvas.
	for (let i = 1; i < g.nodes.length; i++) {
		assert.ok(g.nodes[i].x > g.nodes[i - 1].x + g.nodes[i - 1].w);
	}
	for (const n of g.nodes) {
		assert.ok(n.x >= 0 && n.x + n.w <= g.W, `${n.key} inside width`);
		assert.ok(n.y >= 0 && n.y + n.h <= g.H, `${n.key} inside height`);
	}
});

test('buildGraph: full type names, no abbreviations', () => {
	const g = buildGraph(facsimileData());
	assert.deepEqual(
		g.nodes.map((n) => n.title),
		['Measure correction', 'Page/system breaks', 'Encoding']
	);
});

test('buildGraph: depends_on edges turn green once the upstream task completes', () => {
	const done = buildGraph(facsimileData());
	assert.deepEqual(done.edges.map((e) => e.kind), ['green', 'green']);
	const d = facsimileData();
	d.rows[0] = state('P0001', '', 'encoding_required');
	d.rows[2] = state('P0002', '', 'pending');
	assert.deepEqual(buildGraph(d).edges.map((e) => e.kind), ['open', 'open']);
});

test('buildGraph: slot states — final verdict, active review lock, open', () => {
	const g = buildGraph(facsimileData());
	const slots = g.nodes.find((n) => n.task === 'T0001')!.slots;
	assert.equal(slots[0].key, 'pass');
	assert.equal(slots[1].key, 'review');
	assert.ok(slots[1].running);
});

test('buildGraph: a blocked task is marked as such', () => {
	const d = facsimileData();
	// P0002 not completed → T0001 blocked.
	d.rows[2] = state('P0002', '', 'encoding_required');
	assert.equal(blockedBy(d, 'T0001'), 'P0002');
	const g = buildGraph(d);
	assert.equal(g.nodes.find((n) => n.task === 'T0001')?.statusKey, 'blocked');
});

test('buildGraph: nextUp marks the first task the viewer can act on', () => {
	// dan holds T0001's validation lock, so nothing is claimable for "you" —
	// except once the lock is gone, the open T0001 slot is next.
	const d = facsimileData();
	assert.deepEqual(buildGraph(d, 'you').nodes.map((n) => n.nextUp), [false, false, false]);
	d.locks = [];
	assert.deepEqual(buildGraph(d, 'you').nodes.map((n) => n.nextUp), [false, false, true]);
	// The encoder cannot validate their own work, so bob has no next step.
	assert.deepEqual(buildGraph(d, 'bob').nodes.map((n) => n.nextUp), [false, false, false]);
	// Held work wins: a lock of yours is always your next step.
	d.locks = [{ task_id: 'T0001', subtask_id: 'S0001', user_id: 'you', timestamp: '', kind: 'validation' }];
	assert.deepEqual(buildGraph(d, 'you').nodes.map((n) => n.nextUp), [false, false, true]);
});

const noHistory: HistoryRow[] = [];

test('buildPanel: encoding node — claim enabled only when unblocked and unclaimed', () => {
	const d = facsimileData();
	d.rows[3] = state('T0001', '', 'encoding_required');
	const p = buildPanel(d, noHistory, { task: 'T0001', sub: '', slot: null }, 'you', false);
	assert.ok(p);
	const open = p.actions.find((a) => a.id === 'open-editor');
	assert.equal(open?.disabled, false);
	assert.equal(p.actions.find((a) => a.id === 'submit-encoding')?.disabled, true);
});

test('buildPanel: holding the encoding lock enables submit', () => {
	const d = facsimileData();
	d.rows[3] = state('T0001', '', 'encoding_required');
	d.locks.push({ task_id: 'T0001', subtask_id: '', user_id: 'you', timestamp: '', kind: 'encoding' });
	const p = buildPanel(d, noHistory, { task: 'T0001', sub: '', slot: null }, 'you', false);
	assert.equal(p?.actions.find((a) => a.id === 'open-editor')?.label, 'Open in mei-friend ↗');
	assert.equal(p?.actions.find((a) => a.id === 'submit-encoding')?.disabled, false);
});

test('buildPanel: no self-validation', () => {
	const d = facsimileData();
	d.locks = [];
	const p = buildPanel(d, noHistory, { task: 'T0001', sub: 'S0001', slot: 1 }, 'bob', false);
	assert.equal(p?.actions.find((a) => a.id === 'claim-validation')?.disabled, true);
});

test('buildPanel: open slot claimable by a non-encoder; verdicts need the lock', () => {
	const d = facsimileData();
	d.locks = [];
	const open = buildPanel(d, noHistory, { task: 'T0001', sub: 'S0001', slot: 1 }, 'you', false);
	assert.equal(open?.actions.find((a) => a.id === 'claim-validation')?.disabled, false);
	assert.equal(open?.actions.find((a) => a.id === 'validate-pass'), undefined);

	d.locks = [{ task_id: 'T0001', subtask_id: 'S0001', user_id: 'you', timestamp: '', kind: 'validation' }];
	const held = buildPanel(d, noHistory, { task: 'T0001', sub: 'S0001', slot: 1 }, 'you', false);
	assert.equal(held?.actions.find((a) => a.id === 'validate-pass')?.disabled, false);
	assert.equal(held?.actions.find((a) => a.id === 'validate-fail')?.disabled, false);
});

test('buildPanel: pre-task uses the zone editor, blocked until its dependency completes', () => {
	const d = facsimileData();
	d.rows[0] = state('P0001', '', 'encoding_required');
	const p = buildPanel(d, noHistory, { task: 'P0002', sub: '', slot: null }, 'you', false);
	const act = p?.actions.find((a) => a.id === 'zone-editor');
	assert.ok(act);
	assert.equal(act.disabled, true);
});

test('buildPanel: a pre-task validation slot links to the zone editor for review', () => {
	const d = facsimileData();
	const p = buildPanel(d, noHistory, { task: 'P0001', sub: 'S0001', slot: 1 }, 'you', false);
	assert.ok(p?.actions.some((a) => a.id === 'zone-editor'));
	// Encoding tasks review in the score preview instead — no editor link.
	const enc = buildPanel(d, noHistory, { task: 'T0001', sub: 'S0001', slot: 1 }, 'you', false);
	assert.equal(enc?.actions.some((a) => a.id === 'zone-editor'), false);
});

test('buildPanel: validation summary counts passes against the threshold', () => {
	const p = buildPanel(facsimileData(), noHistory, { task: 'T0001', sub: '', slot: null }, 'you', false);
	assert.equal(p?.validations.length, 1);
	assert.equal(p?.validations[0].passes, 1);
	assert.equal(p?.validations[0].threshold, 2);
	assert.equal(p?.validations[0].slots.length, 2);
});

test('buildPanel: history is filtered to the selected task, newest first', () => {
	const history: HistoryRow[] = [
		{ timestamp: '1', task_id: 'T0001', subtask_id: '', user_id: 'bob', action: 'claim_encoding', outcome: 'accepted', detail: '' },
		{ timestamp: '2', task_id: 'P0001', subtask_id: '', user_id: 'alice', action: 'submit_encoding', outcome: 'accepted', detail: '' },
		{ timestamp: '3', task_id: 'T0001', subtask_id: '', user_id: 'bob', action: 'submit_encoding', outcome: 'accepted', detail: '' }
	];
	const p = buildPanel(facsimileData(), history, { task: 'T0001', sub: '', slot: null }, 'you', false);
	assert.deepEqual(p?.history.map((h) => h.t), ['3', '1']);
});

test('buildPanel: null on empty or unknown selection', () => {
	assert.equal(buildPanel(facsimileData(), noHistory, null, 'you', false), null);
	assert.equal(buildPanel(facsimileData(), noHistory, { task: 'NOPE', sub: '', slot: null }, 'you', false), null);
});
