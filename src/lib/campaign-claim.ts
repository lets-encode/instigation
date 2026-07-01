// Action B — claim (lock) validation. Pure decision logic: given the current
// tracking tables, a claim intent, and the PR author, decide whether the claim
// is allowed and, if so, the authoritative lock row to write. No GitHub.
//
// Per DESIGN.md §6: the Action is the sole author of the lock
// row — `locked_by` is the PR author and `locked_at` is server time (passed in
// as `now`), never values the fork supplied.

import { isFinalValidation } from './campaign-tables.ts';
import type { ParsedState, LockRow } from './campaign-tables.ts';

/** What a PR is trying to claim: a task and the kind of work being locked. */
export interface ClaimIntent {
	task_id: string;
	kind: string;
}

export interface CheckClaimArgs {
	tasks: ParsedState;
	locks: LockRow[];
	intent: ClaimIntent;
	/** PR author's GitHub login. */
	author: string;
	/** Paths the PR changes. */
	changedPaths: string[];
	/** ISO-8601 timestamp to stamp the lock. */
	now: string;
}

export type ClaimResult = { ok: true; lock: LockRow } | { ok: false; reason: string };

const CLAIM_KINDS = ['encoding', 'validation'];

const reject = (reason: string): ClaimResult => ({ ok: false, reason });

/** True if every changed path is within the allowed set (the boundary guard). */
export function boundaryCheck(changedPaths: string[], allowed: string[]): boolean {
	const allow = new Set(allowed);
	return changedPaths.length > 0 && changedPaths.every((p) => allow.has(p));
}

/** Decide a claim. */
export function checkClaim({ tasks, locks, intent, author, changedPaths, now }: CheckClaimArgs): ClaimResult {
	// A claim may only touch the lock table.
	if (!boundaryCheck(changedPaths, ['tracking/locks.csv'])) return reject('out_of_bounds');

	if (!CLAIM_KINDS.includes(intent.kind)) return reject('invalid_kind');

	const task = tasks.rows.find((r) => r.task_id === intent.task_id);
	if (!task) return reject('unknown_task');

	const activeSameKind = locks.filter((l) => l.task_id === intent.task_id && l.kind === intent.kind);

	if (intent.kind === 'encoding') {
		if (task.state !== 'encoding_required') return reject('wrong_state');
		if (activeSameKind.length > 0) return reject('already_locked');
	} else {
		if (task.state !== 'validation_required') return reject('wrong_state');
		if (author === task.encoder) return reject('self_validation');

		// Open slot = (final pass/fail cells) + (active validation locks) < slots.
		const finals = tasks.validationColumns.filter((c) => isFinalValidation(task[c] ?? '')).length;
		if (finals + activeSameKind.length >= tasks.validationColumns.length) {
			return reject('no_open_validation_slot');
		}
		if (activeSameKind.some((l) => l.locked_by === author)) return reject('already_locked');
	}

	return {
		ok: true,
		lock: { task_id: intent.task_id, locked_by: author, locked_at: now, kind: intent.kind }
	};
}
