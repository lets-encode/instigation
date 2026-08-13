// The task projection: a pure projection of the tracking tables into per-task
// display state — status keys, validation slots and the viewer's next step.
// No authoritative state lives here — everything derives from task.csv,
// state.csv, lock.csv and config.yaml, so the projection re-derives on every
// table refresh. No Svelte, no GitHub.

import { isFinalValidation } from './campaign-tables.ts';
import type { TaskRow, StateRow, LockRow } from './campaign-tables.ts';

/**
 * Numeric account id → current login. The tables key people by their stable
 * numeric id; the console resolves logins for display and passes them in. An
 * unresolved id falls back to showing the id itself.
 */
export type Logins = Record<string, string>;

/** The display handle for a stored user id: its login, or the id if unresolved. */
export const handle = (logins: Logins, id: string): string => logins[id] || id;

/** The tables (and config) the projection is derived from. */
export interface GraphData {
	taskDefs: TaskRow[];
	rows: StateRow[];
	validationColumns: string[];
	locks: LockRow[];
	passThreshold: number;
	/** validation.allow_self_validation from config.yaml: the encoder may validate their own work. */
	allowSelfValidation?: boolean;
}

/** Status keys shared by node pills, chips and the tables view. */
export type StatusKey =
	| 'completed'
	| 'encoding_required'
	| 'encoding'
	| 'claimed'
	| 'validation_required'
	| 'pending'
	| 'blocked'
	| 'pass'
	| 'fail'
	| 'review'
	| 'open';

const STATUS_LABELS: Record<StatusKey, string> = {
	completed: '✓ completed',
	encoding_required: 'encoding required',
	encoding: '● encoding',
	claimed: '● claimed',
	validation_required: 'validation',
	pending: 'pending',
	blocked: 'blocked',
	pass: '✓ pass',
	fail: '✗ fail',
	review: 'review',
	open: '○ open'
};

/**
 * The pill label for a status key, aware of measure-correction (pre) tasks:
 * an unclaimed pre-task reads as "action required" rather than "encoding
 * required", since no encoding happens at that stage.
 */
export const statusPill = (key: StatusKey, pre = false): string =>
	pre && key === 'encoding_required' ? 'action required' : STATUS_LABELS[key];

/** One validation slot on its task node. */
export interface NodeSlot {
	sub: string;
	slot: number;
	key: StatusKey;
	label: string;
	who: string;
	running: boolean;
	/** The slot is open and the encoding is in — it can be claimed for review. */
	claimable: boolean;
	/** The stored user id behind the slot (verdict author or lock holder); '' when open. */
	user: string;
	/** The verdict's or lock's timestamp; '' when open. */
	ts: string;
}

/** One task's projected display state. */
export interface TaskNode {
	task: string;
	kind: 'pre' | 'encode';
	statusKey: StatusKey;
	slots: NodeSlot[];
	passes: number;
	threshold: number;
	/** The first node the viewer can act on right now. */
	nextUp: boolean;
}

/**
 * Whether a task is a facsimile pre-task (measure correction, reviewed in the
 * zone editor). Encoding tasks — whole-file (empty locator) and per-page
 * (`surface-N`) — are not pre-tasks and use mei-friend.
 */
export function isPreTask(locator: string): boolean {
	return locator === 'measure-zones';
}

/** The task's human type from its locator. */
export function typeLabel(locator: string): string {
	if (locator === 'measure-zones') return 'Measure correction';
	const page = /^surface-(\d+)$/.exec(locator);
	return page ? `Encoding · page ${page[1]}` : 'Encoding';
}

// ---------------------------------------------------------------------------
// Table lookups. The tables arrive as freshly parsed arrays on every refresh,
// so each index is built once per array (keyed on array identity) and every
// lookup after it is O(1). The contract this relies on: parsed table arrays
// are replaced, never mutated in place.

const defIndexes = new WeakMap<TaskRow[], Map<string, TaskRow>>();
function taskDefIndex(defs: TaskRow[]): Map<string, TaskRow> {
	let index = defIndexes.get(defs);
	if (!index) {
		index = new Map();
		for (const t of defs) if (t.subtask_id === '') index.set(t.task_id, t);
		defIndexes.set(defs, index);
	}
	return index;
}

const stateIndexes = new WeakMap<
	StateRow[],
	{ main: Map<string, StateRow>; subs: Map<string, StateRow[]> }
>();
function stateIndex(rows: StateRow[]) {
	let index = stateIndexes.get(rows);
	if (!index) {
		index = { main: new Map(), subs: new Map() };
		for (const r of rows) {
			if (r.subtask_id === '') index.main.set(r.task_id, r);
			else {
				const list = index.subs.get(r.task_id);
				if (list) list.push(r);
				else index.subs.set(r.task_id, [r]);
			}
		}
		stateIndexes.set(rows, index);
	}
	return index;
}

const lockIndexes = new WeakMap<LockRow[], Map<string, LockRow[]>>();
function lockIndex(locks: LockRow[]): Map<string, LockRow[]> {
	let index = lockIndexes.get(locks);
	if (!index) {
		index = new Map();
		for (const l of locks) {
			const key = `${l.task_id}|${l.subtask_id}|${l.kind}`;
			const list = index.get(key);
			if (list) list.push(l);
			else index.set(key, [l]);
		}
		lockIndexes.set(locks, index);
	}
	return index;
}

const taskDef = (d: GraphData, task: string) => taskDefIndex(d.taskDefs).get(task);
const taskState = (d: GraphData, task: string) => stateIndex(d.rows).main.get(task);
const subRowsOf = (d: GraphData, task: string) => stateIndex(d.rows).subs.get(task) ?? [];

const encodingLock = (d: GraphData, task: string) =>
	lockIndex(d.locks).get(`${task}||encoding`)?.[0];
// Table order is preserved per key, which the slot assignment relies on.
const validationLocks = (d: GraphData, task: string, sub: string) =>
	lockIndex(d.locks).get(`${task}|${sub}|validation`) ?? [];

/** The incomplete task this task waits for (task.csv depends_on), or ''. */
export function blockedBy(d: GraphData, task: string): string {
	const dep = taskDef(d, task)?.depends_on;
	if (!dep || taskState(d, dep)?.status === 'completed') return '';
	return dep;
}

const isEncoded = (status: string) => status === 'validation_required' || status === 'completed';

const cellsOf = (d: GraphData, row: StateRow) => d.validationColumns.map((c) => row[c] ?? '');
const passesOf = (d: GraphData, row: StateRow) =>
	cellsOf(d, row).filter((c) => isFinalValidation(c) && c.startsWith('pass|')).length;

// Validation locks do not carry a slot number. Assign them in table order to
// the still-empty validation cells, which is the same order submissions fill.
const validationLockForSlot = (d: GraphData, row: StateRow, slot: number) => {
	const cells = cellsOf(d, row);
	if (cells[slot] !== '') return undefined;
	const emptyIndex = cells.slice(0, slot).filter((cell) => cell === '').length;
	return validationLocks(d, row.task_id, row.subtask_id)[emptyIndex];
};

const nextUnreservedSlot = (d: GraphData, row: StateRow): number =>
	cellsOf(d, row).findIndex((cell, slot) => cell === '' && !validationLockForSlot(d, row, slot));

// The main node's status key: blocked wins, then a held encoding lock, then
// the state.csv status itself. A claimed facsimile pre-task (measure
// correction) reads as 'claimed' rather than 'encoding' — the work is a
// correction on the facsimile, not an encoding pass.
function mainStatusKey(d: GraphData, task: string): StatusKey {
	if (blockedBy(d, task)) return 'blocked';
	const status = taskState(d, task)?.status ?? 'pending';
	if (status === 'encoding_required' && encodingLock(d, task)) {
		return isPreTask(taskDef(d, task)?.locator ?? '') ? 'claimed' : 'encoding';
	}
	if (status in STATUS_LABELS) return status as StatusKey;
	return 'pending';
}

/** One validation slot's derived display state. */
interface SlotState {
	key: StatusKey;
	sub: string;
	running: boolean;
	user: string;
	ts: string;
}

// The slot's state from its validate_status cell: a final verdict renders
// solid, active locks occupy separate empty slots, and the rest are open.
// `viewer` tailors the open-slot text: the encoder cannot validate their own
// work, so they see that another volunteer is needed rather than a claim prompt.
function slotState(d: GraphData, row: StateRow, slot: number, viewer = '', logins: Logins = {}): SlotState {
	const cell = cellsOf(d, row)[slot] ?? '';
	if (isFinalValidation(cell)) {
		const [verdict, user, ts] = cell.split('|');
		return { key: verdict as StatusKey, sub: `@${handle(logins, user)} · ${verdict}`, running: false, user, ts };
	}
	if (cell !== '') {
		return { key: 'pending', sub: 'invalid validation data', running: false, user: '', ts: '' };
	}
	const lock = validationLockForSlot(d, row, slot);
	if (lock) {
		return {
			key: 'review',
			sub: `@${handle(logins, lock.user_id)} · in review`,
			running: true,
			user: lock.user_id,
			ts: lock.timestamp
		};
	}
	const taskStatus = taskState(d, row.task_id);
	const waiting = !isEncoded(taskStatus?.status ?? '');
	const pre = isPreTask(taskDef(d, row.task_id)?.locator ?? '');
	const selfEncoded = viewer !== '' && taskStatus?.encoder === viewer && !d.allowSelfValidation;
	return {
		key: 'open',
		sub: waiting
			? pre
				? 'waiting for measure correction'
				: 'waiting for encoding'
			: selfEncoded
				? 'open — needs another volunteer'
				: 'open — claim to review',
		running: false,
		user: '',
		ts: ''
	};
}

/**
 * Project the tables into one node per task, in task.csv order. `viewer` is
 * only used to pick the "next up" node — the first one the viewer can act on.
 */
export function buildGraph(d: GraphData, viewer = '', logins: Logins = {}): TaskNode[] {
	const reqVal = d.validationColumns.length;
	const defs = d.taskDefs.filter((t) => t.subtask_id === '');
	const nodes: TaskNode[] = [];

	let nextUpTaken = false;
	for (const def of defs) {
		const task = def.task_id;
		const state = taskState(d, task);
		const statusKey = mainStatusKey(d, task);
		const lock = encodingLock(d, task);
		const encoded = isEncoded(state?.status ?? '');
		const blocked = blockedBy(d, task);
		const subRows = subRowsOf(d, task);

		const slots: NodeSlot[] = subRows.flatMap((row) =>
			Array.from({ length: reqVal }, (_, slot) => {
				const s = slotState(d, row, slot, viewer, logins);
				return {
					sub: row.subtask_id,
					slot,
					key: s.key,
					label: `${row.subtask_id}·${slot + 1}`,
					who: s.sub,
					running: s.running,
					claimable:
						viewer !== '' &&
						encoded &&
						row.status === 'validation_required' &&
						(d.allowSelfValidation || state?.encoder !== viewer) &&
						slot === nextUnreservedSlot(d, row),
					user: s.user,
					ts: s.ts
				};
			})
		);

		// The viewer's next step: work they already hold, else the first open
		// claim (encoding, or a validation they are allowed to take).
		const mineLock = viewer !== '' && d.locks.some((l) => l.task_id === task && l.user_id === viewer);
		const claimableEncoding = viewer !== '' && !blocked && state?.status === 'encoding_required' && !lock;
		const claimableValidation = slots.some((slot) => slot.claimable);
		const nextUp = viewer !== '' && !nextUpTaken && (mineLock || claimableEncoding || claimableValidation);
		if (nextUp) nextUpTaken = true;

		nodes.push({
			task,
			kind: isPreTask(def.locator) ? 'pre' : 'encode',
			statusKey,
			slots,
			passes: subRows.reduce((n, r) => n + passesOf(d, r), 0),
			threshold: d.passThreshold * subRows.length,
			nextUp
		});
	}
	return nodes;
}
