import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaxValidator } from 'fast-xml-validator';

import {
	buildCampaignConfig,
	configToYaml,
	stampTemplate,
	buildTaskCsv,
	buildStateCsv,
	buildLockCsv,
	buildHistoryCsv,
	assertSupported
} from '../campaign-init.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// instigation/src/lib -> up 3 -> lets-encode/ -> the template repo.
const TEMPLATE_MEI = join(HERE, '../../../../user-repo-template/templates/score.template.mei');

// The create-form fields for the worked example (one-note test case; DESIGN.md §6).
const WORKED_EXAMPLE_FIELDS = {
	title: 'Test Campaign — One Note',
	description: 'Smallest possible campaign for end-to-end testing.',
	language: 'en',
	license: 'CC-BY-4.0',
	composer: 'Anonymous'
};

// The central automation pointer, as the deployment config would supply it.
const AUTOMATION = {
	central_repository: 'lets-encode/instigation',
	ref: 'main',
	path: 'scripts/coordinator.ts'
};

// The created repo's numeric id, as createRepoFromTemplate would return it.
const REPO_ID = 424242;

test('buildCampaignConfig: instigator + repo_id come from args; defaults fill the rest', () => {
	const config = buildCampaignConfig({ title: 'T' }, 'test-instigator', AUTOMATION, REPO_ID);
	assert.equal(config.campaign.instigator, 'test-instigator');
	assert.equal(config.campaign.repo_id, REPO_ID);
	assert.equal(config.campaign.license, 'CC-BY-4.0');
	assert.equal(config.automation.central_repository, 'lets-encode/instigation');
	assert.equal(config.validation.required_validations, 1);
	assert.equal(config.locking.stale_after_minutes, 120);
	assert.doesNotThrow(() => assertSupported(config));
});

test('configToYaml: matches the worked example', () => {
	const config = buildCampaignConfig(WORKED_EXAMPLE_FIELDS, 'test-instigator', AUTOMATION, REPO_ID);
	assert.equal(
		configToYaml(config),
		'schema_version: 2\n' +
			'campaign:\n' +
			'  title: "Test Campaign — One Note"\n' +
			'  description: "Smallest possible campaign for end-to-end testing."\n' +
			'  instigator: "test-instigator"\n' +
			'  repo_id: 424242\n' +
			'  language: "en"\n' +
			'  license: "CC-BY-4.0"\n' +
			'automation:\n' +
			'  central_repository: "lets-encode/instigation"\n' +
			'  ref: "main"\n' +
			'  path: "scripts/coordinator.ts"\n' +
			'sources:\n' +
			'  - id: "src-1"\n' +
			'    kind: "mei-template"\n' +
			'    path: "sources/score.mei"\n' +
			'    template: "templates/score.template.mei"\n' +
			'    header:\n' +
			'      composer: "Anonymous"\n' +
			'fragmentation:\n' +
			'  strategy: "whole"\n' +
			'validation:\n' +
			'  required_validations: 1\n' +
			'  pass_threshold: 1\n' +
			'locking:\n' +
			'  stale_after_minutes: 120\n'
	);
});

test('worked example: stamped MEI is well-formed and placeholders filled', () => {
	const config = buildCampaignConfig(WORKED_EXAMPLE_FIELDS, 'test-instigator', AUTOMATION, REPO_ID);
	const mei = stampTemplate(readFileSync(TEMPLATE_MEI, 'utf8'), {
		title: config.campaign.title,
		composer: config.sources[0].header.composer,
		license: config.campaign.license
	});

	assert.equal(SyntaxValidator.validate(mei), true, 'sources/score.mei must be well-formed XML');
	for (const ph of ['{{TITLE}}', '{{COMPOSER}}', '{{LICENSE}}']) {
		assert.equal(mei.includes(ph), false, `placeholder ${ph} should be filled`);
	}
	assert.match(mei, /<title>Test Campaign — One Note<\/title>/);
	assert.match(mei, /role="composer">Anonymous</);
	assert.match(mei, /<useRestrict>CC-BY-4\.0<\/useRestrict>/);
});

test('worked example: task.csv holds the task row and its one validation subtask', () => {
	const config = buildCampaignConfig(WORKED_EXAMPLE_FIELDS, 'test-instigator', AUTOMATION, REPO_ID);
	assert.equal(
		buildTaskCsv(config),
		'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n' +
			'T0001,,sources/score.mei,,,,\n' +
			'T0001,S0001,sources/score.mei,,,,\n'
	);
});

test('facsimile campaign: task.csv chains the pre-task before the encoding task', () => {
	const config = buildCampaignConfig(
		{ ...WORKED_EXAMPLE_FIELDS, sourceKind: 'facsimile' },
		'test-instigator',
		AUTOMATION,
		REPO_ID
	);
	assert.equal(
		buildTaskCsv(config),
		'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n' +
			'P0001,,sources/score.mei,measure-zones,,,\n' +
			'P0001,S0001,sources/score.mei,measure-zones,,,\n' +
			'T0001,,sources/score.mei,,,,P0001\n' +
			'T0001,S0001,sources/score.mei,,,,\n'
	);
	assert.equal(
		buildStateCsv(config),
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
			'P0001,,encoding_required,,,\n' +
			'P0001,S0001,pending,,,\n' +
			'T0001,,encoding_required,,,\n' +
			'T0001,S0001,pending,,,\n'
	);
});

test('facsimile campaign: page counts split encoding into one task per page with measures', () => {
	const config = buildCampaignConfig(
		{ ...WORKED_EXAMPLE_FIELDS, sourceKind: 'facsimile' },
		'test-instigator',
		AUTOMATION,
		REPO_ID
	);
	// Page 2 has no measures, so it gets no task; pages 1 and 3 do.
	assert.equal(
		buildTaskCsv(config, [4, 0, 5]),
		'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n' +
			'P0001,,sources/score.mei,measure-zones,,,\n' +
			'P0001,S0001,sources/score.mei,measure-zones,,,\n' +
			'T0001,,sources/score.mei,surface-1,,,P0001\n' +
			'T0001,S0001,sources/score.mei,surface-1,,,\n' +
			'T0002,,sources/score.mei,surface-3,,,P0001\n' +
			'T0002,S0001,sources/score.mei,surface-3,,,\n'
	);
	assert.equal(
		buildStateCsv(config, [4, 0, 5]),
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
			'P0001,,encoding_required,,,\n' +
			'P0001,S0001,pending,,,\n' +
			'T0001,,encoding_required,,,\n' +
			'T0001,S0001,pending,,,\n' +
			'T0002,,encoding_required,,,\n' +
			'T0002,S0001,pending,,,\n'
	);
});

test('worked example: state.csv matches the expected rows exactly', () => {
	const config = buildCampaignConfig(WORKED_EXAMPLE_FIELDS, 'test-instigator', AUTOMATION, REPO_ID);
	assert.equal(
		buildStateCsv(config),
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
			'T0001,,encoding_required,,,\n' +
			'T0001,S0001,pending,,,\n'
	);
});

test('worked example: lock.csv and history.csv are header-only', () => {
	assert.equal(buildLockCsv(), 'task_id,subtask_id,user_id,timestamp,kind\n');
	assert.equal(
		buildHistoryCsv(),
		'timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input\n'
	);
});

test('buildStateCsv: required_validations controls the validate_status columns', () => {
	const config = buildCampaignConfig({ required_validations: 3 }, 'test-instigator', AUTOMATION, REPO_ID);
	assert.equal(
		buildStateCsv(config),
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2,validate_status_3\n' +
			'T0001,,encoding_required,,,,,\n' +
			'T0001,S0001,pending,,,,,\n'
	);
});

test('stampTemplate: substituted values are XML-escaped', () => {
	const out = stampTemplate('<title>{{TITLE}}</title>', {
		title: 'Bach & Sons <Works>',
		composer: '',
		license: ''
	});
	assert.equal(out, '<title>Bach &amp; Sons &lt;Works&gt;</title>');
});

test('configToYaml: YAML-sensitive characters are escaped', () => {
	const config = buildCampaignConfig({ title: 'A "quoted" \\ title\nsecond line' }, 'test-instigator', AUTOMATION, REPO_ID);
	assert.ok(configToYaml(config).includes('  title: "A \\"quoted\\" \\\\ title\\nsecond line"\n'));
});

test('assertSupported: rejects unsupported schema, fragmentation and source shapes', () => {
	const unsupportedSchema = buildCampaignConfig({}, 'test-instigator', AUTOMATION, REPO_ID);
	unsupportedSchema.schema_version = 1;
	assert.throws(() => assertSupported(unsupportedSchema), /schema_version/);

	const unsupportedStrategy = buildCampaignConfig({}, 'test-instigator', AUTOMATION, REPO_ID);
	unsupportedStrategy.fragmentation.strategy = 'by_measure';
	assert.throws(() => assertSupported(unsupportedStrategy), /fragmentation\.strategy/);

	const missingSource = buildCampaignConfig({}, 'test-instigator', AUTOMATION, REPO_ID);
	missingSource.sources = [];
	assert.throws(() => assertSupported(missingSource), /at least one source/);

	const unsupportedSource = buildCampaignConfig({}, 'test-instigator', AUTOMATION, REPO_ID);
	unsupportedSource.sources[0].kind = 'musicxml';
	assert.throws(() => assertSupported(unsupportedSource), /source kind/);
});
