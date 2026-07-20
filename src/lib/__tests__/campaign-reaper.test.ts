import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reapLocks } from '../campaign-reaper.ts';
import type { LockRow } from '../campaign-tables.ts';

const NOW = '2026-06-25T12:00:00Z';
const lock = (task_id: string, timestamp: string, kind = 'encoding'): LockRow => ({
	task_id,
	subtask_id: kind === 'validation' ? 'S0001' : '',
	user_id: 'bob',
	timestamp,
	kind
});

test('removes locks older than the timeout, keeps fresh ones', () => {
	const { kept, removed } = reapLocks({
		locks: [
			lock('T0001', '2026-06-25T11:00:00Z'), // 60 min — fresh
			lock('T0002', '2026-06-25T09:00:00Z') // 180 min — stale
		],
		staleAfterMinutes: 120,
		now: NOW
	});
	assert.deepEqual(
		kept.map((l) => l.task_id),
		['T0001']
	);
	assert.deepEqual(
		removed.map((l) => l.task_id),
		['T0002']
	);
});

test('the boundary is strict: exactly at the timeout is kept, just over is removed', () => {
	const at = reapLocks({ locks: [lock('T1', '2026-06-25T10:00:00Z')], staleAfterMinutes: 120, now: NOW });
	assert.equal(at.removed.length, 0); // exactly 120 min

	const over = reapLocks({ locks: [lock('T1', '2026-06-25T09:59:00Z')], staleAfterMinutes: 120, now: NOW });
	assert.equal(over.removed.length, 1); // 121 min
});

test('keeps locks when either timestamp is unparseable', () => {
	const { kept, removed } = reapLocks({
		locks: [lock('T1', 'not-a-date')],
		staleAfterMinutes: 120,
		now: NOW
	});
	assert.equal(kept.length, 1);
	assert.equal(removed.length, 0);

	const invalidNow = reapLocks({
		locks: [lock('T1', '2026-06-25T09:00:00Z')],
		staleAfterMinutes: 120,
		now: 'not-a-date'
	});
	assert.equal(invalidNow.kept.length, 1);
	assert.equal(invalidNow.removed.length, 0);
});

test('empty lock table yields nothing to do', () => {
	assert.deepEqual(reapLocks({ locks: [], staleAfterMinutes: 120, now: NOW }), {
		kept: [],
		removed: []
	});
});
