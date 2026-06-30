import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLValidator } from 'fast-xml-parser';

import {
	buildCampaignConfig,
	configToYaml,
	stampTemplate,
	buildStateCsv,
	buildLocksCsv,
	assertSupported
} from './campaign-init.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// instigation/src/lib/server -> up 4 -> lets-encode/ -> the template repo.
const TEMPLATE_MEI = join(HERE, '../../../../user-repo-template/templates/score.template.mei');

// The create-form fields for the worked example (one-note test case; DESIGN.md §6).
const WORKED_EXAMPLE_FIELDS = {
	title: 'Test Campaign — One Note',
	description: 'Smallest possible campaign for end-to-end testing.',
	language: 'en',
	license: 'CC-BY-4.0',
	composer: 'Anonymous'
};

test('buildCampaignConfig: instigator comes from login; defaults fill the rest', () => {
	const config = buildCampaignConfig({ title: 'T' }, 'weigl');
	assert.equal(config.campaign.instigator, 'weigl');
	assert.equal(config.campaign.license, 'CC-BY-4.0');
	assert.equal(config.validation.required_validations, 1);
	assert.equal(config.locking.stale_after_minutes, 120);
	assert.doesNotThrow(() => assertSupported(config));
});

test('configToYaml: matches the worked example', () => {
	const config = buildCampaignConfig(WORKED_EXAMPLE_FIELDS, 'weigl');
	assert.equal(
		configToYaml(config),
		'schema_version: 1\n' +
			'campaign:\n' +
			'  title: "Test Campaign — One Note"\n' +
			'  description: "Smallest possible campaign for end-to-end testing."\n' +
			'  instigator: "weigl"\n' +
			'  language: "en"\n' +
			'  license: "CC-BY-4.0"\n' +
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
	const config = buildCampaignConfig(WORKED_EXAMPLE_FIELDS, 'weigl');
	const mei = stampTemplate(readFileSync(TEMPLATE_MEI, 'utf8'), {
		title: config.campaign.title,
		composer: config.sources[0].header.composer,
		license: config.campaign.license
	});

	assert.equal(XMLValidator.validate(mei), true, 'sources/score.mei must be well-formed XML');
	for (const ph of ['{{TITLE}}', '{{COMPOSER}}', '{{LICENSE}}']) {
		assert.equal(mei.includes(ph), false, `placeholder ${ph} should be filled`);
	}
	assert.match(mei, /<title>Test Campaign — One Note<\/title>/);
	assert.match(mei, /role="composer">Anonymous</);
	assert.match(mei, /<useRestrict>CC-BY-4\.0<\/useRestrict>/);
});

test('worked example: state.csv matches the expected row exactly', () => {
	const config = buildCampaignConfig(WORKED_EXAMPLE_FIELDS, 'weigl');
	assert.equal(
		buildStateCsv(config),
		'task_id,fragment,state,encoder,encoded_at,v1\n' +
			'T0001,sources/score.mei,encoding_required,,,\n'
	);
});

test('worked example: locks.csv is header-only', () => {
	assert.equal(buildLocksCsv(), 'task_id,locked_by,locked_at,kind\n');
});

test('buildStateCsv: required_validations controls the vN columns', () => {
	const config = buildCampaignConfig({ required_validations: 3 }, 'weigl');
	assert.equal(
		buildStateCsv(config),
		'task_id,fragment,state,encoder,encoded_at,v1,v2,v3\n' +
			'T0001,sources/score.mei,encoding_required,,,,,\n'
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

test('configToYaml: quotes are escaped so the YAML stays valid', () => {
	const config = buildCampaignConfig({ title: 'A "quoted" title' }, 'weigl');
	assert.match(configToYaml(config), /title: "A \\"quoted\\" title"/);
});

test('assertSupported: rejects an unsupported fragmentation strategy', () => {
	const config = buildCampaignConfig({}, 'weigl');
	config.fragmentation.strategy = 'by_measure';
	assert.throws(() => assertSupported(config), /fragmentation\.strategy/);
});
