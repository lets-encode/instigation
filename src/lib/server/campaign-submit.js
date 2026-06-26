// Action C — submission validation (encoding and validation outcome), with
// Action D (state advancement + attribution) folded in. Pure decision logic:
// current tables + PR facts in, accept (with the mutated tables) or reject out.
// No GitHub. See DESIGN.md §6 (volunteer PR contract).
//
// As with claims, the Action authors all table mutations: encoder/validator
// identity is the PR author and timestamps are the injected `now`, never values
// the fork supplied. The volunteer's MEI *content* is handled by the workflow
// shell (it merges/commits the fork's bytes after `meiValid`); these functions
// only produce the authoritative table changes.

import { boundaryCheck } from './campaign-claim.js';

const reject = (reason) => ({ ok: false, reason });

function cloneTasks(tasks) {
	return {
		header: [...tasks.header],
		validationColumns: [...tasks.validationColumns],
		rows: tasks.rows.map((r) => ({ ...r }))
	};
}

/**
 * Encoding submission. The PR may change only the task's fragment, the author
 * must hold the active encoding lock, and the MEI must pass the machine-check
 * (`meiValid`, computed by the shell). On accept: state → validation_required
 * with encoder/encoded_at set, and the encoding lock removed.
 */
export function checkEncoding({ tasks, locks, intent, author, changedPaths, meiValid, now }) {
	const task = tasks.rows.find((r) => r.task_id === intent.task_id);
	if (!task) return reject('unknown_task');
	if (!boundaryCheck(changedPaths, [task.fragment])) return reject('out_of_bounds');
	if (task.state !== 'encoding_required') return reject('wrong_state');

	const holdsLock = locks.some(
		(l) => l.task_id === intent.task_id && l.kind === 'encoding' && l.locked_by === author
	);
	if (!holdsLock) return reject('not_lock_holder');
	if (!meiValid) return reject('mei_invalid');

	const next = cloneTasks(tasks);
	const row = next.rows.find((r) => r.task_id === intent.task_id);
	row.encoder = author;
	row.encoded_at = now;
	row.state = 'validation_required';

	const nextLocks = locks.filter(
		(l) => !(l.task_id === intent.task_id && l.kind === 'encoding' && l.locked_by === author)
	);
	return { ok: true, tasks: next, locks: nextLocks };
}

/**
 * Validation outcome. The PR may change only state.csv (as the verdict
 * vehicle), the author must hold the active validation lock, and there must be
 * an open vN slot. On accept: the first open slot becomes
 * `<verdict>|<author>|<now>`, the validation lock is removed, and — folding in
 * Action D — the task advances to `completed` once `passThreshold` pass cells
 * accumulate.
 */
export function checkValidation({ tasks, locks, intent, author, changedPaths, passThreshold, now }) {
	const task = tasks.rows.find((r) => r.task_id === intent.task_id);
	if (!task) return reject('unknown_task');
	if (!boundaryCheck(changedPaths, ['tracking/state.csv'])) return reject('out_of_bounds');
	if (intent.verdict !== 'pass' && intent.verdict !== 'fail') return reject('invalid_verdict');
	if (task.state !== 'validation_required') return reject('wrong_state');

	const holdsLock = locks.some(
		(l) => l.task_id === intent.task_id && l.kind === 'validation' && l.locked_by === author
	);
	if (!holdsLock) return reject('not_lock_holder');

	const slot = tasks.validationColumns.find((c) => (task[c] ?? '') === '');
	if (!slot) return reject('no_open_validation_slot');

	const next = cloneTasks(tasks);
	const row = next.rows.find((r) => r.task_id === intent.task_id);
	row[slot] = `${intent.verdict}|${author}|${now}`;

	const passCount = next.validationColumns.filter((c) => (row[c] ?? '').startsWith('pass|')).length;
	if (passCount >= passThreshold) row.state = 'completed';

	const nextLocks = locks.filter(
		(l) => !(l.task_id === intent.task_id && l.kind === 'validation' && l.locked_by === author)
	);
	return { ok: true, tasks: next, locks: nextLocks };
}
