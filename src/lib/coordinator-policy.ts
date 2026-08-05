import type { CommentRow, LockRow, ParsedState, TaskRow } from './campaign-tables.ts';
import type { CommandEnvelope } from './command-envelope.ts';

export type PullRequestKind = 'claim' | 'validation' | 'comment' | 'encoding';

export function numberFromConfig(configText: string | null, key: string, fallback: number): number {
	const match = new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm').exec(configText ?? '');
	return match ? Number(match[1]) : fallback;
}

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

/** Return the sole changed cell when the state table structure is unchanged. */
export function singleCellDiff(
	base: ParsedState,
	head: ParsedState
): { task_id: string; subtask_id: string; column: string; value: string } | null {
	if (base.header.join('\0') !== head.header.join('\0') || base.rows.length !== head.rows.length) {
		return null;
	}

	const diffs: Array<{ task_id: string; subtask_id: string; column: string; value: string }> = [];
	for (let i = 0; i < head.rows.length; i++) {
		const baseRow = base.rows[i];
		const headRow = head.rows[i];
		if (baseRow.task_id !== headRow.task_id || baseRow.subtask_id !== headRow.subtask_id) {
			return null;
		}
		for (const column of head.header) {
			if ((headRow[column] ?? '') !== (baseRow[column] ?? '')) {
				diffs.push({
					task_id: headRow.task_id,
					subtask_id: headRow.subtask_id,
					column,
					value: headRow[column] ?? ''
				});
			}
		}
	}
	return diffs.length === 1 ? diffs[0] : null;
}

export function validationVerdict(value: string): 'pass' | 'fail' | null {
	return value === 'pass' || value === 'fail' ? value : null;
}

/**
 * Return the task whose rows the head state resets to encoding — the shape a
 * send-back PR carries — or null for any other diff. A reset flips the task
 * row to encoding_required with attribution cleared, its subtasks to pending,
 * and empties every validation cell; nothing else may change.
 */
export function taskResetDiff(base: ParsedState, head: ParsedState): { task_id: string } | null {
	if (base.header.join('\0') !== head.header.join('\0') || base.rows.length !== head.rows.length) {
		return null;
	}
	const changed = new Set<string>();
	for (let i = 0; i < head.rows.length; i++) {
		const baseRow = base.rows[i];
		const headRow = head.rows[i];
		if (baseRow.task_id !== headRow.task_id || baseRow.subtask_id !== headRow.subtask_id) return null;
		for (const column of head.header) {
			if ((headRow[column] ?? '') !== (baseRow[column] ?? '')) changed.add(headRow.task_id);
		}
	}
	if (changed.size !== 1) return null;
	const [task_id] = changed;
	// Every row of the task — changed or already there — must sit at the reset.
	for (const row of head.rows) {
		if (row.task_id !== task_id) continue;
		const expectedStatus = row.subtask_id === '' ? 'encoding_required' : 'pending';
		if (row.status !== expectedStatus) return null;
		if (row.subtask_id === '' && (row.encoder !== '' || row.encoded_at !== '')) return null;
		for (const column of head.validationColumns) {
			if ((row[column] ?? '') !== '') return null;
		}
	}
	return { task_id };
}

const commentRowsEqual = (a: CommentRow, b: CommentRow): boolean =>
	(Object.keys(a) as Array<keyof CommentRow>).every((k) => a[k] === b[k]);

/**
 * Return the rows the head comment table appends to the base — the shape a
 * comment PR carries — or null when the base rows are not kept verbatim.
 */
export function appendedComments(base: CommentRow[], head: CommentRow[]): CommentRow[] | null {
	if (head.length <= base.length) return null;
	for (let i = 0; i < base.length; i++) {
		if (!commentRowsEqual(base[i], head[i])) return null;
	}
	return head.slice(base.length);
}

/**
 * Return the comment the head table resolves — exactly one row differing from
 * the base, only in `resolved` flipping '' → 'true' — or null otherwise.
 */
export function resolvedCommentDiff(base: CommentRow[], head: CommentRow[]): { comment_id: string } | null {
	if (base.length !== head.length) return null;
	let resolved: string | null = null;
	for (let i = 0; i < base.length; i++) {
		if (commentRowsEqual(base[i], head[i])) continue;
		const flipped = { ...base[i], resolved: 'true' };
		if (base[i].resolved !== '' || !commentRowsEqual(flipped, head[i])) return null;
		if (resolved !== null) return null;
		resolved = head[i].comment_id;
	}
	return resolved === null ? null : { comment_id: resolved };
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

export function classifyPullRequest(changedPaths: string[]): PullRequestKind {
	if (changedPaths.includes('tracking/lock.csv')) return 'claim';
	if (changedPaths.includes('tracking/state.csv')) return 'validation';
	if (changedPaths.includes('tracking/comment.csv')) return 'comment';
	return 'encoding';
}

export function shouldCleanupSubmission(kind: 'encoding' | 'validation', accepted: boolean): boolean {
	return accepted || kind === 'validation';
}
