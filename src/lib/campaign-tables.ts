// Tracking-table (de)serialisation for the four v2 tables (task / state / lock
// / history), all keyed by (task_id, subtask_id): a row with an EMPTY
// subtask_id addresses the whole task (the unit of encoding), a row with a
// subtask_id addresses one validation portion. Pure functions: CSV text in,
// plain objects out (and back). No GitHub, no filesystem.
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
	user_id: string;
	action: string;
	outcome: string;
	detail: string;
	command?: string;
	version?: string;
	input?: string;
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
