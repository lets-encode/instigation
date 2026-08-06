// Tracking-table (de)serialisation for the five tables (task / state / lock
// / history / comment), all keyed by (task_id, subtask_id): a row with an EMPTY
// subtask_id addresses the whole task (the unit of encoding), a row with a
// subtask_id addresses one validation portion. Pure functions: CSV text in,
// plain objects out (and back) — plus the scalar readers for config.yaml and
// the id → login resolution both the console and the stats layer use. No
// GitHub client of its own, no filesystem.
//
// Table layouts are defined in DESIGN.md §5. The five base state columns are
// fixed; everything after them is a validation cell (validate_status_1…n), so
// `required_validations` is just their count.

/** A task-definition row from task.csv. */
export interface TaskRow {
	task_id: string;
	subtask_id: string;
	fragment: string;
	locator: string;
	allowlist: string;
	blocklist: string;
	/** task_id that must be completed before this task can be claimed; empty = none. */
	depends_on: string;
}

/** A lock row from lock.csv. */
export interface LockRow {
	task_id: string;
	subtask_id: string;
	/** The GitHub numeric account id (as a string) of who holds the lock. */
	user_id: string;
	timestamp: string;
	kind: string;
}

/**
 * An append-only history row from history.csv. The last three columns record
 * the console command behind the event, when there was one: the command's id,
 * its version, and its input as JSON. They stay empty for events that arrived
 * without a command envelope (hand-opened PRs, scheduled reaps).
 */
export interface HistoryRow {
	timestamp: string;
	task_id: string;
	subtask_id: string;
	/** The GitHub numeric account id (as a string) of who caused the event. */
	user_id: string;
	action: string;
	outcome: string;
	detail: string;
	command?: string;
	version?: string;
	input?: string;
}

/**
 * A comment row from comment.csv: the campaign's comment log. A `fail`
 * comment is the mandatory explanation of a fail validation; `question`,
 * `addition` and `reply` carry the discussion. Comments are anchored to
 * measures (page + measure range), not pixels, so they survive re-encoding.
 */
export interface CommentRow {
	/** Random id, assigned by the campaign automation. */
	comment_id: string;
	task_id: string;
	subtask_id: string;
	/** 'fail' | 'question' | 'addition' | 'reply'. */
	kind: string;
	/** 1-based facsimile page the comment anchors to; '' = unanchored. */
	page: string;
	measure_start: string;
	measure_end: string;
	/** The GitHub numeric account id (as a string) of the comment's author. */
	author_id: string;
	timestamp: string;
	/** 'true' once resolved; '' while open. */
	resolved: string;
	/** comment_id of the comment this replies to; '' for top-level comments. */
	parent_id: string;
	body: string;
}

/**
 * A state.csv row, keyed by column name. The base columns are always present;
 * the validation columns (validate_status_1…n) are reached via the index
 * signature and are only meaningful on subtask rows.
 */
export interface StateRow {
	task_id: string;
	subtask_id: string;
	status: string;
	/** The GitHub numeric account id (as a string) of who submitted the encoding. */
	encoder: string;
	encoded_at: string;
	[column: string]: string;
}

/** A parsed state table: the header, the validate_status_* slice, the keyed rows. */
export interface ParsedState {
	header: string[];
	validationColumns: string[];
	rows: StateRow[];
}

const TASK_COLUMNS = ['task_id', 'subtask_id', 'fragment', 'locator', 'allowlist', 'blocklist', 'depends_on'];
const STATE_BASE_COLUMNS = ['task_id', 'subtask_id', 'status', 'encoder', 'encoded_at'];
const LOCK_COLUMNS = ['task_id', 'subtask_id', 'user_id', 'timestamp', 'kind'];
const HISTORY_COLUMNS = ['timestamp', 'task_id', 'subtask_id', 'user_id', 'action', 'outcome', 'detail', 'command', 'version', 'input'];
const COMMENT_COLUMNS = ['comment_id', 'task_id', 'subtask_id', 'kind', 'page', 'measure_start', 'measure_end', 'author_id', 'timestamp', 'resolved', 'parent_id', 'body'];

// RFC-4180 field: quote only when it contains a comma, quote or newline.
function csvField(value: unknown): string {
	const s = value == null ? '' : String(value);
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const csvRow = (fields: unknown[]): string => fields.map(csvField).join(',');

/** Parse CSV text into an array of rows (each an array of string fields). */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') {
				inQuotes = false;
			} else {
				field += c;
			}
		} else if (c === '"') {
			inQuotes = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (c !== '\r') {
			field += c;
		}
	}
	// Flush a trailing record only if the file didn't end on a newline.
	if (field !== '' || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

// Object rows from CSV text, keyed by the given column names.
function parseRows<T>(text: string, columns: string[]): T[] {
	return parseCsv(text)
		.slice(1)
		.map((cells) => Object.fromEntries(columns.map((col, i) => [col, cells[i] ?? ''])) as T);
}

/** Parse task.csv into task/subtask definition rows. */
export function parseTaskCsv(text: string): TaskRow[] {
	return parseRows<TaskRow>(text, TASK_COLUMNS);
}

/** Serialise task rows back to task.csv text (header + one line per row). */
export function serializeTaskCsv(rows: TaskRow[]): string {
	const lines = [csvRow(TASK_COLUMNS), ...rows.map((r) => csvRow(TASK_COLUMNS.map((c) => r[c as keyof TaskRow])))];
	return `${lines.join('\n')}\n`;
}

/**
 * Parse state.csv. Returns { header, validationColumns, rows } where each row
 * is an object keyed by column name. validationColumns is the
 * validate_status_1…n slice.
 */
export function parseStateCsv(text: string): ParsedState {
	const all = parseCsv(text);
	const header = all[0] ?? [];
	const validationColumns = header.slice(STATE_BASE_COLUMNS.length);
	const rows = all.slice(1).map(
		(cells) => Object.fromEntries(header.map((col, i) => [col, cells[i] ?? ''])) as StateRow
	);
	return { header, validationColumns, rows };
}

/** Serialise a parsed state table ({ header, rows }) back to state.csv text. */
export function serializeStateCsv({ header, rows }: Pick<ParsedState, 'header' | 'rows'>): string {
	const lines = [csvRow(header), ...rows.map((r) => csvRow(header.map((col) => r[col] ?? '')))];
	return `${lines.join('\n')}\n`;
}

/** Parse lock.csv into lock rows. */
export function parseLockCsv(text: string): LockRow[] {
	return parseRows<LockRow>(text, LOCK_COLUMNS);
}

/** Serialise lock rows back to lock.csv text (header + one line per row). */
export function serializeLockCsv(rows: LockRow[]): string {
	const lines = [csvRow(LOCK_COLUMNS), ...rows.map((r) => csvRow(LOCK_COLUMNS.map((c) => r[c as keyof LockRow])))];
	return `${lines.join('\n')}\n`;
}

/** Parse history.csv into history rows. */
export function parseHistoryCsv(text: string): HistoryRow[] {
	return parseRows<HistoryRow>(text, HISTORY_COLUMNS);
}

/** Append rows to history.csv text (append-only — existing lines are kept verbatim). */
export function appendHistory(text: string, rows: HistoryRow[]): string {
	const base = text === '' ? `${csvRow(HISTORY_COLUMNS)}\n` : text.endsWith('\n') ? text : `${text}\n`;
	return base + rows.map((r) => `${csvRow(HISTORY_COLUMNS.map((c) => r[c as keyof HistoryRow]))}\n`).join('');
}

/** Parse comment.csv into comment rows. */
export function parseCommentCsv(text: string): CommentRow[] {
	return parseRows<CommentRow>(text, COMMENT_COLUMNS);
}

/** Serialise comment rows back to comment.csv text (header + one line per row). */
export function serializeCommentCsv(rows: CommentRow[]): string {
	const lines = [csvRow(COMMENT_COLUMNS), ...rows.map((r) => csvRow(COMMENT_COLUMNS.map((c) => r[c as keyof CommentRow])))];
	return `${lines.join('\n')}\n`;
}

/** Append rows to comment.csv text (existing lines are kept verbatim). */
export function appendComments(text: string, rows: CommentRow[]): string {
	const base = text === '' ? `${csvRow(COMMENT_COLUMNS)}\n` : text.endsWith('\n') ? text : `${text}\n`;
	return base + rows.map((r) => `${csvRow(COMMENT_COLUMNS.map((c) => r[c as keyof CommentRow]))}\n`).join('');
}

/** The row addressing (task_id, subtask_id), or undefined. */
export function findRow<T extends { task_id: string; subtask_id: string }>(
	rows: T[],
	task_id: string,
	subtask_id: string
): T | undefined {
	return rows.find((r) => r.task_id === task_id && r.subtask_id === subtask_id);
}

/** True if a validate_status cell holds a final outcome (pass/fail) rather than being open. */
export function isFinalValidation(cell: string): boolean {
	return /^(pass|fail)\|[^|]+\|[^|]+$/.test(cell);
}

/**
 * A top-level-or-nested scalar from config.yaml by key, without a YAML parser:
 * the first `key: value` line wins. Double-quoted values decode via JSON
 * string syntax (how configToYaml writes them); bare values lose trailing
 * comments. '' when absent or malformed.
 */
export function configString(yaml: string | null, key: string): string {
	const value = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(yaml ?? '')?.[1] ?? '';
	if (value.startsWith('"')) {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === 'string' ? parsed : '';
		} catch {
			return '';
		}
	}
	return value.replace(/\s+#.*$/, '').trim();
}

/** A piece of the campaign as the console addresses it: its score and its name. */
export interface PieceRef {
	id: string;
	/** Repo path of the piece's MEI — the `fragment` its tasks address. */
	path: string;
	/** The piece's header title; '' when unset. */
	title: string;
}

/**
 * The pieces from config.yaml, in config order, read the same way as
 * configString: the indented lines under `pieces:`, split on their entries.
 * Entries without a path are skipped, having no score to address.
 */
export function configPieces(yaml: string | null): PieceRef[] {
	const block = /^pieces:[^\S\n]*\n((?:[ \t].*\n?)*)/m.exec(yaml ?? '')?.[1] ?? '';
	const pieces: PieceRef[] = [];
	for (const entry of block.split(/^ {2}- /m).slice(1)) {
		const path = configString(entry, 'path');
		// The only `title:` in an entry is its header's.
		if (path) pieces.push({ id: configString(entry, 'id'), path, title: configString(entry, 'title') });
	}
	return pieces;
}

/** A positive-integer scalar from config.yaml by key, or `fallback`. */
export function configNumber(yaml: string | null, key: string, fallback: number): number {
	const n = Number(new RegExp(`^\\s*${key}:\\s*(\\d+)`, 'm').exec(yaml ?? '')?.[1]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve every numeric account id the tables mention (encoders, lock
 * holders, history actors, comment authors, verdict authors) to its current
 * login via `getUserLogin` (memoised in the forge client). An id that can't
 * be resolved is omitted, so the UI falls back to showing the raw id.
 */
export async function resolveLogins(
	getUserLogin: (id: number) => Promise<string | null>,
	d: { rows: StateRow[]; locks: LockRow[]; history: HistoryRow[]; comments: CommentRow[] }
): Promise<Record<string, string>> {
	const ids = new Set<string>();
	for (const r of d.rows) if (r.encoder) ids.add(r.encoder);
	for (const l of d.locks) if (l.user_id) ids.add(l.user_id);
	for (const h of d.history) if (h.user_id) ids.add(h.user_id);
	for (const c of d.comments) if (c.author_id) ids.add(c.author_id);
	for (const r of d.rows) {
		for (const cell of Object.values(r)) {
			if (/^(pass|fail)\|/.test(cell)) ids.add(cell.split('|')[1]);
		}
	}
	const logins: Record<string, string> = {};
	await Promise.all(
		[...ids].map(async (id) => {
			const n = Number(id);
			if (!Number.isInteger(n) || n <= 0) return; // not a numeric id: leave as-is
			try {
				const login = await getUserLogin(n);
				if (login) logins[id] = login;
			} catch {
				// A failed lookup just falls back to the id in the UI.
			}
		})
	);
	return logins;
}
