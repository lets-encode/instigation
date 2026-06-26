// Tracking-table (de)serialisation — shared by Actions B and C. Pure functions:
// CSV text in, plain objects out (and back). No GitHub, no filesystem.
//
// Table layouts are defined in DESIGN.md §4 (config & formats). The five base
// state columns are fixed; everything after them is a
// validation cell (v1…vn), so `required_validations` is just their count.

const STATE_BASE_COLUMNS = ['task_id', 'fragment', 'state', 'encoder', 'encoded_at'];
const LOCK_COLUMNS = ['task_id', 'locked_by', 'locked_at', 'kind'];

// RFC-4180 field: quote only when it contains a comma, quote or newline.
function csvField(value) {
	const s = value == null ? '' : String(value);
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const csvRow = (fields) => fields.map(csvField).join(',');

/** Parse CSV text into an array of rows (each an array of string fields). */
export function parseCsv(text) {
	const rows = [];
	let row = [];
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

/**
 * Parse state.csv. Returns { header, validationColumns, rows } where each row
 * is an object keyed by column name. validationColumns is the v1…vn slice.
 */
export function parseStateCsv(text) {
	const all = parseCsv(text);
	const header = all[0] ?? [];
	const validationColumns = header.slice(STATE_BASE_COLUMNS.length);
	const rows = all.slice(1).map((cells) =>
		Object.fromEntries(header.map((col, i) => [col, cells[i] ?? '']))
	);
	return { header, validationColumns, rows };
}

/** Parse locks.csv into an array of { task_id, locked_by, locked_at, kind }. */
export function parseLocksCsv(text) {
	return parseCsv(text)
		.slice(1)
		.map((cells) => ({
			task_id: cells[0] ?? '',
			locked_by: cells[1] ?? '',
			locked_at: cells[2] ?? '',
			kind: cells[3] ?? ''
		}));
}

/** Serialise lock rows back to locks.csv text (header + one line per row). */
export function serializeLocksCsv(rows) {
	const lines = [csvRow(LOCK_COLUMNS), ...rows.map((r) => csvRow([r.task_id, r.locked_by, r.locked_at, r.kind]))];
	return `${lines.join('\n')}\n`;
}

/** Serialise a parsed state table ({ header, rows }) back to state.csv text. */
export function serializeStateCsv({ header, rows }) {
	const lines = [csvRow(header), ...rows.map((r) => csvRow(header.map((col) => r[col] ?? '')))];
	return `${lines.join('\n')}\n`;
}

/** True if a vN cell holds a final outcome (pass/fail) rather than being open. */
export function isFinalValidation(cell) {
	return cell.startsWith('pass|') || cell.startsWith('fail|');
}
