import { COMMENT_COLUMNS, parseCsv } from './campaign-tables.ts';
import type { CommentRow, LockRow, StateRow, TaskRow } from './campaign-tables.ts';
import { resetTaskRows } from './campaign-submit.ts';
import type { CommandEnvelope } from './command-envelope.ts';

export type PullRequestKind = 'claim' | 'validation' | 'comment' | 'encoding';

/**
 * The kind of the config.yaml piece whose path is `path`, or null when no
 * piece carries it. Reads the canonical shape configToYaml emits — each piece
 * entry opens with `- id:` and lists `kind:` and `path:` as quoted scalars —
 * so the coordinator can tell a physical piece (page spans joined wholesale)
 * from a facsimile one (measures matched by id) without a YAML parser.
 */
export function pieceKindForPath(configText: string | null, path: string): string | null {
	for (const entry of (configText ?? '').split(/^\s*- id:/m).slice(1)) {
		const kind = /^\s*kind:\s*"((?:[^"\\]|\\.)*)"/m.exec(entry);
		const entryPath = /^\s*path:\s*"((?:[^"\\]|\\.)*)"/m.exec(entry);
		if (!kind || !entryPath) continue;
		if (JSON.parse(`"${entryPath[1]}"`) === path) return JSON.parse(`"${kind[1]}"`);
	}
	return null;
}

/** Return the sole added CSV row in a patch that removes no rows. */
export function addedRowFromPatch(patch: string | undefined): string | null {
	if (!patch) return null;
	const added: string[] = [];
	let removed = 0;
	for (const line of patch.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('---')) continue;
		if (line.startsWith('+')) added.push(line.slice(1));
		else if (line.startsWith('-')) removed++;
	}
	return removed === 0 && added.length === 1 ? added[0] : null;
}

// The CSV records a unified-diff patch removes and adds, parsed with full CSV
// quoting (a quoted field may span several patch lines; the physical lines of
// one record are contiguous within their +/- group). Null when there is no
// patch at all.
function csvRowsFromPatch(patch: string | undefined): { added: string[][]; removed: string[][] } | null {
	if (!patch) return null;
	const added: string[] = [];
	const removed: string[] = [];
	for (const line of patch.split('\n')) {
		if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue;
		if (line.startsWith('+')) added.push(line.slice(1));
		else if (line.startsWith('-')) removed.push(line.slice(1));
	}
	return { added: parseCsv(added.join('\n')), removed: parseCsv(removed.join('\n')) };
}

/**
 * The sole changed cell a state.csv patch carries — the shape a verdict PR
 * has, relative to the PR's own merge base — or null for any other diff.
 * The cell index is mapped to a column name via `header` (the current state
 * header; the base columns and validation slots are positionally stable).
 */
export function validationIntentFromPatch(
	patch: string | undefined,
	header: string[]
): { task_id: string; subtask_id: string; column: string; value: string } | null {
	const rows = csvRowsFromPatch(patch);
	if (!rows || rows.added.length !== 1 || rows.removed.length !== 1) return null;
	const [base] = rows.removed;
	const [head] = rows.added;
	if ((head[0] ?? '') === '' || base[0] !== head[0] || (base[1] ?? '') !== (head[1] ?? '')) return null;
	const width = Math.max(base.length, head.length, header.length);
	let diff: { column: string; value: string } | null = null;
	for (let i = 0; i < width; i++) {
		if ((base[i] ?? '') === (head[i] ?? '')) continue;
		if (diff || i >= header.length) return null;
		diff = { column: header[i], value: head[i] ?? '' };
	}
	return diff ? { task_id: head[0], subtask_id: head[1] ?? '', ...diff } : null;
}

export function validationVerdict(value: string): 'pass' | 'fail' | null {
	return value === 'pass' || value === 'fail' ? value : null;
}

/**
 * The task whose rows a state.csv patch resets to encoding — the shape a
 * send-back PR carries, relative to the PR's own merge base — or null for any
 * other diff. Every changed row must belong to one task and carry exactly the
 * reset resetTaskRows writes; nothing else may change.
 */
export function taskResetFromPatch(
	patch: string | undefined,
	header: string[],
	validationColumns: string[]
): { task_id: string } | null {
	const rows = csvRowsFromPatch(patch);
	if (!rows || rows.added.length === 0 || rows.added.length !== rows.removed.length) return null;
	const toRow = (cells: string[]): StateRow =>
		Object.fromEntries(header.map((column, i) => [column, cells[i] ?? ''])) as StateRow;
	const base = rows.removed.map(toRow);
	const head = rows.added.map(toRow);
	const task_id = head[0].task_id;
	if (task_id === '') return null;
	for (let i = 0; i < head.length; i++) {
		if (head[i].task_id !== task_id || base[i].task_id !== task_id) return null;
		if (base[i].subtask_id !== head[i].subtask_id) return null;
	}
	const expected = base.map((r) => ({ ...r }));
	resetTaskRows(expected, validationColumns, task_id);
	for (let i = 0; i < head.length; i++) {
		for (const column of header) {
			if ((expected[i][column] ?? '') !== (head[i][column] ?? '')) return null;
		}
	}
	return { task_id };
}

/**
 * The rows a comment.csv patch appends — the shape a comment PR carries,
 * relative to the PR's own merge base — or null when it removes or edits
 * anything.
 */
export function appendedCommentsFromPatch(patch: string | undefined): CommentRow[] | null {
	const rows = csvRowsFromPatch(patch);
	if (!rows || rows.removed.length !== 0 || rows.added.length === 0) return null;
	return rows.added.map(
		(cells) =>
			Object.fromEntries(COMMENT_COLUMNS.map((column, i) => [column, cells[i] ?? ''])) as unknown as CommentRow
	);
}

const RESOLVED_CELL = COMMENT_COLUMNS.indexOf('resolved');
const PARENT_CELL = COMMENT_COLUMNS.indexOf('parent_id');

/**
 * The top-level comment a comment.csv patch resolves — every changed row only
 * flips `resolved` '' → 'true', and exactly one of them is top-level (empty
 * parent_id) — or null for any other diff. Flipped replies ride along; the
 * coordinator resolves the root's whole thread authoritatively.
 */
export function resolvedCommentFromPatch(patch: string | undefined): { comment_id: string } | null {
	const rows = csvRowsFromPatch(patch);
	if (!rows || rows.added.length === 0 || rows.added.length !== rows.removed.length) return null;
	let root: string | null = null;
	for (let i = 0; i < rows.added.length; i++) {
		const base = rows.removed[i];
		const head = rows.added[i];
		if ((head[0] ?? '') === '' || (base[0] ?? '') !== (head[0] ?? '')) return null;
		const width = Math.max(base.length, head.length);
		for (let j = 0; j < width; j++) {
			if ((base[j] ?? '') === (head[j] ?? '')) continue;
			if (j !== RESOLVED_CELL || (base[j] ?? '') !== '' || (head[j] ?? '') !== 'true') return null;
		}
		if ((head[PARENT_CELL] ?? '') === '') {
			if (root !== null) return null;
			root = head[0];
		}
	}
	return root === null ? null : { comment_id: root };
}

export function resolveEncodingTask(options: {
	tasks: TaskRow[];
	locks: LockRow[];
	changedPaths: string[];
	envelope: CommandEnvelope | null;
	headRef: string;
	author: string;
}): TaskRow | undefined {
	const { tasks, locks, changedPaths, envelope, headRef, author } = options;
	const candidates = tasks.filter((task) => task.subtask_id === '' && changedPaths.includes(task.fragment));
	if (candidates.length <= 1) return candidates[0];

	const claimed = String(envelope?.input?.task_id ?? '');
	const byEnvelope = candidates.find((task) => task.task_id === claimed);
	if (byEnvelope) return byEnvelope;

	const byBranch = candidates.find((task) => headRef === `encode-${task.task_id}`);
	if (byBranch) return byBranch;

	const held = candidates.filter((task) =>
		locks.some(
			(lock) =>
				lock.task_id === task.task_id &&
				lock.subtask_id === '' &&
				lock.kind === 'encoding' &&
				lock.user_id === author
		)
	);
	return held.length === 1 ? held[0] : undefined;
}

/**
 * Whether a pull request changes a tracking table or a source — the paths the
 * campaign workflow triggers on; any other pull request is not a campaign
 * operation.
 */
export function touchesCampaignPaths(changedPaths: string[]): boolean {
	return changedPaths.some((p) => p.startsWith('tracking/') || p.startsWith('sources/'));
}

export function classifyPullRequest(changedPaths: string[]): PullRequestKind {
	if (changedPaths.includes('tracking/lock.csv')) return 'claim';
	if (changedPaths.includes('tracking/state.csv')) return 'validation';
	if (changedPaths.includes('tracking/comment.csv')) return 'comment';
	return 'encoding';
}

export function shouldCleanupSubmission(kind: 'encoding' | 'validation', accepted: boolean): boolean {
	return accepted || kind === 'validation';
}
