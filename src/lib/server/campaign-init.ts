// Campaign initialisation logic — Action A, v1 `whole` strategy. See DESIGN.md §5.
// Server-only, pure functions: strings/objects in, strings out. No filesystem
// or network access.
//
// Produces, from a filled config:
//   - config.yaml          (configToYaml)
//   - sources/score.mei    (stampTemplate: fills {{TITLE}}/{{COMPOSER}}/{{LICENSE}})
//   - tracking/state.csv   (buildStateCsv: one task T0001, encoding_required)
//   - tracking/locks.csv   (buildLocksCsv: header only)

/** A v1 campaign config object. */
export interface CampaignConfig {
	schema_version: number;
	campaign: {
		title: string;
		description: string;
		instigator: string;
		language: string;
		license: string;
	};
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
	required_validations?: number;
	pass_threshold?: number;
	stale_after_minutes?: number;
}

const STATE_BASE_COLUMNS = ['task_id', 'fragment', 'state', 'encoder', 'encoded_at'];
const LOCK_COLUMNS = ['task_id', 'locked_by', 'locked_at', 'kind'];

// v1 defaults for fields the create form does not (yet) surface.
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

// Double-quoted YAML scalar; backslash and quote are the only escapes needed.
function yamlStr(value: unknown): string {
	return `"${String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// v1 implements exactly one source kind, one fragmentation strategy and one
// schema version. Fail loudly rather than silently mis-initialising.
export function assertSupported(config: CampaignConfig): void {
	if (config?.schema_version !== 1) {
		throw new Error(`Unsupported schema_version: ${config?.schema_version} (v1 expects 1).`);
	}
	const strategy = config.fragmentation?.strategy;
	if (strategy !== 'whole') {
		throw new Error(`Unsupported fragmentation.strategy: ${strategy} (v1 implements only 'whole').`);
	}
	const source = config.sources?.[0];
	if (!source) throw new Error('config.sources must contain at least one source.');
	if (source.kind !== 'mei-template') {
		throw new Error(`Unsupported source kind: ${source.kind} (v1 implements only 'mei-template').`);
	}
}

/**
 * Build the v1 campaign config object from create-form fields + the instigator
 * login. Unspecified optional fields fall back to v1 defaults.
 */
export function buildCampaignConfig(fields: CampaignFields, login: string): CampaignConfig {
	return {
		schema_version: 1,
		campaign: {
			title: fields.title ?? '',
			description: fields.description ?? '',
			instigator: login,
			language: fields.language ?? DEFAULTS.language,
			license: fields.license ?? DEFAULTS.license
		},
		sources: [
			{
				id: 'src-1',
				kind: 'mei-template',
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

/** Serialise a v1 config object to the canonical config.yaml text. */
export function configToYaml(config: CampaignConfig): string {
	const { campaign: c, sources, validation: v, locking: l } = config;
	const src = sources[0];
	return (
		`schema_version: ${config.schema_version}\n` +
		`campaign:\n` +
		`  title: ${yamlStr(c.title)}\n` +
		`  description: ${yamlStr(c.description)}\n` +
		`  instigator: ${yamlStr(c.instigator)}\n` +
		`  language: ${yamlStr(c.language)}\n` +
		`  license: ${yamlStr(c.license)}\n` +
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

/** Build the initial state table: one task T0001, encoding_required, empty vN cells. */
export function buildStateCsv(config: CampaignConfig): string {
	const count = config.validation?.required_validations ?? 0;
	const validationCols = Array.from({ length: count }, (_, i) => `v${i + 1}`);
	const header = [...STATE_BASE_COLUMNS, ...validationCols];
	const row = [
		'T0001',
		config.sources[0].path,
		'encoding_required',
		'', // encoder
		'', // encoded_at
		...validationCols.map(() => '')
	];
	return `${csvRow(header)}\n${csvRow(row)}\n`;
}

/** Build the initial lock table: header only. */
export function buildLocksCsv(): string {
	return `${csvRow(LOCK_COLUMNS)}\n`;
}
