// The pipeline board: a pure projection of the tracking tables and the
// comment log into five status columns with task cards, the attention counts,
// the activity ticker and the overlay's validation record and discussion
// threads. Builds on the task projection in campaign-graph.ts (statuses,
// slots, next-up) — no authoritative state lives here. No Svelte, no GitHub.

import {
	buildGraph,
	blockedBy,
	handle,
	isPreTask,
	sendBackTarget,
	typeLabel
} from './campaign-graph.ts';
import type { GraphData, Logins, NodeSlot, StatusKey } from './campaign-graph.ts';
import { findRow, isFinalValidation } from './campaign-tables.ts';
import type { CommentRow, HistoryRow, PieceNames } from './campaign-tables.ts';

// ---------------------------------------------------------------------------
// Shared display helpers

/** Compact elapsed-time label for an ISO timestamp: "now", "25 min", "3 h", "2 d". */
export function elapsed(iso: string, now = Date.now()): string {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '';
	const minutes = Math.floor(Math.max(0, now - t) / 60_000);
	if (minutes < 1) return 'now';
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h`;
	return `${Math.floor(hours / 24)} d`;
}

/** The avatar initial for a display handle. */
export const initialOf = (name: string): string => name[0]?.toUpperCase() ?? '?';

/**
 * The piece behind a fragment path, for card titles: its configured name, else
 * the piece directory of the standard sources/<piece>/score.mei layout, else
 * the basename without extension.
 */
const pieceLabel = (fragment: string, names: PieceNames): string => {
	const named = names[fragment];
	if (named) return named;
	const parts = fragment.split('/');
	const base = (parts.pop() ?? fragment).replace(/\.mei$/i, '');
	const dir = parts.pop();
	return base === 'score' && dir && dir !== 'sources' ? dir : base;
};

/** The card title: the piece plus the part of it the task addresses. */
export function cardTitle(fragment: string, locator: string, names: PieceNames = {}): string {
	const page = /^surface-(\d+)$/.exec(locator);
	if (page) return `${pieceLabel(fragment, names)} · p. ${page[1]}`;
	if (locator === 'score-setup') return `${pieceLabel(fragment, names)} · setup`;
	if (isPreTask(locator)) return `${pieceLabel(fragment, names)} · measures`;
	return pieceLabel(fragment, names);
}

// ---------------------------------------------------------------------------
// Comments per task

/** Timestamps of the fail cells currently recorded on a task's subtasks. */
function failCellTimestamps(d: GraphData, task: string): Set<string> {
	const set = new Set<string>();
	for (const row of d.rows) {
		if (row.task_id !== task || row.subtask_id === '') continue;
		for (const column of d.validationColumns) {
			const cell = row[column] ?? '';
			if (isFinalValidation(cell) && cell.startsWith('fail|')) set.add(cell.split('|')[2]);
		}
	}
	return set;
}

/** The attention chips of one task: recorded fails, open comments, open questions. */
export interface TaskCounts {
	fails: number;
	comments: number;
	questions: number;
}

/**
 * Chip counts for a task. Fails are the fail cells on its subtasks; a fail
 * comment still matched by a fail cell is the same issue and is not counted
 * again (after a send-back the cells clear, so the unresolved fail comment
 * takes over the count as a plain comment).
 */
function taskCounts(d: GraphData, comments: CommentRow[], task: string): TaskCounts {
	const cellTs = failCellTimestamps(d, task);
	const fails = cellTs.size;
	const byId = new Map(comments.map((c) => [c.comment_id, c]));
	// A reply is closed with its thread: once the root it chains to (via
	// parent_id) is resolved, the reply no longer needs attention.
	const rootResolved = (reply: CommentRow): boolean => {
		const seen = new Set<string>();
		let c: CommentRow | undefined = reply;
		while (c && c.parent_id && !seen.has(c.comment_id)) {
			seen.add(c.comment_id);
			c = byId.get(c.parent_id);
		}
		return c?.resolved === 'true';
	};
	let questions = 0;
	let other = 0;
	for (const c of comments) {
		if (c.task_id !== task || c.resolved === 'true') continue;
		if (c.kind === 'reply' && rootResolved(c)) continue;
		if (c.kind === 'question') questions++;
		else if (c.kind === 'fail') {
			if (!cellTs.has(c.timestamp)) other++;
		} else other++;
	}
	return { fails, comments: other, questions };
}

const countsTotal = (c: TaskCounts): number => c.fails + c.comments + c.questions;

/** When a task was finished: its last final verdict, else its encoding time. */
function finishedAt(d: GraphData, task: string): string {
	let last = '';
	for (const row of d.rows) {
		if (row.task_id !== task || row.subtask_id === '') continue;
		for (const column of d.validationColumns) {
			const cell = row[column] ?? '';
			if (isFinalValidation(cell)) {
				const ts = cell.split('|')[2];
				if (ts > last) last = ts;
			}
		}
	}
	return last || (findRow(d.rows, task, '')?.encoded_at ?? '');
}

// ---------------------------------------------------------------------------
// The board

export type ColumnKey = 'blocked' | 'ready' | 'encoding' | 'validation' | 'done';

const COLUMN_OF: Record<StatusKey, ColumnKey> = {
	blocked: 'blocked',
	encoding_required: 'ready',
	pending: 'ready',
	encoding: 'encoding',
	claimed: 'encoding',
	validation_required: 'validation',
	completed: 'done',
	// Slot-level keys; never a task status, but the record is total.
	pass: 'done',
	fail: 'validation',
	review: 'validation',
	open: 'ready'
};

/** One task card on the board. */
export interface BoardCard {
	task: string;
	column: ColumnKey;
	title: string;
	/** The type line under the title ("Encoding", "Measure correction", "Score setup"). */
	typeLine: string;
	pre: boolean;
	/** The task's locator, for routing a pre-task to its own editor. */
	locator: string;
	statusKey: StatusKey;
	/** Blocked column: the title of the task this one waits for. */
	waitsFor: string;
	/** Ready column: the viewer may claim it right now. */
	claimable: boolean;
	/** Encoding column: who holds the claim, and for how long. */
	worker: { login: string; elapsed: string; mine: boolean } | null;
	/** Validation column: pass progress and one dot per slot. */
	passes: number;
	threshold: number;
	dots: StatusKey[];
	counts: TaskCounts;
	/** Done column: the completion line ("3 of 3 validations"), rendered behind a pass icon. */
	doneLine: string;
	/** Done column: when the last pass verdict landed (else the encoding time); '' elsewhere. */
	finishedAt: string;
	/** The first card the viewer can act on right now. */
	nextUp: boolean;
	/** The underlying slots, for the overlay's validation record. */
	slots: NodeSlot[];
}

export interface BoardColumn {
	key: ColumnKey;
	label: string;
	cards: BoardCard[];
	/** Unresolved-attention badge (validation column only; 0 elsewhere). */
	attention: number;
}

/** One activity-ticker entry: "login text · elapsed". */
export interface TickerEntry {
	login: string;
	text: string;
	elapsed: string;
}

export interface Board {
	columns: BoardColumn[];
	/** Tasks done, of all tasks. */
	done: number;
	total: number;
	attention: number;
	/** Tasks someone is actively working on (claims and running reviews). */
	inFlight: number;
	/** Distinct people the history records within the last 7 days. */
	contributorsWeek: number;
	ticker: TickerEntry[];
	/** The task of the first card the viewer can act on, or null. */
	nextUp: string | null;
}

const COLUMN_LABELS: Record<ColumnKey, string> = {
	blocked: 'Blocked',
	ready: 'Ready to claim',
	encoding: 'Encoding',
	validation: 'Validation',
	done: 'Done'
};

// The human line behind a history action, or null for rows the ticker skips.
function tickerText(h: HistoryRow, title: string, locator = ''): string | null {
	if (h.outcome !== 'accepted' && h.outcome !== 'released') return null;
	switch (h.action) {
		case 'claim_encoding':
			return `claimed ${title}`;
		case 'claim_validation':
			return `claimed a validation on ${title}`;
		case 'submit_encoding':
			return `submitted the encoding of ${title}`;
		case 'submit_validation':
			return h.detail === 'fail' ? `failed a validation on ${title}` : `passed a validation on ${title}`;
		case 'send_back':
			return `sent ${title} back for ${sendBackTarget(locator)}`;
		case 'submit_comment':
			return `commented on ${title}`;
		case 'resolve_comment':
			return `resolved a comment on ${title}`;
		case 'reap':
			return `lost a stale claim on ${title}`;
		default:
			return null;
	}
}

/** The last few history entries as ticker lines, newest first. */
function buildTicker(
	d: GraphData,
	history: HistoryRow[],
	logins: Logins = {},
	names: PieceNames = {},
	limit = 4,
	now = Date.now()
): TickerEntry[] {
	const entries: TickerEntry[] = [];
	for (let i = history.length - 1; i >= 0 && entries.length < limit; i--) {
		const h = history[i];
		const def = findRow(d.taskDefs, h.task_id, '');
		const text = tickerText(
			h,
			def ? cardTitle(def.fragment, def.locator, names) : h.task_id,
			def?.locator ?? ''
		);
		if (text) entries.push({ login: handle(logins, h.user_id), text, elapsed: elapsed(h.timestamp, now) });
	}
	return entries;
}

/** Project the tables into the five-column pipeline board. */
export function buildBoard(
	d: GraphData,
	comments: CommentRow[],
	history: HistoryRow[],
	viewer = '',
	logins: Logins = {},
	names: PieceNames = {},
	now = Date.now()
): Board {
	const nodes = buildGraph(d, viewer, logins);
	const columns: BoardColumn[] = (Object.keys(COLUMN_LABELS) as ColumnKey[]).map((key) => ({
		key,
		label: COLUMN_LABELS[key],
		cards: [],
		attention: 0
	}));
	const columnByKey = new Map(columns.map((c) => [c.key, c]));

	for (const n of nodes) {
		const def = findRow(d.taskDefs, n.task, '')!;
		const state = findRow(d.rows, n.task, '');
		const column = COLUMN_OF[n.statusKey] ?? 'ready';
		const lock = d.locks.find((l) => l.task_id === n.task && l.subtask_id === '' && l.kind === 'encoding');
		const dep = blockedBy(d, n.task);
		const depDef = dep ? findRow(d.taskDefs, dep, '') : undefined;
		const counts = taskCounts(d, comments, n.task);
		columnByKey.get(column)!.cards.push({
			task: n.task,
			column,
			title: cardTitle(def.fragment, def.locator, names),
			typeLine: n.kind === 'pre' ? typeLabel(def.locator) : 'Encoding',
			pre: n.kind === 'pre',
			locator: def.locator,
			statusKey: n.statusKey,
			waitsFor: depDef ? cardTitle(depDef.fragment, depDef.locator, names) : dep,
			claimable: viewer !== '' && column === 'ready' && !lock,
			worker:
				column === 'encoding' && lock
					? {
							login: handle(logins, lock.user_id),
							elapsed: elapsed(lock.timestamp, now),
							mine: viewer !== '' && lock.user_id === viewer
						}
					: null,
			passes: n.passes,
			threshold: n.threshold,
			dots: n.slots.map((s) => s.key),
			counts,
			doneLine:
				n.kind === 'pre' || n.threshold === 0
					? `finished by ${handle(logins, state?.encoder ?? '') || '—'}`
					: `${n.passes} of ${n.threshold} validations`,
			finishedAt: column === 'done' ? finishedAt(d, n.task) : '',
			nextUp: n.nextUp,
			slots: n.slots
		});
	}

	// The Done column reads newest first, so the tasks finished last stay in
	// view above its collapse.
	columnByKey
		.get('done')!
		.cards.sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : 0));

	// The campaign's attention count (hero counter and the validation column's
	// badge): unresolved comments plus recorded fails, on non-completed tasks —
	// summed from the card counts computed above.
	const attention = columns
		.filter((column) => column.key !== 'done')
		.reduce((n, column) => n + column.cards.reduce((m, card) => m + countsTotal(card.counts), 0), 0);
	columnByKey.get('validation')!.attention = attention;

	const reviewTasks = new Set(
		d.locks.filter((l) => l.kind === 'validation').map((l) => l.task_id)
	);
	const inFlight = columnByKey.get('encoding')!.cards.length + reviewTasks.size;

	const weekAgo = now - 7 * 24 * 3600_000;
	const contributorsWeek = new Set(
		history.filter((h) => Date.parse(h.timestamp) >= weekAgo && h.user_id).map((h) => h.user_id)
	).size;

	return {
		columns,
		done: columnByKey.get('done')!.cards.length,
		total: nodes.length,
		attention,
		inFlight,
		contributorsWeek,
		ticker: buildTicker(d, history, logins, names, 4, now),
		nextUp: nodes.find((n) => n.nextUp)?.task ?? null
	};
}

// ---------------------------------------------------------------------------
// The overlay's right rail

/** One row of the overlay's validation record. */
export interface RecordRow {
	sub: string;
	slot: number;
	key: StatusKey;
	/** Verdict author or reviewing lock holder; '' when open. */
	login: string;
	/** The stored user id behind the row, for permission checks; '' when open. */
	userId: string;
	elapsed: string;
	/** The fail's mandatory comment, when one matches the verdict. */
	comment: CommentRow | null;
	claimable: boolean;
	/** The viewer holds this slot's review lock. */
	mine: boolean;
	/** The open-slot explanation ("waiting for encoding", "open — claim to review"). */
	note: string;
}

/** The validation record for a task card, one row per slot. */
export function buildRecord(
	card: Pick<BoardCard, 'task' | 'slots'>,
	comments: CommentRow[],
	viewer = '',
	logins: Logins = {},
	now = Date.now()
): RecordRow[] {
	return card.slots.map((s) => ({
		sub: s.sub,
		slot: s.slot,
		key: s.key,
		login: s.user ? handle(logins, s.user) : '',
		userId: s.user,
		elapsed: s.ts ? elapsed(s.ts, now) : '',
		comment:
			s.key === 'fail'
				? (comments.find(
						(c) =>
							c.task_id === card.task && c.subtask_id === s.sub && c.kind === 'fail' && c.timestamp === s.ts
					) ?? null)
				: null,
		claimable: s.claimable,
		mine: viewer !== '' && s.key === 'review' && s.user === viewer,
		note: s.key === 'open' ? s.who : ''
	}));
}

/**
 * A task's unresolved fail comments no longer matched by a fail cell — a
 * send-back cleared the verdicts they arrived with. They count as plain
 * comments (see taskCounts), so the record renders them after its slot rows.
 */
export function orphanedFails(
	card: Pick<BoardCard, 'task' | 'slots'>,
	comments: CommentRow[]
): CommentRow[] {
	return comments.filter(
		(c) =>
			c.task_id === card.task &&
			c.kind === 'fail' &&
			c.resolved !== 'true' &&
			!card.slots.some((s) => s.key === 'fail' && s.sub === c.subtask_id && s.ts === c.timestamp)
	);
}

/** One discussion thread: a top-level comment and its replies, oldest first. */
export interface Thread {
	root: CommentRow;
	replies: CommentRow[];
}

/**
 * The overlay's discussion: the task's top-level question/addition comments
 * with their replies. Fail comments live in the validation record instead.
 */
export function buildThreads(comments: CommentRow[], task: string): Thread[] {
	const ofTask = comments.filter((c) => c.task_id === task);
	const roots = ofTask.filter((c) => c.kind === 'question' || c.kind === 'addition');
	return roots.map((root) => ({
		root,
		replies: ofTask.filter((c) => c.kind === 'reply' && c.parent_id === root.comment_id)
	}));
}
