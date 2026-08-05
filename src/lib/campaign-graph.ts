// The campaign graph: a pure projection of the tracking tables into the
// node-graph console's boxes and edges, plus the detail-panel model. No
// authoritative state lives here — everything derives from task.csv,
// state.csv, lock.csv and config.yaml, so the graph re-derives on every
// table refresh. No Svelte, no GitHub.

import { findRow, isFinalValidation } from './campaign-tables.ts';
import type { TaskRow, StateRow, LockRow, HistoryRow } from './campaign-tables.ts';

/**
 * Numeric account id → current login. The tables key people by their stable
 * numeric id; the console resolves logins for display and passes them in. An
 * unresolved id falls back to showing the id itself.
 */
export type Logins = Record<string, string>;

/** The display handle for a stored user id: its login, or the id if unresolved. */
export const handle = (logins: Logins, id: string): string => logins[id] || id;

/** The tables (and config) the graph is derived from. */
export interface GraphData {
	taskDefs: TaskRow[];
	rows: StateRow[];
	validationColumns: string[];
	locks: LockRow[];
	passThreshold: number;
}

/** A selected node: task, subtask ('' = the task itself), validation slot. */
export interface Selection {
	task: string;
	sub: string;
	slot: number | null;
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

/** The pill label for a status key. */
export const statusLabel = (key: StatusKey): string => STATUS_LABELS[key];

/**
 * The pill label for a status key, aware of measure-correction (pre) tasks:
 * an unclaimed pre-task reads as "action required" rather than "encoding
 * required", since no encoding happens at that stage.
 */
export const statusPill = (key: StatusKey, pre = false): string =>
	pre && key === 'encoding_required' ? 'action required' : STATUS_LABELS[key];

// Geometry constants of the flow layout (all px). The CSS section heights in
// the console must match HEAD_H / SLOTS_HEAD / SLOT_H, since node heights are
// computed here and set explicitly on the boxes.
const G = {
	nodeW: 300,
	headH: 86,
	basePad: 10,
	slotsHead: 34,
	slotH: 30,
	slotsPad: 8,
	gapX: 110,
	gapY: 40,
	x0: 60,
	y0: 60
};

/** One validation slot rendered inside its task node. */
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

/** A positioned task node in the left-to-right flow. */
export interface LaidNode {
	key: string;
	task: string;
	x: number;
	y: number;
	w: number;
	h: number;
	kind: 'pre' | 'encode';
	icon: string;
	title: string;
	subtitle: string;
	statusKey: StatusKey;
	running: boolean;
	meta: string;
	hasIn: boolean;
	hasOut: boolean;
	outGreen: boolean;
	slots: NodeSlot[];
	passes: number;
	threshold: number;
	/** The first node the viewer can act on right now. */
	nextUp: boolean;
}

/** A dependency edge from one task node to another (cubic bézier path). */
export interface LaidEdge {
	/** task_id the edge runs from (the depended-on task). */
	from: string;
	/** task_id the edge runs to (the dependent task). */
	to: string;
	d: string;
	kind: 'green' | 'open';
}

/** The laid-out graph: canvas size plus everything positioned inside it. */
export interface Graph {
	W: number;
	H: number;
	nodes: LaidNode[];
	edges: LaidEdge[];
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

const iconFor = (locator: string): string => (isPreTask(locator) ? 'M' : 'E');

// ---------------------------------------------------------------------------
// Table lookups

const taskDef = (d: GraphData, task: string) => findRow(d.taskDefs, task, '');
const taskState = (d: GraphData, task: string) => findRow(d.rows, task, '');
const subRowsOf = (d: GraphData, task: string) =>
	d.rows.filter((r) => r.task_id === task && r.subtask_id !== '');

const encodingLock = (d: GraphData, task: string) =>
	d.locks.find((l) => l.task_id === task && l.subtask_id === '' && l.kind === 'encoding');
const validationLocks = (d: GraphData, task: string, sub: string) =>
	d.locks.filter((l) => l.task_id === task && l.subtask_id === sub && l.kind === 'validation');

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
	const selfEncoded = viewer !== '' && taskStatus?.encoder === viewer;
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

// ---------------------------------------------------------------------------
// Layout

const hpath = (x1: number, y1: number, x2: number, y2: number): string => {
	const dx = Math.max(18, (x2 - x1) * 0.5);
	return `M${x1} ${y1} C${x1 + dx} ${y1},${x2 - dx} ${y2},${x2} ${y2}`;
};

const nodeHeight = (slots: number): number =>
	G.headH + (slots > 0 ? G.slotsHead + slots * G.slotH + G.slotsPad : G.basePad);

/**
 * Auto-layout: one node per task, in dependency layers. A task's column is the
 * length of its longest depends_on chain, so dependents sit one column right of
 * what they wait for; parallel tasks (unrelated, or sharing a dependency) land
 * in the same column and stack vertically. A pure function of the tables.
 * `viewer` is only used to pick the "next up" node — the first one the viewer
 * can act on.
 */
export function buildGraph(d: GraphData, viewer = '', logins: Logins = {}): Graph {
	const reqVal = d.validationColumns.length;
	const defs = d.taskDefs.filter((t) => t.subtask_id === '');
	const nodes: LaidNode[] = [];
	const edges: LaidEdge[] = [];

	const isTask = (id: string) => defs.some((t) => t.task_id === id);

	// Column = longest depends_on chain length to the task. Roots, dangling
	// dependencies and cycles anchor at column 0.
	const columnOf = new Map<string, number>();
	const resolveColumn = (task: string, trail: Set<string>): number => {
		const cached = columnOf.get(task);
		if (cached !== undefined) return cached;
		const dep = taskDef(d, task)?.depends_on ?? '';
		const col = dep && isTask(dep) && !trail.has(task) ? resolveColumn(dep, new Set(trail).add(task)) + 1 : 0;
		columnOf.set(task, col);
		return col;
	};
	defs.forEach((t) => resolveColumn(t.task_id, new Set()));

	const heights = defs.map((t) => nodeHeight(subRowsOf(d, t.task_id).length * reqVal));
	// Total stacked height of each column, so shorter columns can be centred
	// against the tallest one rather than floating to the top.
	const columnHeight = new Map<number, number>();
	defs.forEach((def, i) => {
		const col = columnOf.get(def.task_id) ?? 0;
		const prev = columnHeight.get(col);
		columnHeight.set(col, prev === undefined ? heights[i] : prev + G.gapY + heights[i]);
	});
	const maxColumnHeight = Math.max(0, ...columnHeight.values());
	// Running vertical cursor per column, so same-column nodes stack downward.
	const columnBottom = new Map<number, number>();

	let nextUpTaken = false;
	defs.forEach((def, i) => {
		const task = def.task_id;
		const state = taskState(d, task);
		const statusKey = mainStatusKey(d, task);
		const lock = encodingLock(d, task);
		const encoded = isEncoded(state?.status ?? '');
		const blocked = blockedBy(d, task);
		const subRows = subRowsOf(d, task);
		let meta = 'unclaimed';
		if (blocked) meta = `waiting for ${blocked}`;
		else if (encoded && state?.encoder) meta = `@${handle(logins, state.encoder)} · encoded`;
		else if (state?.status === 'completed') meta = '✓ done';
		else if (lock) meta = lock.user_id === viewer ? 'claimed by you' : `claimed by @${handle(logins, lock.user_id)}`;

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
						state?.encoder !== viewer &&
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

		const h = heights[i];
		const col = columnOf.get(task) ?? 0;
		const x = G.x0 + col * (G.nodeW + G.gapX);
		// Centre each column's stack vertically against the tallest column.
		const start = G.y0 + (maxColumnHeight - (columnHeight.get(col) ?? 0)) / 2;
		const y = columnBottom.get(col) ?? start;
		columnBottom.set(col, y + h + G.gapY);
		nodes.push({
			key: task,
			task,
			x,
			y,
			w: G.nodeW,
			h,
			kind: isPreTask(def.locator) ? 'pre' : 'encode',
			icon: iconFor(def.locator),
			title: typeLabel(def.locator),
			subtitle: task,
			statusKey,
			// Drives the node's lock marker: only while the meta line shows the claim.
			running: !!lock && !encoded && !blocked,
			meta,
			hasIn: !!def.depends_on && isTask(def.depends_on),
			hasOut: defs.some((t) => t.depends_on === task),
			outGreen: state?.status === 'completed',
			slots,
			passes: subRows.reduce((n, r) => n + passesOf(d, r), 0),
			threshold: d.passThreshold * subRows.length,
			nextUp
		});
	});

	// One edge per dependency, from the depended-on task to the dependent, in
	// task order. Green once the upstream completes, else open (pending).
	const nodeByTask = new Map(nodes.map((n) => [n.task, n]));
	defs.forEach((def) => {
		const dep = def.depends_on;
		if (!dep || !isTask(dep)) return;
		const from = nodeByTask.get(dep)!;
		const to = nodeByTask.get(def.task_id)!;
		const upstreamDone = taskState(d, dep)?.status === 'completed';
		edges.push({
			from: dep,
			to: def.task_id,
			d: hpath(from.x + from.w, from.y + G.headH / 2, to.x, to.y + G.headH / 2),
			kind: upstreamDone ? 'green' : 'open'
		});
	});

	const right = Math.max(G.x0, ...nodes.map((n) => n.x + n.w));
	const bottom = Math.max(G.y0, ...nodes.map((n) => n.y + n.h));
	return {
		W: right + G.x0,
		H: Math.max(bottom + G.y0, 240),
		nodes,
		edges
	};
}

// ---------------------------------------------------------------------------
// The detail panel

/** A panel action; the console maps ids to command invocations. */
export interface PanelAction {
	id:
		| 'open-editor'
		| 'submit-encoding'
		| 'zone-editor'
		| 'claim-validation'
		| 'validate-pass'
		| 'validate-fail'
		| 'toggle-preview'
		| 'raw-link';
	label: string;
	primary: boolean;
	disabled: boolean;
	title: string;
}

/** One subtask's validation summary in the panel. */
export interface PanelValidation {
	sub: string;
	passes: number;
	threshold: number;
	pct: number;
	slots: Array<{ label: string; state: SlotState }>;
}

/** Everything the detail panel renders for the selected node. */
export interface Panel {
	icon: string;
	iconKind: 'pre' | 'encode' | 'validate';
	title: string;
	subtitle: string;
	pills: Array<{ key: StatusKey; text: string }>;
	lockText: string;
	meta: string;
	actions: PanelAction[];
	validations: PanelValidation[];
	metaRows: Array<{ k: string; v: string; done?: boolean }>;
	history: Array<{ t: string; text: string }>;
}

const historyOf = (history: HistoryRow[], task: string, logins: Logins = {}) =>
	history
		.filter((h) => h.task_id === task)
		.map((h) => ({
			t: h.timestamp,
			text: `@${handle(logins, h.user_id)} · ${h.action} · ${h.detail || h.outcome}`
		}))
		.reverse();

/**
 * The panel model for the current selection, or null when nothing valid is
 * selected. `previewOpen` toggles the preview action's label; `history` is
 * filtered to the selected task in expert mode.
 */
export function buildPanel(
	d: GraphData,
	history: HistoryRow[],
	sel: Selection | null,
	viewer: string,
	previewOpen: boolean,
	logins: Logins = {}
): Panel | null {
	if (!sel) return null;
	const def = taskDef(d, sel.task);
	const state = taskState(d, sel.task);
	if (!def || !state) return null;
	const reqVal = d.validationColumns.length;
	const blocked = blockedBy(d, sel.task);

	const previewAction = (primary: boolean): PanelAction => ({
		id: 'toggle-preview',
		label: previewOpen ? 'Hide preview' : 'Preview score',
		primary,
		disabled: false,
		title: "Show the task's score rendered in the console (read-only)."
	});
	const rawLinkAction: PanelAction = {
		id: 'raw-link',
		label: 'Copy raw link',
		primary: false,
		disabled: false,
		title: 'Copy a direct link to the score file to paste into mei-friend manually.'
	};

	// A validation slot is selected.
	if (sel.sub !== '' && sel.slot != null) {
		const row = findRow(d.rows, sel.task, sel.sub);
		if (!row) return null;
		const s = slotState(d, row, sel.slot, viewer, logins);
		const cell = cellsOf(d, row)[sel.slot] ?? '';
		const lock = validationLockForSlot(d, row, sel.slot);
		const mine = lock?.user_id === viewer;
		const actions: PanelAction[] = [];
		let lockText = '';
		let meta = '';
		// Facsimile pre-tasks are reviewed in the zone editor (read-only view).
		const openEditor: PanelAction | null =
			isPreTask(def.locator)
				? {
						id: 'zone-editor',
						label: 'Open editor',
						primary: false,
						disabled: false,
						title: 'Review the submitted work on the facsimile (read-only). Pass or fail from there or from this panel.'
					}
				: null;
		if (isFinalValidation(cell)) {
			const [, user, ts] = cell.split('|');
			meta = `by @${handle(logins, user)}${ts ? ` · ${ts}` : ''}`;
			if (openEditor) actions.push(openEditor);
			actions.push(previewAction(false));
		} else if (s.key === 'review') {
			lockText = mine ? 'You hold this validation lock' : `Being reviewed by @${handle(logins, lock!.user_id)}`;
			if (openEditor) actions.push(openEditor);
			actions.push(previewAction(false));
			if (mine) {
				actions.push({
					id: 'validate-pass',
					label: 'Validate: pass',
					primary: false,
					disabled: false,
					title: 'Record a passing verdict.'
				});
				actions.push({
					id: 'validate-fail',
					label: 'Validate: fail',
					primary: false,
					disabled: false,
					title: 'Record a failing verdict — the task goes back to encoding.'
				});
			}
		} else {
			const selfValidation = state.encoder === viewer && state.encoder !== '';
			const claimable =
				viewer !== '' &&
				row.status === 'validation_required' &&
				sel.slot === nextUnreservedSlot(d, row) &&
				!selfValidation;
			meta = !isEncoded(state.status)
				? 'Opens once the encoding is submitted.'
				: selfValidation
					? 'You encoded this — no self-validation.'
					: '';
			actions.push({
				id: 'claim-validation',
				label: 'Claim validation task',
				primary: true,
				disabled: !claimable,
				title: selfValidation
					? 'Encoders cannot validate their own work.'
					: isPreTask(def.locator)
						? 'Reserve this subtask and open the zone editor to review it.'
						: 'Reserve this subtask for validation.'
			});
			actions.push(previewAction(false));
		}
		actions.push(rawLinkAction);
		return {
			icon: 'V',
			iconKind: 'validate',
			title: 'Validation',
			subtitle: `${sel.task}/${sel.sub} · slot ${sel.slot + 1}`,
			pills: [{ key: s.key, text: statusLabel(s.key) }],
			lockText,
			meta,
			actions,
			validations: [],
			metaRows: [
				{ k: 'Type', v: 'validate-node' },
				{ k: 'Encoder', v: state.encoder ? `@${handle(logins, state.encoder)}` : '—' },
				{ k: 'Fragment', v: def.fragment },
				{ k: 'Pass threshold', v: `${d.passThreshold} of ${reqVal}` }
			],
			history: historyOf(history, sel.task, logins)
		};
	}

	// The task's main node is selected.
	const lock = encodingLock(d, sel.task);
	const mine = lock?.user_id === viewer;
	const encoded = isEncoded(state.status);
	const statusKey = mainStatusKey(d, sel.task);
	const subRows = subRowsOf(d, sel.task);
	// Once a task is encoded and has validation subtasks, their derived state
	// replaces the main status pill — subtask states may diverge from the
	// task status.
	const pills: Array<{ key: StatusKey; text: string }> = [];
	if (encoded && subRows.length) {
		const validated = subRows.every((r) => r.status === 'completed');
		pills.push(
			validated
				? { key: 'completed', text: '✓ validated' }
				: { key: 'validation_required', text: 'validating' }
		);
	} else {
		pills.push({ key: statusKey, text: statusPill(statusKey, isPreTask(def.locator)) });
	}
	let meta = '';
	if (blocked) meta = `Waits for ${blocked} — claims open once it is completed.`;
	else if (encoded && state.encoder)
		meta = `encoded by @${handle(logins, state.encoder)}${state.encoded_at ? ` · ${state.encoded_at}` : ''}`;
	else if (statusKey === 'claimed') meta = 'Waiting for correction.';
	const lockText = lock
		? mine
			? 'You hold this claim'
			: `Claimed by @${handle(logins, lock.user_id)}`
		: '';

	const actions: PanelAction[] = [];
	const otherLock = lock && !mine;
	if (isPreTask(def.locator)) {
		if (encoded) {
			// The correction is submitted, so the task can no longer be claimed.
			// The zone editor opens read-only for reviewing the corrected measures.
			actions.push({
				id: 'zone-editor',
				label: 'Open measure viewer',
				primary: false,
				disabled: false,
				title: 'View the corrected measures on the facsimile (read-only).'
			});
		} else {
			actions.push({
				id: 'zone-editor',
				label: mine ? 'Correct measures in editor' : 'Claim correction task',
				primary: true,
				disabled: viewer === '' || !!blocked || !!otherLock,
				title: viewer === ''
					? 'Log in to claim this correction task.'
					: blocked
					? `Enabled once ${blocked} is completed.`
					: otherLock
						? `Already claimed by @${handle(logins, lock.user_id)}.`
						: 'Correct the detected measures on the facsimile: add, delete, move, resize and renumber them.'
			});
		}
	} else {
		const claimable = viewer !== '' && !blocked && !otherLock && (state.status === 'encoding_required' || mine);
		actions.push({
			id: 'open-editor',
			label: mine ? 'Open in mei-friend ↗' : 'Claim encoding task ↗',
			primary: true,
			disabled: !claimable,
			title: blocked
				? `Enabled once ${blocked} is completed.`
				: otherLock
					? `Already claimed by @${handle(logins, lock.user_id)}.`
					: 'Claims this task for you and opens the score in mei-friend. Commit your encoding there, then use “Submit encoding”.'
		});
		actions.push({
			id: 'submit-encoding',
			label: 'Submit encoding',
			primary: false,
			disabled: !mine,
			title: 'After committing your encoding in mei-friend, submit it for validation. Enabled once you hold the encoding claim.'
		});
	}
	actions.push(previewAction(false), rawLinkAction);

	const validations: PanelValidation[] = subRows.map((row) => {
		const passes = passesOf(d, row);
		return {
			sub: row.subtask_id,
			passes,
			threshold: d.passThreshold,
			pct: Math.min(100, Math.round((passes / Math.max(1, d.passThreshold)) * 100)),
			slots: Array.from({ length: reqVal }, (_, slot) => ({
				label: `${row.subtask_id}·${slot + 1}`,
				state: slotState(d, row, slot, viewer, logins)
			}))
		};
	});

	const depDone = def.depends_on ? taskState(d, def.depends_on)?.status === 'completed' : false;
	return {
		icon: iconFor(def.locator),
		iconKind: isPreTask(def.locator) ? 'pre' : 'encode',
		title: typeLabel(def.locator),
		subtitle: `${sel.task} · ${def.fragment}`,
		pills,
		lockText,
		meta,
		actions,
		validations,
		metaRows: [
			{ k: 'Type', v: isPreTask(def.locator) ? `${def.locator}-node` : 'encode-node' },
			{
				k: 'Depends on',
				v: def.depends_on ? `${def.depends_on} ${depDone ? '✓' : '⧗'}` : '—',
				done: depDone
			},
			{ k: 'Input → Output', v: 'MEI → MEI' },
			{ k: 'Fragment', v: def.fragment },
			{ k: 'Pass threshold', v: `${d.passThreshold} of ${reqVal}` }
		],
		history: historyOf(history, sel.task, logins)
	};
}
