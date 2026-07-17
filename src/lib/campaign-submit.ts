// Submission validation (encoding and validation outcome), with state
// advancement + attribution folded in. Pure decision logic: current tables +
// PR facts in, accept (with the mutated tables) or reject out. No GitHub.
// See DESIGN.md §6 (volunteer PR contract).
//
// Addressing follows the (task_id, subtask_id) convention: an encoding targets
// the task row (empty subtask_id), a validation targets one subtask row.
// The Action authors all table mutations: encoder/validator identity is the
// PR author and timestamps are the injected `now`, never values the fork
// supplied. The volunteer's MEI *content* is handled by the coordinator (it
// merges/commits the fork's bytes after `meiValid`); these functions only
// produce the authoritative table changes.

import { boundaryCheck } from './campaign-claim.ts';
import { findRow, isFinalValidation } from './campaign-tables.ts';
import type { ParsedState, TaskRow, LockRow } from './campaign-tables.ts';

/** Encoding submission intent: just the task being encoded. */
export interface EncodingIntent {
	task_id: string;
}

/** Validation submission intent: the subtask and the verdict being recorded. */
export interface ValidationIntent {
	task_id: string;
	subtask_id: string;
	verdict: string;
}

export interface CheckEncodingArgs {
	tasks: TaskRow[];
	state: ParsedState;
	locks: LockRow[];
	intent: EncodingIntent;
	author: string;
	changedPaths: string[];
	meiValid: boolean;
	now: string;
}

export interface CheckValidationArgs {
	state: ParsedState;
	locks: LockRow[];
	intent: ValidationIntent;
	author: string;
	changedPaths: string[];
	passThreshold: number;
	now: string;
}

export type SubmitResult =
	| { ok: true; state: ParsedState; locks: LockRow[] }
	| { ok: false; reason: string };

const reject = (reason: string): SubmitResult => ({ ok: false, reason });

function cloneState(state: ParsedState): ParsedState {
	return {
		header: [...state.header],
		validationColumns: [...state.validationColumns],
		rows: state.rows.map((r) => ({ ...r }))
	};
}

/**
 * Encoding submission. The PR may change only the task's fragment, the author
 * must hold the active encoding lock, and the MEI must pass the machine-check
 * (`meiValid`, computed by the coordinator). On accept: the task row advances
 * to validation_required with encoder/encoded_at set, its pending subtasks
 * open for validation, and the encoding lock is removed. A task with no
 * validation subtasks completes directly on its accepted submission.
 */
export function checkEncoding({ tasks, state, locks, intent, author, changedPaths, meiValid, now }: CheckEncodingArgs): SubmitResult {
	const task = findRow(tasks, intent.task_id, '');
	const row = findRow(state.rows, intent.task_id, '');
	if (!task || !row) return reject('unknown_task');
	if (!boundaryCheck(changedPaths, [task.fragment])) return reject('out_of_bounds');
	if (row.status !== 'encoding_required') return reject('wrong_state');

	const holdsLock = locks.some(
		(l) => l.task_id === intent.task_id && l.subtask_id === '' && l.kind === 'encoding' && l.user_id === author
	);
	if (!holdsLock) return reject('not_lock_holder');
	if (!meiValid) return reject('mei_invalid');

	const hasSubtasks = state.rows.some((r) => r.task_id === intent.task_id && r.subtask_id !== '');
	const next = cloneState(state);
	for (const r of next.rows) {
		if (r.task_id !== intent.task_id) continue;
		if (r.subtask_id === '') {
			r.status = hasSubtasks ? 'validation_required' : 'completed';
			r.encoder = author;
			r.encoded_at = now;
		} else if (r.status === 'pending') {
			r.status = 'validation_required';
		}
	}

	const nextLocks = locks.filter(
		(l) => !(l.task_id === intent.task_id && l.subtask_id === '' && l.kind === 'encoding' && l.user_id === author)
	);
	return { ok: true, state: next, locks: nextLocks };
}

/**
 * Validation outcome. The PR may change only state.csv (as the verdict
 * vehicle), the author must hold the subtask's active validation lock, and
 * there must be an open validate_status slot. On accept: the first open slot
 * becomes `<verdict>|<author>|<now>` and the validation lock is removed. A
 * failure invalidates the encoding: the task returns to encoding_required,
 * its subtasks return to pending, stale validation cells and attribution are
 * cleared, and all locks for the task are released. On passes, the subtask
 * completes once `passThreshold` pass cells accumulate, and the task row
 * completes once every subtask has.
 */
export function checkValidation({ state, locks, intent, author, changedPaths, passThreshold, now }: CheckValidationArgs): SubmitResult {
	const row = findRow(state.rows, intent.task_id, intent.subtask_id);
	if (!row || intent.subtask_id === '') return reject('unknown_task');
	if (!boundaryCheck(changedPaths, ['tracking/state.csv'])) return reject('out_of_bounds');
	if (intent.verdict !== 'pass' && intent.verdict !== 'fail') return reject('invalid_verdict');
	if (row.status !== 'validation_required') return reject('wrong_state');

	const holdsLock = locks.some(
		(l) =>
			l.task_id === intent.task_id &&
			l.subtask_id === intent.subtask_id &&
			l.kind === 'validation' &&
			l.user_id === author
	);
	if (!holdsLock) return reject('not_lock_holder');

	const slot = state.validationColumns.find((c) => (row[c] ?? '') === '');
	if (!slot) return reject('no_open_validation_slot');

	const next = cloneState(state);
	const nextRow = findRow(next.rows, intent.task_id, intent.subtask_id)!;
	nextRow[slot] = `${intent.verdict}|${author}|${now}`;

	if (intent.verdict === 'fail') {
		for (const r of next.rows) {
			if (r.task_id !== intent.task_id) continue;
			if (r.subtask_id === '') {
				r.status = 'encoding_required';
				r.encoder = '';
				r.encoded_at = '';
			} else {
				r.status = 'pending';
			}
			for (const column of next.validationColumns) r[column] = '';
		}
		return {
			ok: true,
			state: next,
			locks: locks.filter((l) => l.task_id !== intent.task_id)
		};
	}

	const passCount = next.validationColumns.filter((c) => {
		const cell = nextRow[c] ?? '';
		return isFinalValidation(cell) && cell.startsWith('pass|');
	}).length;
	if (passCount >= passThreshold) nextRow.status = 'completed';

	// The task completes when its last subtask does.
	const subtasks = next.rows.filter((r) => r.task_id === intent.task_id && r.subtask_id !== '');
	if (subtasks.every((r) => r.status === 'completed')) {
		findRow(next.rows, intent.task_id, '')!.status = 'completed';
	}

	const nextLocks = locks.filter(
		(l) =>
			!(
				l.task_id === intent.task_id &&
				l.subtask_id === intent.subtask_id &&
				l.kind === 'validation' &&
				l.user_id === author
			)
	);
	return { ok: true, state: next, locks: nextLocks };
}
