// Holds the MEI this app generates to the standard the campaign coordinator
// applies to a submission: valid against the pinned MEI schema, checked with
// the same code (scripts/mei-validate.ts). The other MEI tests assert on the
// strings emitted; these assert that the strings are MEI.
//
// The check needs the schema (downloaded) and xmllint (installed), so these
// tests skip rather than fail when either is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlankScoreMei, buildFacsimileMei, initialFacsimileModel } from '../mei-facsimile.ts';
import type { FacsimilePage, ScoreDefModel } from '../mei-facsimile.ts';
import { buildPieceHead, buildSourceHead, emptySourceMetadata } from '../source-metadata.ts';
import type { SourceMetadata } from '../source-metadata.ts';
import { recordContribution } from '../mei-provenance.ts';
import { meiSchemaPath, validateMei } from '../../../scripts/mei-validate.ts';

// `skip` counts as a skip whenever it is present, so an available checker has to
// pass `false` rather than an empty reason.
let skip: string | false = false;
try {
	await meiSchemaPath();
} catch (e) {
	skip = `MEI machine-check unavailable: ${(e as Error).message}`;
}

const PAGES: FacsimilePage[] = [
	{
		image: 'img/01.jpg',
		width: 2000,
		height: 2800,
		measures: [
			{ ulx: 100, uly: 300, lrx: 400, lry: 600 },
			{ ulx: 400, uly: 300, lrx: 700, lry: 600 },
			{ ulx: 100, uly: 700, lrx: 500, lry: 1000 }
		]
	},
	{
		image: 'img/02.jpg',
		width: 2000,
		height: 2800,
		measures: [{ ulx: 100, uly: 300, lrx: 400, lry: 600 }]
	}
];

function source(): SourceMetadata {
	return {
		title: 'Sonate für Klavier',
		publisher: 'Breitkopf & Härtel',
		date: '1802',
		composer: 'L. van Beethoven',
		editor: 'A. Editor',
		lyricist: 'J. W. von Goethe',
		contributors: [{ name: 'B. Engraver', role: 'engraver' }],
		pubPlace: 'Leipzig',
		edition: '2nd revised edition',
		editionDate: '1854',
		extent: '48 pages',
		condition: 'Foxing on the title page',
		repository: 'Austrian National Library',
		shelfmark: 'Mus.Hs.16481',
		note: 'Bound with two other sonatas.',
		extraHeadXml: ''
	};
}

// Both stages of a score carrying the given header, as the campaign commits
// them: stage A at initialisation, stage C on the correction submission.
async function checkBothStages(headXml: string, label: string): Promise<void> {
	const model = { ...initialFacsimileModel(PAGES), headXml };
	for (const withBreaks of [false, true]) {
		const check = await validateMei(buildFacsimileMei(model, { withBreaks }));
		assert.ok(check.ok, `${label} at stage ${withBreaks ? 'C' : 'A'}: ${check.error}`);
	}
}

test('a piece score validates, with the source described in full', { skip }, async () => {
	const head = buildPieceHead(
		{ title: 'Sonata No. 1', composer: 'L. van Beethoven', license: 'CC BY 4.0' },
		source()
	);
	await checkBothStages(head, 'piece head');
});

test('a piece score validates when nothing about the source is known', { skip }, async () => {
	const head = buildPieceHead({ title: '', composer: '' }, emptySourceMetadata());
	await checkBothStages(head, 'empty piece head');
});

test('a score carrying the source header validates', { skip }, async () => {
	await checkBothStages(buildSourceHead(source()), 'source head');
	await checkBothStages(buildSourceHead(emptySourceMetadata()), 'empty source head');
});

test('a piece score validates with its creation recorded', { skip }, async () => {
	const head = buildPieceHead(
		{
			title: 'Sonata No. 1',
			composer: 'L. van Beethoven',
			editor: 'C. Czerny',
			lyricist: 'J. W. von Goethe',
			contributors: [{ name: 'B. Engraver', role: 'engraver' }],
			note: 'First movement only.',
			license: 'CC BY 4.0'
		},
		source(),
		{ creator: 'octocat', date: '2026-08-10' }
	);
	await checkBothStages(head, 'piece head with origin');
});

test('a score still validates after a contribution is recorded', { skip }, async () => {
	const contribution = {
		name: 'octocat',
		message: 'Encode page 3.',
		isodate: '2026-08-10',
		application: 'mei-friend'
	};
	// A piece score's header (appInfo and revisionDesc present)…
	const pieceHead = buildPieceHead(
		{ title: 'Sonata No. 1', composer: 'L. van Beethoven' },
		source(),
		{ creator: 'owner', date: '2026-08-09' }
	);
	const model = { ...initialFacsimileModel(PAGES), headXml: pieceHead };
	const recorded = recordContribution(buildFacsimileMei(model), contribution);
	const check = await validateMei(recorded);
	assert.ok(check.ok, `piece score with contribution: ${check.error}`);
	// …and one whose header has neither, so both blocks are created.
	const bareModel = { ...initialFacsimileModel(PAGES), headXml: buildSourceHead(source()) };
	const bare = recordContribution(buildFacsimileMei(bareModel), contribution);
	const bareCheck = await validateMei(bare);
	assert.ok(bareCheck.ok, `bare score with contribution: ${bareCheck.error}`);
});

test('preserved markup keeps the header valid, wherever it belongs', { skip }, async () => {
	// <manifestationList> has a fixed position among <meiHead>'s children, so a
	// preserved sibling on either side of it must end up on the right side.
	const head = buildSourceHead({
		...source(),
		extraHeadXml:
			'<workList>\n      <work><title>The work behind the source</title></work>\n   </workList>\n' +
			'   <revisionDesc><change n="1"><changeDesc><p>Created.</p></changeDesc></change></revisionDesc>'
	});
	await checkBothStages(head, 'source head with preserved markup');
});

test('a score rebuilt around a submitted score definition validates', { skip }, async () => {
	// Both builders, as the score-setup submission rebuilds them: multiple
	// staves with labels and clefs, a key signature and a meter.
	const plain = { clefDis: '', clefDisPlace: '', lines: 5, notationType: '' };
	const scoreDef: ScoreDefModel = {
		staves: [
			{ clefShape: 'G', clefLine: 2, ...plain, label: 'Violino' },
			{ clefShape: 'C', clefLine: 3, ...plain, label: 'Viola' },
			{ clefShape: 'F', clefLine: 4, ...plain, label: 'Violoncello & Basso' }
		],
		groups: [],
		keysig: '3f',
		meterCount: '3',
		meterUnit: '8',
		meterSym: ''
	};
	const head = buildPieceHead(
		{ title: 'Sonata No. 1', composer: 'L. van Beethoven', license: 'CC BY 4.0' },
		source()
	);
	const model = { ...initialFacsimileModel(PAGES), headXml: head, scoreDef };
	for (const withBreaks of [false, true]) {
		const check = await validateMei(buildFacsimileMei(model, { withBreaks }));
		assert.ok(check.ok, `set-up facsimile score at stage ${withBreaks ? 'C' : 'A'}: ${check.error}`);
	}
	for (const pages of [0, 2]) {
		const check = await validateMei(buildBlankScoreMei(head, pages, scoreDef));
		assert.ok(check.ok, `set-up blank score with ${pages} pages: ${check.error}`);
	}
	// A symbol signature validates too.
	const cut = { ...scoreDef, meterCount: '2', meterUnit: '2', meterSym: 'cut' };
	const check = await validateMei(buildBlankScoreMei(head, 0, cut));
	assert.ok(check.ok, `set-up blank score with cut time: ${check.error}`);
	// Grouped, displaced, percussion and tablature staves validate.
	const rich: ScoreDefModel = {
		...scoreDef,
		staves: [
			{ ...plain, clefShape: 'G', clefLine: 2, label: 'Piano' },
			{ ...plain, clefShape: 'F', clefLine: 4, label: '' },
			{ ...plain, clefShape: 'G', clefLine: 2, clefDis: '8', clefDisPlace: 'below', label: 'Tenore' },
			{ ...plain, clefShape: 'perc', clefLine: 3, lines: 1, label: 'Drums' },
			{ ...plain, clefShape: 'TAB', clefLine: 3, lines: 6, notationType: 'tab.guitar', label: 'Guitar' },
			{ ...plain, clefShape: 'TAB', clefLine: 3, lines: 6, notationType: 'tab.lute.french', label: '' }
		],
		groups: [
			{ start: 1, end: 2, symbol: 'brace', label: 'Piano' },
			{ start: 4, end: 6, symbol: 'bracket', label: '' }
		]
	};
	const richCheck = await validateMei(buildBlankScoreMei(head, 0, rich));
	assert.ok(richCheck.ok, `set-up blank score with groups and unpitched staves: ${richCheck.error}`);
});

test('a document carrying a DOCTYPE declaration is rejected outright', async () => {
	// The rejection happens before the schema check, so it needs neither the
	// downloaded schema nor xmllint — no skip.
	const check = await validateMei('<?xml version="1.0"?>\n<!DOCTYPE mei [<!ENTITY x "y">]>\n<mei/>');
	assert.equal(check.ok, false);
	assert.match(check.error, /DOCTYPE/);
});
