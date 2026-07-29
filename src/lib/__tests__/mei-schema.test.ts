// Holds the MEI this app generates to the standard the campaign coordinator
// applies to a submission: valid against the pinned MEI schema, checked with
// the same code (scripts/mei-validate.ts). The other MEI tests assert on the
// strings emitted; these assert that the strings are MEI.
//
// The check needs the schema (fetched) and xmllint (installed), so these tests
// skip rather than fail when either is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacsimileMei, initialFacsimileModel } from '../mei-facsimile.ts';
import type { FacsimilePage } from '../mei-facsimile.ts';
import { buildPieceHead, buildSourceHead, emptySourceMetadata } from '../source-metadata.ts';
import type { SourceMetadata } from '../source-metadata.ts';
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
		contributors: [{ name: 'A. Editor', role: 'editor' }],
		pubPlace: 'Leipzig',
		extent: '48 pages',
		condition: 'Foxing on the title page',
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
