// Action E — stale-lock reaper. Pure: given the current locks and the timeout,
// split them into those still fresh and those stale (older than
// staleAfterMinutes), so abandoned claims free up. `now` and each `locked_at`
// are ISO-8601 strings; the comparison uses real elapsed time, so it does not
// depend on how frequently or punctually the reaper runs. See DESIGN.md §5.

import type { LockRow } from './campaign-tables.ts';

export interface ReapLocksArgs {
	locks: LockRow[];
	staleAfterMinutes: number;
	now: string;
}

export interface ReapLocksResult {
	kept: LockRow[];
	removed: LockRow[];
}

export function reapLocks({ locks, staleAfterMinutes, now }: ReapLocksArgs): ReapLocksResult {
	const cutoffMs = staleAfterMinutes * 60_000;
	const nowMs = Date.parse(now);
	const kept: LockRow[] = [];
	const removed: LockRow[] = [];
	for (const lock of locks) {
		const lockedMs = Date.parse(lock.locked_at);
		// A lock is stale only if we can read both times and it's past the cutoff;
		// anything with an unparseable timestamp is kept (don't free what we can't
		// reason about).
		const stale =
			Number.isFinite(lockedMs) && Number.isFinite(nowMs) && nowMs - lockedMs > cutoffMs;
		(stale ? removed : kept).push(lock);
	}
	return { kept, removed };
}
