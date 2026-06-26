// Action B — claim (lock) validation. Pure decision logic: given the current
// tracking tables, a claim intent, and the PR author, decide whether the claim
// is allowed and, if so, the authoritative lock row to write. No GitHub.
//
// Per DESIGN.md §6: the Action is the sole author of the lock
// row — `locked_by` is the PR author and `locked_at` is server time (passed in
// as `now`), never values the fork supplied.

import { isFinalValidation } from './campaign-tables.js';

const CLAIM_KINDS = ['encoding', 'validation'];

const reject = (reason) => ({ ok: false, reason });

/** True if every changed path is within the allowed set (the boundary guard). */
export function boundaryCheck(changedPaths, allowed) {
	const allow = new Set(allowed);
	return changedPaths.length > 0 && changedPaths.every((p) => allow.has(p));
}

/**
 * Decide a claim.
 *
 * @param {object}   args
 * @param {object}   args.tasks         parseStateCsv() result
 * @param {object[]} args.locks         parseLocksCsv() result
 * @param {object}   args.intent        { task_id, kind }
 * @param {string}   args.author        PR author's GitHub login
 * @param {string[]} args.changedPaths  paths the PR changes
 * @param {string}   args.now           ISO-8601 timestamp to stamp the lock
 * @returns {{ ok: true, lock: object } | { ok: false, reason: string }}
 */
export function checkClaim({ tasks, locks, intent, author, changedPaths, now }) {
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
