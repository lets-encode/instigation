import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addXmlIds } from '../mei-ids.ts';
import { buildBlankScoreMei, buildFacsimileMei, buildMeiHead, initialFacsimileModel } from '../mei-facsimile.ts';
import { buildPieceHead, buildSourceHead, emptySourceMetadata } from '../source-metadata.ts';

// Every start tag in `xml`, full tag text.
const startTags = (xml: string) =>
	[...xml.matchAll(/<[A-Za-z_][\w.-]*(?:"[^"]*"|'[^']*'|[^>"'])*?\/?>/g)].map((m) => m[0]);

test('addXmlIds gives every element a deterministic tag-numbered id', () => {
	const out = addXmlIds('<a><b/><b><c/></b></a>');
	assert.equal(
		out,
		'<a xml:id="a-1"><b xml:id="b-1"/><b xml:id="b-2"><c xml:id="c-1"/></b></a>'
	);
	// Running it again changes nothing.
	assert.equal(addXmlIds(out), out);
});

test('addXmlIds keeps existing ids and skips their values when numbering', () => {
	const out = addXmlIds('<a><b xml:id="b-2"/><b/></a>');
	assert.ok(out.includes('<b xml:id="b-2"/>'));
	// The unnamed <b> takes b-1; b-2 is taken.
	assert.ok(out.includes('<b xml:id="b-1"/>'));
});

test('addXmlIds leaves comments, processing instructions and closing tags alone', () => {
	const xml = '<?xml version="1.0"?><!-- <fake/> --><a>text</a>';
	const out = addXmlIds(xml);
	assert.ok(out.includes('<?xml version="1.0"?>'));
	assert.ok(out.includes('<!-- <fake/> -->'));
	assert.ok(out.includes('</a>'));
	assert.match(out, /<a xml:id="a-1">/);
});

test('every element of a generated score carries an xml:id', () => {
	const pages = [
		{
			image: 'img/01.jpg',
			width: 800,
			height: 1200,
			measures: [
				{ ulx: 10, uly: 20, lrx: 110, lry: 220 },
				{ ulx: 120, uly: 20, lrx: 220, lry: 220 }
			]
		}
	];
	const head = buildPieceHead(
		{ title: 'Sonata I', composer: 'L. van Beethoven', license: 'CC BY 4.0' },
		{ ...emptySourceMetadata(), title: 'Drei Sonaten', publisher: 'Breitkopf & Härtel' }
	);
	const scores = [
		buildFacsimileMei({ ...initialFacsimileModel(pages), headXml: head }),
		buildFacsimileMei({ ...initialFacsimileModel(pages), headXml: head }, { withBreaks: true }),
		buildBlankScoreMei(head, 2),
		buildBlankScoreMei(buildMeiHead({ title: 'T' })),
		buildSourceHead(emptySourceMetadata())
	];
	for (const score of scores) {
		for (const tag of startTags(score)) {
			assert.match(tag, /\bxml:id="[^"]+"/, `element lacks an xml:id: ${tag}`);
		}
	}
});
