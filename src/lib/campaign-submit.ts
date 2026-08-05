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
import type { ParsedState, TaskRow, LockRow, CommentRow } from './campaign-tables.ts';

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
	/**
	 * The comment row the PR adds to comment.csv, when it adds exactly one
	 * (parsed by the coordinator); null otherwise. A fail verdict requires it —
	 * the validator cannot fail an encoding without saying why.
	 */
	failComment: CommentRow | null;
	now: string;
}

/** Send-back intent: the failed task being returned to encoding. */
export interface SendBackIntent {
	task_id: string;
}

export interface CheckSendBackArgs {
	state: ParsedState;
	locks: LockRow[];
	intent: SendBackIntent;
	author: string;
	changedPaths: string[];
	/** Whether the author has push access to the campaign repo. */
	isCollaborator: boolean;
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
 * vehicle) — plus comment.csv on a fail, whose one added row carries the
 * mandatory explanation. The author must hold the subtask's active validation
 * lock, and there must be an open validate_status slot. On accept: the first
 * open slot becomes `<verdict>|<author>|<now>` and the validation lock is
 * removed. A fail is recorded in place — the task stays in validation until
 * someone sends it back for encoding (checkSendBack). On passes, the subtask
 * completes once `passThreshold` pass cells accumulate, and the task row
 * completes once every subtask has.
 */
export function checkValidation({ state, locks, intent, author, changedPaths, passThreshold, failComment, now }: CheckValidationArgs): SubmitResult {
	const row = findRow(state.rows, intent.task_id, intent.subtask_id);
	if (!row || intent.subtask_id === '') return reject('unknown_task');
	if (intent.verdict !== 'pass' && intent.verdict !== 'fail') return reject('invalid_verdict');
	if (intent.verdict === 'fail') {
		if (!boundaryCheck(changedPaths, ['tracking/state.csv', 'tracking/comment.csv'])) {
			return reject('out_of_bounds');
		}
		if (
			!failComment ||
			failComment.kind !== 'fail' ||
			failComment.task_id !== intent.task_id ||
			failComment.subtask_id !== intent.subtask_id ||
			failComment.body.trim() === ''
		) {
			return reject('fail_without_comment');
		}
	} else if (!boundaryCheck(changedPaths, ['tracking/state.csv'])) {
		return reject('out_of_bounds');
	}
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

/**
 * Sending a failed task back for encoding — the explicit follow-up to a fail
 * verdict. The PR may change only state.csv (carrying the reset), the task
 * must be in validation with at least one recorded fail, and the author must
 * be one of the failing validators or hold push access. On accept: the task
 * returns to encoding_required with attribution cleared, its subtasks return
 * to pending, all validation cells are cleared, and every lock on the task is
 * released.
 */
export function checkSendBack({ state, locks, intent, author, changedPaths, isCollaborator }: CheckSendBackArgs): SubmitResult {
	const row = findRow(state.rows, intent.task_id, '');
	if (!row) return reject('unknown_task');
	if (!boundaryCheck(changedPaths, ['tracking/state.csv'])) return reject('out_of_bounds');
	if (row.status !== 'validation_required') return reject('wrong_state');

	const subtasks = state.rows.filter((r) => r.task_id === intent.task_id && r.subtask_id !== '');
	const failCells = subtasks.flatMap((r) =>
		state.validationColumns.map((c) => r[c] ?? '').filter((cell) => isFinalValidation(cell) && cell.startsWith('fail|'))
	);
	if (failCells.length === 0) return reject('no_recorded_fail');
	const failAuthors = failCells.map((cell) => cell.split('|')[1]);
	if (!isCollaborator && !failAuthors.includes(author)) return reject('not_permitted');

	const next = cloneState(state);
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

// ---------------------------------------------------------------------------
// Comments (discussion): adding and resolving rows of comment.csv.

export interface CheckCommentArgs {
	state: ParsedState;
	/** The base comment table the PR builds on. */
	comments: CommentRow[];
	/** The one row the PR appends to comment.csv; null when the PR is not a clean single-row append. */
	added: CommentRow | null;
	author: string;
	changedPaths: string[];
	now: string;
	/** The comment_id the automation assigns to the accepted row. */
	newId: string;
}

export type CommentResult = { ok: true; row: CommentRow } | { ok: false; reason: string };

const DISCUSSION_KINDS = ['question', 'addition', 'reply'];

/**
 * A discussion comment. The PR may only append one row to comment.csv; `fail`
 * comments never arrive this way (they ride the fail-validation PR). The
 * automation authors the id, author and timestamp — never the fork's values.
 */
export function checkComment({ state, comments, added, author, changedPaths, now, newId }: CheckCommentArgs): CommentResult {
	if (!boundaryCheck(changedPaths, ['tracking/comment.csv'])) return { ok: false, reason: 'out_of_bounds' };
	if (!added) return { ok: false, reason: 'malformed_comment' };
	if (!DISCUSSION_KINDS.includes(added.kind)) return { ok: false, reason: 'invalid_kind' };
	if (added.body.trim() === '') return { ok: false, reason: 'empty_comment' };
	if (!findRow(state.rows, added.task_id, '')) return { ok: false, reason: 'unknown_task' };
	if (added.kind === 'reply') {
		if (!comments.some((c) => c.comment_id === added.parent_id)) return { ok: false, reason: 'unknown_parent' };
	} else if (added.parent_id !== '') {
		return { ok: false, reason: 'invalid_parent' };
	}
	return {
		ok: true,
		row: { ...added, comment_id: newId, author_id: author, timestamp: now, resolved: '' }
	};
}

export interface CheckResolveCommentArgs {
	comments: CommentRow[];
	/** The comment the PR marks resolved. */
	comment_id: string;
	author: string;
	changedPaths: string[];
	/** Whether the author has push access to the campaign repo. */
	isCollaborator: boolean;
}

/**
 * Resolving a comment (greying it out of the attention counts) is
 * owner/author-only: the comment's author or anyone with push access.
 */
export function checkResolveComment({ comments, comment_id, author, changedPaths, isCollaborator }: CheckResolveCommentArgs): CommentResult {
	if (!boundaryCheck(changedPaths, ['tracking/comment.csv'])) return { ok: false, reason: 'out_of_bounds' };
	const row = comments.find((c) => c.comment_id === comment_id);
	if (!row) return { ok: false, reason: 'unknown_comment' };
	if (row.resolved === 'true') return { ok: false, reason: 'already_resolved' };
	if (!isCollaborator && row.author_id !== author) return { ok: false, reason: 'not_permitted' };
	return { ok: true, row: { ...row, resolved: 'true' } };
}
