import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseStateCsv, parseLocksCsv } from './campaign-tables.js';
import type { LockRow } from './campaign-tables.js';
import { boundaryCheck, checkClaim } from './campaign-claim.js';
import type { CheckClaimArgs } from './campaign-claim.js';

// A relaxed view of the claim result for assertions, where the branch-specific
// fields are read directly without narrowing each result.
type ClaimView = { ok: boolean; reason?: string; lock?: LockRow };

const NOW = '2026-06-25T10:00:00Z';
const LOCKS_HEADER = 'task_id,locked_by,locked_at,kind\n';

// State builders for the scenarios under test.
const encodingRequired = parseStateCsv(
	'task_id,fragment,state,encoder,encoded_at,v1\nT0001,sources/score.mei,encoding_required,,,\n'
);
const validationRequired = parseStateCsv(
	'task_id,fragment,state,encoder,encoded_at,v1\nT0001,sources/score.mei,validation_required,bob,2026-06-25T09:00:00Z,\n'
);
const validationTwoSlots = parseStateCsv(
	'task_id,fragment,state,encoder,encoded_at,v1,v2\nT0001,sources/score.mei,validation_required,bob,2026-06-25T09:00:00Z,,\n'
);

const claim = (over: Partial<CheckClaimArgs> = {}): ClaimView =>
	checkClaim({
		tasks: encodingRequired,
		locks: [],
		intent: { task_id: 'T0001', kind: 'encoding' },
		author: 'carol',
		changedPaths: ['tracking/locks.csv'],
		now: NOW,
		...over
	});

test('boundaryCheck: only allowed paths, and at least one change', () => {
	assert.equal(boundaryCheck(['tracking/locks.csv'], ['tracking/locks.csv']), true);
	assert.equal(boundaryCheck(['sources/score.mei'], ['tracking/locks.csv']), false);
	assert.equal(boundaryCheck([], ['tracking/locks.csv']), false);
});

test('encoding claim on a free task is accepted with an Action-authored lock', () => {
	const v = claim();
	assert.deepEqual(v, {
		ok: true,
		lock: { task_id: 'T0001', locked_by: 'carol', locked_at: NOW, kind: 'encoding' }
	});
});

test('lock identity comes from the author, never the fork', () => {
	// Even if a fork tried to smuggle a different login, only `author` is used.
	const v = claim({ author: 'dave' });
	assert.equal(v.lock!.locked_by, 'dave');
});

test('rejects a PR that strays outside locks.csv', () => {
	assert.deepEqual(claim({ changedPaths: ['tracking/locks.csv', 'sources/score.mei'] }), {
		ok: false,
		reason: 'out_of_bounds'
	});
});

test('rejects an unknown task and an invalid kind', () => {
	assert.equal(claim({ intent: { task_id: 'T9999', kind: 'encoding' } }).reason, 'unknown_task');
	assert.equal(claim({ intent: { task_id: 'T0001', kind: 'review' } }).reason, 'invalid_kind');
});

test('encoding claim is rejected when already locked', () => {
	const locks = parseLocksCsv(LOCKS_HEADER + 'T0001,bob,2026-06-25T09:30:00Z,encoding\n');
	assert.equal(claim({ locks }).reason, 'already_locked');
});

test('encoding claim is rejected in the wrong state', () => {
	assert.equal(claim({ tasks: validationRequired }).reason, 'wrong_state');
});

test('validation claim by a different person is accepted', () => {
	const v = claim({ tasks: validationRequired, intent: { task_id: 'T0001', kind: 'validation' }, author: 'carol' });
	assert.equal(v.ok, true);
	assert.equal(v.lock!.kind, 'validation');
});

test('validation claim by the encoder is rejected (no self-validation)', () => {
	const v = claim({ tasks: validationRequired, intent: { task_id: 'T0001', kind: 'validation' }, author: 'bob' });
	assert.equal(v.reason, 'self_validation');
});

test('validation claim is rejected when the only slot is already a final outcome', () => {
	const tasks = parseStateCsv(
		'task_id,fragment,state,encoder,encoded_at,v1\nT0001,sources/score.mei,validation_required,bob,t,pass|carol|t\n'
	);
	const v = claim({ tasks, intent: { task_id: 'T0001', kind: 'validation' }, author: 'dave' });
	assert.equal(v.reason, 'no_open_validation_slot');
});

test('validation claim is rejected when active locks already fill the slots', () => {
	const locks = parseLocksCsv(LOCKS_HEADER + 'T0001,carol,t,validation\n');
	const v = claim({
		tasks: validationRequired,
		locks,
		intent: { task_id: 'T0001', kind: 'validation' },
		author: 'dave'
	});
	assert.equal(v.reason, 'no_open_validation_slot');
});

test('two-slot task: same validator cannot claim twice, a second validator can', () => {
	const locks = parseLocksCsv(LOCKS_HEADER + 'T0001,carol,t,validation\n');
	const base = { tasks: validationTwoSlots, locks, intent: { task_id: 'T0001', kind: 'validation' } };
	assert.equal(claim({ ...base, author: 'carol' }).reason, 'already_locked');
	assert.equal(claim({ ...base, author: 'dave' }).ok, true);
});
