import type { LockRow, ParsedState, TaskRow } from './campaign-tables.ts';
import type { CommandEnvelope } from './command-envelope.ts';

export type PullRequestKind = 'claim' | 'validation' | 'encoding';

export function numberFromConfig(configText: string | null, key: string, fallback: number): number {
	const match = new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm').exec(configText ?? '');
	return match ? Number(match[1]) : fallback;
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
	return 'encoding';
}

export function shouldCleanupSubmission(kind: 'encoding' | 'validation', accepted: boolean): boolean {
	return accepted || kind === 'validation';
}
