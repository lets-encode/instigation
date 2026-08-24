import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	buildCampaignConfig,
	configToYaml,
	buildTaskCsv,
	buildStateCsv,
	buildLockCsv,
	buildHistoryCsv,
	assertSupported,
	planTasks,
	piecePath,
	type ConfigPiece
} from '../campaign-init.ts';

/** A facsimile piece covering whole pages, as the wizard would emit it. */
function facsimile(id: string, surfaces: number[], title = ''): ConfigPiece {
	return {
		id,
		kind: 'facsimile',
		path: piecePath(id),
		zones: surfaces.map((surface) => ({ surface, ulx: 0, uly: 0, lrx: 100, lry: 100 })),
		header: { title, composer: '' }
	};
}

function encoded(id: string, title = ''): ConfigPiece {
	return { id, kind: 'encoded', path: piecePath(id), zones: [], header: { title, composer: '' } };
}

/** A physical piece (no facsimile), optionally with a known page count. */
function physical(id: string, pages?: number, title = ''): ConfigPiece {
	return {
		id,
		kind: 'physical-only',
		path: piecePath(id),
		zones: [],
		...(pages ? { pages } : {}),
		header: { title, composer: '' }
	};
}

// The wizard's fields for the worked example (one-note test case; DESIGN.md §6).
const WORKED_EXAMPLE_FIELDS = {
	name: 'test-campaign-one-note',
	title: 'Test Campaign — One Note',
	description: 'Smallest possible campaign for end-to-end testing.',
	language: 'en',
	license: 'CC-BY-4.0',
	sourceHeader: { composer: 'Anonymous' },
	pieces: [facsimile('piece-01', [1])]
};

// The central automation pointer, as the deployment config would supply it.
const AUTOMATION = {
	central_repository: 'lets-encode/instigation',
	ref: 'main',
	path: 'scripts/coordinator.ts'
};

// The created repo's numeric id, as createRepoFromTemplate would return it.
const REPO_ID = 424242;

const build = (fields: Parameters<typeof buildCampaignConfig>[0] = {}) =>
	buildCampaignConfig(fields, 'test-instigator', AUTOMATION, REPO_ID);

test('buildCampaignConfig: instigator + repo_id come from args; defaults fill the rest', () => {
	const config = build({ title: 'T', pieces: [facsimile('piece-01', [1])] });
	assert.equal(config.schema_version, 3);
	assert.equal(config.campaign.instigator, 'test-instigator');
	assert.equal(config.campaign.repo_id, REPO_ID);
	assert.equal(config.campaign.license, 'CC-BY-4.0');
	assert.equal(config.automation.central_repository, 'lets-encode/instigation');
	assert.equal(config.fragmentation.strategy, 'by-piece');
	assert.equal(config.validation.required_validations, 1);
	assert.equal(config.locking.stale_after_minutes, 120);
	assert.doesNotThrow(() => assertSupported(config));
});

test('buildCampaignConfig: a piece with no explicit path gets the conventional one', () => {
	const config = build({
		pieces: [{ id: 'piece-07', kind: 'facsimile', path: '', zones: [], header: { title: '', composer: '' } }]
	});
	assert.equal(config.pieces[0].path, 'sources/piece-07/score.mei');
});

test('configToYaml: matches the worked example', () => {
	assert.equal(
		configToYaml(build(WORKED_EXAMPLE_FIELDS)),
		'schema_version: 3\n' +
			'campaign:\n' +
			'  name: "test-campaign-one-note"\n' +
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
			'source:\n' +
			'  kind: "facsimile"\n' +
			'  images: []\n' +
			'  header:\n' +
			'    title: ""\n' +
			'    composer: "Anonymous"\n' +
			'    publisher: ""\n' +
			'    date: ""\n' +
			'  rights_acknowledged: ""\n' +
			'pieces:\n' +
			'  - id: "piece-01"\n' +
			'    kind: "facsimile"\n' +
			'    path: "sources/piece-01/score.mei"\n' +
			'    zones:\n' +
			'      - { surface: 1, ulx: 0, uly: 0, lrx: 100, lry: 100 }\n' +
			'    header:\n' +
			'      title: ""\n' +
			'      composer: ""\n' +
			'fragmentation:\n' +
			'  strategy: "by-piece"\n' +
			'validation:\n' +
			'  required_validations: 1\n' +
			'  pass_threshold: 1\n' +
			'locking:\n' +
			'  stale_after_minutes: 120\n'
	);
});

test('configToYaml: committed images and the rights acknowledgement are recorded', () => {
	const yaml = configToYaml(
		build({
			images: ['sources/img/01.jpg', 'sources/img/02.jpg'],
			rightsAcknowledged: 'v1',
			pieces: [encoded('piece-01')]
		})
	);
	assert.ok(yaml.includes('  images:\n    - "sources/img/01.jpg"\n    - "sources/img/02.jpg"\n'));
	assert.ok(yaml.includes('  rights_acknowledged: "v1"\n'));
	// An encoded piece has no regions.
	assert.ok(yaml.includes('    zones: []\n'));
});

test('one facsimile piece: setup, then the measure pre-task, then its page task', () => {
	const config = build(WORKED_EXAMPLE_FIELDS);
	assert.equal(
		buildTaskCsv(config),
		'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n' +
			'P0001,,sources/piece-01/score.mei,score-setup,,,\n' +
			'P0001,S0001,sources/piece-01/score.mei,score-setup,,,\n' +
			'P0002,,sources/piece-01/score.mei,measure-zones,,,P0001\n' +
			'P0002,S0001,sources/piece-01/score.mei,measure-zones,,,\n' +
			'T0001,,sources/piece-01/score.mei,surface-1,,,P0002\n' +
			'T0001,S0001,sources/piece-01/score.mei,surface-1,,,\n'
	);
	assert.equal(
		buildStateCsv(config),
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\n' +
			'P0001,,encoding_required,,,\n' +
			'P0001,S0001,pending,,,\n' +
			'P0002,,encoding_required,,,\n' +
			'P0002,S0001,pending,,,\n' +
			'T0001,,encoding_required,,,\n' +
			'T0001,S0001,pending,,,\n'
	);
});

test('measured pages, not covered pages, decide the page tasks', () => {
	const config = build({ pieces: [facsimile('piece-01', [1, 2, 3])] });
	// The detector found measures only on pages 1 and 3.
	assert.equal(
		buildTaskCsv(config, { 'piece-01': [1, 3] }),
		'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\n' +
			'P0001,,sources/piece-01/score.mei,score-setup,,,\n' +
			'P0001,S0001,sources/piece-01/score.mei,score-setup,,,\n' +
			'P0002,,sources/piece-01/score.mei,measure-zones,,,P0001\n' +
			'P0002,S0001,sources/piece-01/score.mei,measure-zones,,,\n' +
			'T0001,,sources/piece-01/score.mei,surface-1,,,P0002\n' +
			'T0001,S0001,sources/piece-01/score.mei,surface-1,,,\n' +
			'T0002,,sources/piece-01/score.mei,surface-3,,,P0002\n' +
			'T0002,S0001,sources/piece-01/score.mei,surface-3,,,\n'
	);
});

test('a facsimile piece with no measured page falls back to one whole-file task', () => {
	const config = build({ pieces: [facsimile('piece-01', [])] });
	assert.deepEqual(planTasks(config), [
		{ id: 'P0001', fragment: 'sources/piece-01/score.mei', locator: 'score-setup', dependsOn: '' },
		{ id: 'P0002', fragment: 'sources/piece-01/score.mei', locator: 'measure-zones', dependsOn: 'P0001' },
		{ id: 'T0001', fragment: 'sources/piece-01/score.mei', locator: '', dependsOn: 'P0002' }
	]);
});

test('several pieces: ids stay unique and every task addresses its own piece', () => {
	const config = build({
		pieces: [facsimile('piece-01', [1, 2]), encoded('piece-02'), facsimile('piece-03', [2, 3])]
	});
	assert.deepEqual(planTasks(config), [
		{ id: 'P0001', fragment: 'sources/piece-01/score.mei', locator: 'score-setup', dependsOn: '' },
		{ id: 'P0002', fragment: 'sources/piece-01/score.mei', locator: 'measure-zones', dependsOn: 'P0001' },
		{ id: 'T0001', fragment: 'sources/piece-01/score.mei', locator: 'surface-1', dependsOn: 'P0002' },
		{ id: 'T0002', fragment: 'sources/piece-01/score.mei', locator: 'surface-2', dependsOn: 'P0002' },
		// An encoded piece is already notated: one whole-file task, no pre-tasks.
		{ id: 'T0003', fragment: 'sources/piece-02/score.mei', locator: '', dependsOn: '' },
		{ id: 'P0003', fragment: 'sources/piece-03/score.mei', locator: 'score-setup', dependsOn: '' },
		{ id: 'P0004', fragment: 'sources/piece-03/score.mei', locator: 'measure-zones', dependsOn: 'P0003' },
		{ id: 'T0004', fragment: 'sources/piece-03/score.mei', locator: 'surface-2', dependsOn: 'P0004' },
		{ id: 'T0005', fragment: 'sources/piece-03/score.mei', locator: 'surface-3', dependsOn: 'P0004' }
	]);
});

test('pre-task ids stay unique across mixed facsimile and physical pieces', () => {
	const config = build({
		pieces: [facsimile('piece-01', [1]), physical('piece-02', 1), facsimile('piece-03', [1])]
	});
	const planned = planTasks(config);
	const ids = planned.map((task) => task.id);
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(
		planned.filter((task) => task.locator === 'score-setup').map((task) => task.id),
		['P0001', 'P0003', 'P0004']
	);
});

test('a physical piece with a page count: a setup pre-task, then one task per page', () => {
	const config = build({ pieces: [physical('piece-01', 3)] });
	assert.deepEqual(planTasks(config), [
		{ id: 'P0001', fragment: 'sources/piece-01/score.mei', locator: 'score-setup', dependsOn: '' },
		{ id: 'T0001', fragment: 'sources/piece-01/score.mei', locator: 'surface-1', dependsOn: 'P0001' },
		{ id: 'T0002', fragment: 'sources/piece-01/score.mei', locator: 'surface-2', dependsOn: 'P0001' },
		{ id: 'T0003', fragment: 'sources/piece-01/score.mei', locator: 'surface-3', dependsOn: 'P0001' }
	]);
});

test('a physical piece without a page count: a setup pre-task, then one whole-file task', () => {
	const config = build({ pieces: [physical('piece-01')] });
	assert.deepEqual(planTasks(config), [
		{ id: 'P0001', fragment: 'sources/piece-01/score.mei', locator: 'score-setup', dependsOn: '' },
		{ id: 'T0001', fragment: 'sources/piece-01/score.mei', locator: '', dependsOn: 'P0001' }
	]);
	assert.equal(assertSupported(config), undefined);
});

test('configToYaml: a physical piece records its page count', () => {
	const yaml = configToYaml(build({ pieces: [physical('piece-01', 4)] }));
	assert.ok(yaml.includes('    kind: "physical-only"\n'));
	assert.ok(yaml.includes('    pages: 4\n'));
	// Without a count, no pages line is written.
	assert.ok(!configToYaml(build({ pieces: [physical('piece-02')] })).includes('pages:'));
});

test('two pieces may share a page without sharing a task', () => {
	const config = build({ pieces: [facsimile('piece-01', [2]), facsimile('piece-02', [2])] });
	const planned = planTasks(config);
	const onPageTwo = planned.filter((task) => task.locator === 'surface-2');
	assert.equal(onPageTwo.length, 2);
	assert.deepEqual(
		onPageTwo.map((task) => task.fragment),
		['sources/piece-01/score.mei', 'sources/piece-02/score.mei']
	);
});

test('the state table mirrors the task table row for row', () => {
	const config = build({
		pieces: [facsimile('piece-01', [1, 2]), encoded('piece-02'), facsimile('piece-03', [3])]
	});
	const ids = (csv: string) =>
		csv
			.trim()
			.split('\n')
			.slice(1)
			.map((line) => line.split(',').slice(0, 2).join(','));
	assert.deepEqual(ids(buildStateCsv(config)), ids(buildTaskCsv(config)));
});

test('lock.csv and history.csv are header-only', () => {
	assert.equal(buildLockCsv(), 'task_id,subtask_id,user_id,timestamp,kind\n');
	assert.equal(
		buildHistoryCsv(),
		'timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,version,input\n'
	);
});

test('buildStateCsv: required_validations controls the validate_status columns', () => {
	const config = build({ required_validations: 3, pieces: [encoded('piece-01')] });
	assert.equal(
		buildStateCsv(config),
		'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2,validate_status_3\n' +
			'T0001,,encoding_required,,,,,\n' +
			'T0001,S0001,pending,,,,,\n'
	);
});

test('configToYaml: YAML-sensitive characters are escaped', () => {
	const config = build({
		title: 'A "quoted" \\ title\nsecond line',
		pieces: [encoded('piece-01')]
	});
	assert.ok(configToYaml(config).includes('  title: "A \\"quoted\\" \\\\ title\\nsecond line"\n'));
});

test('configToYaml: an unsupported config is rejected rather than serialised', () => {
	assert.throws(() => configToYaml(build({ pieces: [] })), /at least one piece/);
});

test('assertSupported: rejects unsupported schema, strategy and piece shapes', () => {
	const unsupportedSchema = build({ pieces: [encoded('piece-01')] });
	unsupportedSchema.schema_version = 2;
	assert.throws(() => assertSupported(unsupportedSchema), /schema_version/);

	const unsupportedStrategy = build({ pieces: [encoded('piece-01')] });
	unsupportedStrategy.fragmentation.strategy = 'whole';
	assert.throws(() => assertSupported(unsupportedStrategy), /fragmentation\.strategy/);

	assert.throws(() => assertSupported(build({ pieces: [] })), /at least one piece/);

	const unsupportedKind = build({ pieces: [encoded('piece-01')] });
	unsupportedKind.pieces[0].kind = 'musicxml';
	assert.throws(() => assertSupported(unsupportedKind), /piece kind/);

	// A shared path would make a submission ambiguous: the coordinator resolves
	// a task by its fragment path alone.
	const clashing = build({ pieces: [encoded('piece-01'), encoded('piece-02')] });
	clashing.pieces[1].path = clashing.pieces[0].path;
	assert.throws(() => assertSupported(clashing), /distinct path/);
});
