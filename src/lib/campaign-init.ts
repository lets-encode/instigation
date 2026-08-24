// Campaign initialisation logic — Action A, `by-piece` strategy, schema v3.
// See DESIGN.md §5. Pure functions: strings/objects in, strings out. No
// filesystem or network access.
//
// A campaign describes one physical source holding N pieces (works). Each piece
// is one MEI at its own path and one group of tasks; the tables address every
// task by that path, which is what the coordinator resolves a submission
// against.
//
// Produces, from a filled config:
//   - config.yaml            (configToYaml)
//   - sources/<piece>/score.mei  (one per piece; built by mei-facsimile.ts)
//   - tracking/task.csv      (buildTaskCsv: per piece, a score-setup pre-task,
//                             a measure-correction pre-task and one encoding
//                             task per covered page for a facsimile piece; one
//                             whole-file task for an encoded piece; a
//                             score-setup pre-task plus per-page or whole-file
//                             tasks for a physical piece; each with a
//                             validation subtask)
//   - tracking/state.csv     (buildStateCsv: tasks encoding_required, subtasks pending)
//   - tracking/lock.csv      (buildLockCsv: header only)
//   - tracking/history.csv   (buildHistoryCsv: header only)

import {
	COMMENT_COLUMNS,
	HISTORY_COLUMNS,
	LOCK_COLUMNS,
	STATE_BASE_COLUMNS,
	TASK_COLUMNS,
	csvRow
} from './campaign-tables.ts';

/** The central automation pointer the campaign's caller workflow reads (§4a). */
export interface AutomationPointer {
	central_repository: string;
	ref: string;
	path: string;
}

/** A region of one page image that a piece covers. */
export interface ConfigZone {
	/** 1-based page number, matching the page's `<pb>` / surface id. */
	surface: number;
	ulx: number;
	uly: number;
	lrx: number;
	lry: number;
}

/** One work within the source: its own MEI, its own tasks. */
export interface ConfigPiece {
	id: string;
	/**
	 * 'facsimile' (regions volunteers encode), 'encoded' (an uploaded score) or
	 * 'physical-only' (transcribed from the physical source; no images).
	 */
	kind: string;
	/** Repo path of this piece's MEI — the `fragment` its tasks address. */
	path: string;
	/** Regions this piece covers. Empty for encoded and physical pieces. */
	zones: ConfigZone[];
	/** For a physical piece, how many pages of the source it spans; unset = unknown. */
	pages?: number;
	header: { title: string; composer: string };
}

/** A schema-v3 campaign config object. */
export interface CampaignConfig {
	schema_version: number;
	campaign: {
		/** The campaign's handle: repo name, registry slug and address at once. */
		name: string;
		/** Human-readable label for the campaign. */
		title: string;
		description: string;
		/** The instigator's stable numeric GitHub account id (as a string). */
		instigator: string;
		/** This campaign repo's stable numeric GitHub id (rename/transfer-proof). */
		repo_id: number;
		language: string;
		license: string;
	};
	automation: AutomationPointer;
	/** The physical source the pieces were read from. */
	source: {
		kind: string;
		/** Committed page images, repo-relative. */
		images: string[];
		header: { title: string; composer: string; publisher: string; date: string };
		/** Which acknowledgement the instigator agreed to, for provenance. */
		rights_acknowledged: string;
	};
	pieces: ConfigPiece[];
	fragmentation: { strategy: string };
	validation: { required_validations: number; pass_threshold: number };
	locking: { stale_after_minutes: number };
}

/** Create-form fields feeding buildCampaignConfig; unset fields fall to defaults. */
export interface CampaignFields {
	name?: string;
	title?: string;
	description?: string;
	language?: string;
	license?: string;
	/** 'facsimile' | 'mei-template' | 'physical-only' — what the source itself is. */
	sourceKind?: string;
	sourceHeader?: { title?: string; composer?: string; publisher?: string; date?: string };
	images?: string[];
	rightsAcknowledged?: string;
	pieces?: ConfigPiece[];
	required_validations?: number;
	pass_threshold?: number;
	stale_after_minutes?: number;
}

// Defaults for fields the create form does not surface.
const DEFAULTS = {
	language: 'en',
	license: 'CC-BY-4.0',
	required_validations: 1,
	pass_threshold: 1,
	stale_after_minutes: 120
};

/** The repo path a piece's MEI is committed to, and its tasks address. */
export const piecePath = (id: string): string => `sources/${id}/score.mei`;

// JSON string syntax is valid for YAML double-quoted scalars and escapes
// quotes, backslashes, newlines and control characters.
function yamlStr(value: unknown): string {
	return JSON.stringify(String(value ?? ''));
}

// One fragmentation strategy, three piece kinds and one schema version are
// implemented. Fail loudly rather than silently mis-initialising.
export function assertSupported(config: CampaignConfig): void {
	if (config?.schema_version !== 3) {
		throw new Error(`Unsupported schema_version: ${config?.schema_version} (expected 3).`);
	}
	const strategy = config.fragmentation?.strategy;
	if (strategy !== 'by-piece') {
		throw new Error(`Unsupported fragmentation.strategy: ${strategy} (only 'by-piece' is implemented).`);
	}
	if (!config.pieces?.length) throw new Error('config.pieces must contain at least one piece.');
	for (const piece of config.pieces) {
		if (piece.kind !== 'facsimile' && piece.kind !== 'encoded' && piece.kind !== 'physical-only') {
			throw new Error(
				`Unsupported piece kind: ${piece.kind} (only 'facsimile', 'encoded' and 'physical-only' are implemented).`
			);
		}
		if (!piece.path) throw new Error(`Piece ${piece.id} has no path.`);
	}
	// Two pieces sharing a path would make a submission ambiguous: the
	// coordinator resolves a task by its fragment path alone.
	const paths = config.pieces.map((piece) => piece.path);
	if (new Set(paths).size !== paths.length) {
		throw new Error('Each piece must have a distinct path.');
	}
}

/**
 * Build the schema-v3 campaign config object from the wizard's fields, the
 * instigator's numeric account id, the central automation pointer, and the
 * campaign repo's numeric id. Unspecified optional fields fall back to defaults.
 */
export function buildCampaignConfig(
	fields: CampaignFields,
	instigator: string,
	automation: AutomationPointer,
	repoId: number
): CampaignConfig {
	const header = fields.sourceHeader ?? {};
	return {
		schema_version: 3,
		campaign: {
			name: fields.name ?? '',
			title: fields.title ?? '',
			description: fields.description ?? '',
			instigator,
			repo_id: repoId,
			language: fields.language ?? DEFAULTS.language,
			license: fields.license ?? DEFAULTS.license
		},
		automation: { ...automation },
		source: {
			kind: fields.sourceKind ?? 'facsimile',
			images: fields.images ?? [],
			header: {
				title: header.title ?? '',
				composer: header.composer ?? '',
				publisher: header.publisher ?? '',
				date: header.date ?? ''
			},
			rights_acknowledged: fields.rightsAcknowledged ?? ''
		},
		pieces: (fields.pieces ?? []).map((piece) => ({
			...piece,
			path: piece.path || piecePath(piece.id),
			zones: piece.zones ?? []
		})),
		fragmentation: { strategy: 'by-piece' },
		validation: {
			required_validations: fields.required_validations ?? DEFAULTS.required_validations,
			pass_threshold: fields.pass_threshold ?? DEFAULTS.pass_threshold
		},
		locking: { stale_after_minutes: fields.stale_after_minutes ?? DEFAULTS.stale_after_minutes }
	};
}

/**
 * Serialise a schema-v3 config object to the canonical config.yaml text.
 * Rejects unsupported configs (assertSupported), so nothing unsupported is
 * ever committed as a campaign's config.
 */
export function configToYaml(config: CampaignConfig): string {
	assertSupported(config);
	const { campaign: c, source: s, validation: v, locking: l } = config;
	const images = s.images.length
		? s.images.map((image) => `    - ${yamlStr(image)}\n`).join('')
		: '';
	const pieces = config.pieces
		.map((piece) => {
			const zones = piece.zones.length
				? piece.zones
						.map(
							(z) =>
								`      - { surface: ${z.surface}, ulx: ${z.ulx}, uly: ${z.uly}, ` +
								`lrx: ${z.lrx}, lry: ${z.lry} }\n`
						)
						.join('')
				: '';
			return (
				`  - id: ${yamlStr(piece.id)}\n` +
				`    kind: ${yamlStr(piece.kind)}\n` +
				`    path: ${yamlStr(piece.path)}\n` +
				(piece.pages ? `    pages: ${piece.pages}\n` : '') +
				`    zones:${zones ? `\n${zones}` : ' []\n'}` +
				`    header:\n` +
				`      title: ${yamlStr(piece.header.title)}\n` +
				`      composer: ${yamlStr(piece.header.composer)}\n`
			);
		})
		.join('');
	return (
		`schema_version: ${config.schema_version}\n` +
		`campaign:\n` +
		`  name: ${yamlStr(c.name)}\n` +
		`  title: ${yamlStr(c.title)}\n` +
		`  description: ${yamlStr(c.description)}\n` +
		`  instigator: ${yamlStr(c.instigator)}\n` +
		`  repo_id: ${c.repo_id}\n` +
		`  language: ${yamlStr(c.language)}\n` +
		`  license: ${yamlStr(c.license)}\n` +
		`automation:\n` +
		`  central_repository: ${yamlStr(config.automation.central_repository)}\n` +
		`  ref: ${yamlStr(config.automation.ref)}\n` +
		`  path: ${yamlStr(config.automation.path)}\n` +
		`source:\n` +
		`  kind: ${yamlStr(s.kind)}\n` +
		`  images:${images ? `\n${images}` : ' []\n'}` +
		`  header:\n` +
		`    title: ${yamlStr(s.header.title)}\n` +
		`    composer: ${yamlStr(s.header.composer)}\n` +
		`    publisher: ${yamlStr(s.header.publisher)}\n` +
		`    date: ${yamlStr(s.header.date)}\n` +
		`  rights_acknowledged: ${yamlStr(s.rights_acknowledged)}\n` +
		`pieces:${config.pieces.length ? `\n${pieces}` : ' []\n'}` +
		`fragmentation:\n` +
		`  strategy: ${yamlStr(config.fragmentation.strategy)}\n` +
		`validation:\n` +
		`  required_validations: ${v.required_validations}\n` +
		`  pass_threshold: ${v.pass_threshold}\n` +
		`locking:\n` +
		`  stale_after_minutes: ${l.stale_after_minutes}\n`
	);
}

const taskId = (n: number): string => `T${String(n).padStart(4, '0')}`;
const preTaskId = (n: number): string => `P${String(n).padStart(4, '0')}`;

/**
 * Per piece, the 1-based page numbers carrying at least one measure — the pages
 * that become their own encoding task. Keyed by piece id.
 */
export type PieceSurfaces = Record<string, number[]>;

/** The pages a facsimile piece is split by: measured pages, else the pages it covers. */
function surfacesFor(piece: ConfigPiece, surfaces?: PieceSurfaces): number[] {
	const measured = surfaces?.[piece.id];
	if (measured) return [...measured].sort((a, b) => a - b);
	return [...new Set(piece.zones.map((zone) => zone.surface))].sort((a, b) => a - b);
}

/** One planned task: the row pair the task and state tables each emit for it. */
export interface PlannedTask {
	id: string;
	fragment: string;
	locator: string;
	dependsOn: string;
}

/**
 * The campaign's tasks, in table order.
 *
 * Each facsimile and physical piece opens with its own score-setup pre-task
 * (DESIGN.md §7a, locator `score-setup`), whose deliverable is the piece's
 * initial score definition — staves with their clefs and instrument labels,
 * key signature and meter.
 *
 * A facsimile piece follows with its measure-correction pre-task (locator
 * `measure-zones`, depending on the setup task) covering measure boxes and
 * numbers, page/system breaks and movement boundaries; its encoding is then
 * split into one task per page carrying measures (locator `surface-N`,
 * matching that page's `<pb>`), each depending on that piece's
 * measure-correction pre-task. A facsimile piece with no measured pages falls
 * back to a single whole-file encoding task.
 *
 * An encoded piece is already notated, so it gets one whole-file task and no
 * pre-tasks.
 *
 * A physical piece is transcribed from the source itself: there is no
 * facsimile to correct measures on, so no measure-correction pre-task. A known
 * page count splits its encoding into one task per page (locator `surface-N`,
 * matching the blank score's `<pb>` markers); without one it gets a single
 * whole-file task. Either way its encoding depends on the setup task.
 *
 * Task numbers run continuously across pieces while pre-task numbers run
 * across facsimile and physical pieces only, so every id is unique
 * campaign-wide. Both tables are rendered from this one plan so they cannot
 * fall out of step.
 */
export function planTasks(config: CampaignConfig, surfaces?: PieceSurfaces): PlannedTask[] {
	const planned: PlannedTask[] = [];
	let tasks = 0;
	let preTasks = 0;
	for (const piece of config.pieces) {
		if (piece.kind === 'physical-only') {
			const setup = preTaskId(++preTasks);
			planned.push({ id: setup, fragment: piece.path, locator: 'score-setup', dependsOn: '' });
			const count = piece.pages ?? 0;
			if (count < 1) {
				planned.push({ id: taskId(++tasks), fragment: piece.path, locator: '', dependsOn: setup });
			} else {
				for (let page = 1; page <= count; page++) {
					planned.push({
						id: taskId(++tasks),
						fragment: piece.path,
						locator: `surface-${page}`,
						dependsOn: setup
					});
				}
			}
			continue;
		}
		if (piece.kind !== 'facsimile') {
			planned.push({ id: taskId(++tasks), fragment: piece.path, locator: '', dependsOn: '' });
			continue;
		}
		const setup = preTaskId(++preTasks);
		planned.push({ id: setup, fragment: piece.path, locator: 'score-setup', dependsOn: '' });
		const pre = preTaskId(++preTasks);
		planned.push({ id: pre, fragment: piece.path, locator: 'measure-zones', dependsOn: setup });
		const pages = surfacesFor(piece, surfaces);
		if (pages.length === 0) {
			planned.push({ id: taskId(++tasks), fragment: piece.path, locator: '', dependsOn: pre });
		} else {
			for (const page of pages) {
				planned.push({
					id: taskId(++tasks),
					fragment: piece.path,
					locator: `surface-${page}`,
					dependsOn: pre
				});
			}
		}
	}
	return planned;
}

/**
 * Build the task table: for every planned task a task row (empty subtask_id)
 * and one validation subtask S0001. Empty locators address the whole fragment;
 * allow/blocklists are open. A page task's PR is joined back into its piece's
 * score by page (mei-page-splice.ts).
 */
export function buildTaskCsv(config: CampaignConfig, surfaces?: PieceSurfaces): string {
	const lines = [csvRow(TASK_COLUMNS)];
	for (const { id, fragment, locator, dependsOn } of planTasks(config, surfaces)) {
		lines.push(csvRow([id, '', fragment, locator, '', '', dependsOn]));
		lines.push(csvRow([id, 'S0001', fragment, locator, '', '', '']));
	}
	return `${lines.join('\n')}\n`;
}

/**
 * Build the initial state table: task rows start at encoding_required,
 * validation subtasks at pending, with empty validate_status_1…n cells. Its
 * rows mirror buildTaskCsv one-for-one.
 */
export function buildStateCsv(config: CampaignConfig, surfaces?: PieceSurfaces): string {
	const count = config.validation?.required_validations ?? 0;
	const validationCols = Array.from({ length: count }, (_, i) => `validate_status_${i + 1}`);
	const empty = validationCols.map(() => '');
	const lines = [csvRow([...STATE_BASE_COLUMNS, ...validationCols])];
	for (const { id } of planTasks(config, surfaces)) {
		lines.push(csvRow([id, '', 'encoding_required', '', '', ...empty]));
		lines.push(csvRow([id, 'S0001', 'pending', '', '', ...empty]));
	}
	return `${lines.join('\n')}\n`;
}

/** Build the initial lock table: header only. */
export function buildLockCsv(): string {
	return `${csvRow(LOCK_COLUMNS)}\n`;
}

/** Build the initial history table: header only. */
export function buildHistoryCsv(): string {
	return `${csvRow(HISTORY_COLUMNS)}\n`;
}

/** Build the initial comment table: header only. */
export function buildCommentCsv(): string {
	return `${csvRow(COMMENT_COLUMNS)}\n`;
}
