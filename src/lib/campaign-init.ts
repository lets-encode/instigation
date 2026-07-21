// Campaign initialisation logic — Action A, `whole` strategy, schema v2.
// See DESIGN.md §5. Pure functions: strings/objects in, strings out. No
// filesystem or network access.
//
// Produces, from a filled config:
//   - config.yaml            (configToYaml)
//   - sources/score.mei      (stampTemplate: fills {{TITLE}}/{{COMPOSER}}/{{LICENSE}};
//                             facsimile campaigns commit the stage-A facsimile MEI instead)
//   - tracking/task.csv      (buildTaskCsv: task T0001 + one validation subtask S0001;
//                             facsimile campaigns prepend the P0001 pre-task and split
//                             encoding into one task per page carrying measures)
//   - tracking/state.csv     (buildStateCsv: tasks encoding_required, subtasks pending)
//   - tracking/lock.csv      (buildLockCsv: header only)
//   - tracking/history.csv   (buildHistoryCsv: header only)

/** The central automation pointer the campaign's caller workflow reads (§4a). */
export interface AutomationPointer {
	central_repository: string;
	ref: string;
	path: string;
}

/** A schema-v2 campaign config object. */
export interface CampaignConfig {
	schema_version: number;
	campaign: {
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
	sources: Array<{
		id: string;
		kind: string;
		path: string;
		template: string;
		header: { composer: string };
	}>;
	fragmentation: { strategy: string };
	validation: { required_validations: number; pass_threshold: number };
	locking: { stale_after_minutes: number };
}

/** Create-form fields feeding buildCampaignConfig; unset fields fall to defaults. */
export interface CampaignFields {
	title?: string;
	description?: string;
	language?: string;
	license?: string;
	composer?: string;
	/** 'mei-template' (blank template score) or 'facsimile' (detected page images + pre-tasks). */
	sourceKind?: string;
	required_validations?: number;
	pass_threshold?: number;
	stale_after_minutes?: number;
}

const TASK_COLUMNS = ['task_id', 'subtask_id', 'fragment', 'locator', 'allowlist', 'blocklist', 'depends_on'];
const STATE_BASE_COLUMNS = ['task_id', 'subtask_id', 'status', 'encoder', 'encoded_at'];
const LOCK_COLUMNS = ['task_id', 'subtask_id', 'user_id', 'timestamp', 'kind'];
const HISTORY_COLUMNS = ['timestamp', 'task_id', 'subtask_id', 'user_id', 'action', 'outcome', 'detail', 'command', 'version', 'input'];

// Defaults for fields the create form does not surface.
const DEFAULTS = {
	language: 'en',
	license: 'CC-BY-4.0',
	composer: '',
	required_validations: 1,
	pass_threshold: 1,
	stale_after_minutes: 120
};

// Escape the minimum needed to keep substituted header values well-formed XML.
function xmlEscape(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

// RFC-4180 field: quote only when it contains a comma, quote or newline.
function csvField(value: unknown): string {
	const s = value == null ? '' : String(value);
	return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const csvRow = (fields: unknown[]): string => fields.map(csvField).join(',');

// JSON string syntax is valid for YAML double-quoted scalars and escapes
// quotes, backslashes, newlines and control characters.
function yamlStr(value: unknown): string {
	return JSON.stringify(String(value ?? ''));
}

// Two source kinds, one fragmentation strategy and one schema version are
// implemented. Fail loudly rather than silently mis-initialising.
export function assertSupported(config: CampaignConfig): void {
	if (config?.schema_version !== 2) {
		throw new Error(`Unsupported schema_version: ${config?.schema_version} (expected 2).`);
	}
	const strategy = config.fragmentation?.strategy;
	if (strategy !== 'whole') {
		throw new Error(`Unsupported fragmentation.strategy: ${strategy} (only 'whole' is implemented).`);
	}
	const source = config.sources?.[0];
	if (!source) throw new Error('config.sources must contain at least one source.');
	if (source.kind !== 'mei-template' && source.kind !== 'facsimile') {
		throw new Error(`Unsupported source kind: ${source.kind} (only 'mei-template' and 'facsimile' are implemented).`);
	}
}

/**
 * Build the schema-v2 campaign config object from create-form fields, the
 * instigator's numeric account id, the central automation pointer, and the
 * campaign repo's numeric id. Unspecified optional fields fall back to defaults.
 */
export function buildCampaignConfig(
	fields: CampaignFields,
	instigator: string,
	automation: AutomationPointer,
	repoId: number
): CampaignConfig {
	return {
		schema_version: 2,
		campaign: {
			title: fields.title ?? '',
			description: fields.description ?? '',
			instigator,
			repo_id: repoId,
			language: fields.language ?? DEFAULTS.language,
			license: fields.license ?? DEFAULTS.license
		},
		automation: { ...automation },
		sources: [
			{
				id: 'src-1',
				kind: fields.sourceKind ?? 'mei-template',
				path: 'sources/score.mei',
				template: 'templates/score.template.mei',
				header: { composer: fields.composer ?? DEFAULTS.composer }
			}
		],
		fragmentation: { strategy: 'whole' },
		validation: {
			required_validations: fields.required_validations ?? DEFAULTS.required_validations,
			pass_threshold: fields.pass_threshold ?? DEFAULTS.pass_threshold
		},
		locking: { stale_after_minutes: fields.stale_after_minutes ?? DEFAULTS.stale_after_minutes }
	};
}

/** Serialise a schema-v2 config object to the canonical config.yaml text. */
export function configToYaml(config: CampaignConfig): string {
	const { campaign: c, sources, validation: v, locking: l } = config;
	const src = sources[0];
	return (
		`schema_version: ${config.schema_version}\n` +
		`campaign:\n` +
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
		`sources:\n` +
		`  - id: ${yamlStr(src.id)}\n` +
		`    kind: ${yamlStr(src.kind)}\n` +
		`    path: ${yamlStr(src.path)}\n` +
		`    template: ${yamlStr(src.template)}\n` +
		`    header:\n` +
		`      composer: ${yamlStr(src.header.composer)}\n` +
		`fragmentation:\n` +
		`  strategy: ${yamlStr(config.fragmentation.strategy)}\n` +
		`validation:\n` +
		`  required_validations: ${v.required_validations}\n` +
		`  pass_threshold: ${v.pass_threshold}\n` +
		`locking:\n` +
		`  stale_after_minutes: ${l.stale_after_minutes}\n`
	);
}

/** Fill the {{TITLE}}/{{COMPOSER}}/{{LICENSE}} placeholders in the MEI template. */
export function stampTemplate(
	templateText: string,
	{ title, composer, license }: { title?: string; composer?: string; license?: string }
): string {
	return templateText
		.replaceAll('{{TITLE}}', xmlEscape(title))
		.replaceAll('{{COMPOSER}}', xmlEscape(composer))
		.replaceAll('{{LICENSE}}', xmlEscape(license));
}

const taskId = (n: number): string => `T${String(n).padStart(4, '0')}`;

// The 1-based page numbers (surface ids) that carry at least one measure, in
// upload order — the pages that become their own encoding task. Empty when no
// per-page counts were supplied.
function pagesWithMeasures(pageMeasureCounts?: number[]): number[] {
	return (pageMeasureCounts ?? []).flatMap((count, i) => (count > 0 ? [i + 1] : []));
}

/**
 * Build the task table.
 *
 * `mei-template` (`whole` strategy): one encoding task T0001 spanning the entire
 * source (task row, empty subtask_id) with one validation subtask S0001 — empty
 * locators address the whole file, allow/blocklists are open.
 *
 * A facsimile source prepends one pre-task (DESIGN.md §7a): P0001 corrects the
 * detected measures (locator `measure-zones`, with a validation subtask) —
 * measure boxes and numbers, page/system breaks, and movement boundaries in
 * one task. It then splits the encoding into one task per page that carries
 * measures (locator `surface-N`, matching the page's `<pb>`), each with its own
 * validation subtask and each depending on the pre-task; a page task's PR is
 * joined back into the shared score by page (mei-page-splice.ts). Without
 * per-page counts (e.g. re-init with no page data) it falls back to one whole
 * encoding task T0001.
 */
export function buildTaskCsv(config: CampaignConfig, pageMeasureCounts?: number[]): string {
	const fragment = config.sources[0].path;
	const lines = [csvRow(TASK_COLUMNS)];

	if (config.sources[0].kind !== 'facsimile') {
		lines.push(csvRow(['T0001', '', fragment, '', '', '', '']));
		lines.push(csvRow(['T0001', 'S0001', fragment, '', '', '', '']));
		return `${lines.join('\n')}\n`;
	}

	lines.push(csvRow(['P0001', '', fragment, 'measure-zones', '', '', '']));
	lines.push(csvRow(['P0001', 'S0001', fragment, 'measure-zones', '', '', '']));

	const pages = pagesWithMeasures(pageMeasureCounts);
	if (pages.length === 0) {
		lines.push(csvRow(['T0001', '', fragment, '', '', '', 'P0001']));
		lines.push(csvRow(['T0001', 'S0001', fragment, '', '', '', '']));
	} else {
		pages.forEach((page, i) => {
			const id = taskId(i + 1);
			const locator = `surface-${page}`;
			lines.push(csvRow([id, '', fragment, locator, '', '', 'P0001']));
			lines.push(csvRow([id, 'S0001', fragment, locator, '', '', '']));
		});
	}
	return `${lines.join('\n')}\n`;
}

/**
 * Build the initial state table: task rows start at encoding_required,
 * validation subtasks at pending, with empty validate_status_1…n cells. Its
 * rows mirror buildTaskCsv one-for-one (same pre-task and per-page tasks).
 */
export function buildStateCsv(config: CampaignConfig, pageMeasureCounts?: number[]): string {
	const count = config.validation?.required_validations ?? 0;
	const validationCols = Array.from({ length: count }, (_, i) => `validate_status_${i + 1}`);
	const header = [...STATE_BASE_COLUMNS, ...validationCols];
	const empty = validationCols.map(() => '');
	const lines = [csvRow(header)];
	const task = (id: string) => lines.push(csvRow([id, '', 'encoding_required', '', '', ...empty]));
	const subtask = (id: string) => lines.push(csvRow([id, 'S0001', 'pending', '', '', ...empty]));

	if (config.sources[0].kind !== 'facsimile') {
		task('T0001');
		subtask('T0001');
		return `${lines.join('\n')}\n`;
	}

	task('P0001');
	subtask('P0001');
	const pages = pagesWithMeasures(pageMeasureCounts);
	if (pages.length === 0) {
		task('T0001');
		subtask('T0001');
	} else {
		pages.forEach((_page, i) => {
			task(taskId(i + 1));
			subtask(taskId(i + 1));
		});
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
