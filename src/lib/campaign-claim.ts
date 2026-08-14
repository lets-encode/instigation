// Claim (lock) validation. Pure decision logic: given the current tracking
// tables, a claim intent, and the PR author, decide whether the claim is
// allowed and, if so, the authoritative lock row to write. No GitHub.
//
// Addressing follows the (task_id, subtask_id) convention: an encoding claim
// targets the task row (empty subtask_id), a validation claim targets one
// subtask row. Per DESIGN.md §6 the Action is the sole author of the lock
// row — `user_id` is the PR author and `timestamp` is server time (passed in
// as `now`), never values the fork supplied.

import { findRow, isFinalValidation } from './campaign-tables.ts';
import type { ParsedState, TaskRow, LockRow } from './campaign-tables.ts';

/** What a PR is trying to claim: a task or subtask and the kind of work. */
export interface ClaimIntent {
	task_id: string;
	subtask_id: string;
	kind: string;
}

export interface CheckClaimArgs {
	tasks: TaskRow[];
	state: ParsedState;
	locks: LockRow[];
	intent: ClaimIntent;
	/** PR author's GitHub numeric account id (stable across username changes). */
	author: string;
	/** Paths the PR changes. */
	changedPaths: string[];
	/** ISO-8601 timestamp to stamp the lock. */
	now: string;
	/** config.yaml allow_self_validation: the encoder may validate their own work. */
	allowSelfValidation?: boolean;
	/** Pass verdicts that complete a subtask; defaults to the slot count. */
	passThreshold?: number;
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
export function checkClaim({
	tasks,
	state,
	locks,
	intent,
	author,
	changedPaths,
	now,
	allowSelfValidation,
	passThreshold
}: CheckClaimArgs): ClaimResult {
	// A claim may only touch the lock table.
	if (!boundaryCheck(changedPaths, ['tracking/lock.csv'])) return reject('out_of_bounds');

	if (!CLAIM_KINDS.includes(intent.kind)) return reject('invalid_kind');
	// Encoding is task-level, validation is subtask-level — the key must match.
	if (intent.kind === 'encoding' && intent.subtask_id !== '') return reject('invalid_target');
	if (intent.kind === 'validation' && intent.subtask_id === '') return reject('invalid_target');

	const row = findRow(state.rows, intent.task_id, intent.subtask_id);
	if (!row) return reject('unknown_task');

	// Dependency gate: a task chained after another (task.csv depends_on) opens
	// only once that task has completed.
	const dependsOn = findRow(tasks, intent.task_id, '')?.depends_on;
	if (dependsOn && findRow(state.rows, dependsOn, '')?.status !== 'completed') {
		return reject('dependency_incomplete');
	}

	const activeSameKind = locks.filter(
		(l) => l.task_id === intent.task_id && l.subtask_id === intent.subtask_id && l.kind === intent.kind
	);

	if (intent.kind === 'encoding') {
		if (row.status !== 'encoding_required') return reject('wrong_state');
		if (activeSameKind.length > 0) return reject('already_locked');
	} else {
		if (row.status !== 'validation_required') return reject('wrong_state');
		// The encoder is recorded on the task row; no validating your own
		// encoding, unless the campaign's config allows it.
		const taskRow = findRow(state.rows, intent.task_id, '');
		if (!allowSelfValidation && author === taskRow?.encoder) return reject('self_validation');
		// One verdict per person: a validator who already recorded pass/fail on
		// this subtask cannot claim another of its slots. The same config flag
		// lifts it — a single-person campaign fills every slot themselves.
		const hasVerdict = state.validationColumns.some((c) => {
			const cell = row[c] ?? '';
			return isFinalValidation(cell) && cell.split('|')[1] === author;
		});
		if (!allowSelfValidation && hasVerdict) return reject('already_validated');

		// Open slot = (final pass/fail cells) + (active validation locks) < slots.
		const finals = state.validationColumns.filter((c) => isFinalValidation(row[c] ?? '')).length;
		if (finals + activeSameKind.length >= state.validationColumns.length) {
			return reject('no_open_validation_slot');
		}
		// A verdict can only land while the subtask needs more passes: once
		// recorded passes plus active locks reach the pass threshold, a further
		// claim's verdict would arrive after completion and be rejected.
		const slots = state.validationColumns.length;
		const needed = Math.min(passThreshold ?? slots, slots);
		const passes = state.validationColumns.filter((c) => {
			const cell = row[c] ?? '';
			return isFinalValidation(cell) && cell.startsWith('pass|');
		}).length;
		if (passes + activeSameKind.length >= needed) return reject('no_open_validation_slot');
		if (activeSameKind.some((l) => l.user_id === author)) return reject('already_locked');
	}

	return {
		ok: true,
		lock: {
			task_id: intent.task_id,
			subtask_id: intent.subtask_id,
			user_id: author,
			timestamp: now,
			kind: intent.kind
		}
	};
}
