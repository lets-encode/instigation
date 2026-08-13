import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntaxValidator } from 'fast-xml-validator';
import { buildPieceHead, emptySourceMetadata, type SourceMetadata } from '../source-metadata.ts';
import { buildFacsimileMei, replaceMeiHead } from '../mei-facsimile.ts';
import { parseMeiHeader } from '../mei-header.ts';

function source(): SourceMetadata {
	return {
		...emptySourceMetadata(),
		title: 'Drei Sonaten',
		composer: 'L. van Beethoven',
		contributors: [{ name: 'A. Editor', role: 'editor' }],
		publisher: 'Breitkopf & Härtel',
		pubPlace: 'Leipzig',
		date: '1802',
		extent: '48 pages',
		condition: 'Foxing on the title page',
		note: 'Bound with two other sonatas.'
	};
}

test('a piece header carries the piece title and the whole source beneath it', () => {
	const head = buildPieceHead({ title: 'Sonata I', composer: '', license: 'CC-BY-4.0' }, source());
	assert.equal(SyntaxValidator.validate(`<mei>${head}</mei>`), true);

	// The piece names itself...
	assert.match(head, /<titleStmt[^>]*>\s*<title[^>]*>Sonata I<\/title>/);
	// ...and the source it was read from is copied in, not referenced.
	assert.match(head, /<sourceDesc[^>]*>[\s\S]*<title[^>]*>Drei Sonaten<\/title>/);
	assert.match(head, /<publisher[^>]*>Breitkopf &amp; Härtel<\/publisher>/);
	assert.match(head, /<extent[^>]*>48 pages<\/extent>/);
	assert.match(head, /<annot[^>]*>Bound with two other sonatas\.<\/annot>/);
	assert.match(head, /<useRestrict[^>]*>CC-BY-4\.0<\/useRestrict>/);
});

test("a piece's own people and note reach its file description", () => {
	const head = buildPieceHead(
		{
			title: 'Sonata I',
			composer: 'L. van Beethoven',
			editor: 'C. Czerny',
			lyricist: 'J. W. von Goethe',
			contributors: [{ name: 'B. Engraver', role: 'engraver' }],
			note: 'First movement only.'
		},
		emptySourceMetadata()
	);
	assert.equal(SyntaxValidator.validate(`<mei>${head}</mei>`), true);
	const fileDesc = /<fileDesc\b[\s\S]*<\/fileDesc>/.exec(head)?.[0] ?? '';
	assert.match(fileDesc, /<persName[^>]*role="editor"[^>]*>C\. Czerny<\/persName>/);
	assert.match(fileDesc, /<persName[^>]*role="lyricist"[^>]*>J\. W\. von Goethe<\/persName>/);
	assert.match(fileDesc, /<persName[^>]*role="engraver"[^>]*>B\. Engraver<\/persName>/);
	assert.match(fileDesc, /<notesStmt[^>]*>\s*<annot[^>]*>First movement only\.<\/annot>\s*<\/notesStmt>/);
});

test("a piece with no composer of its own inherits the source's", () => {
	const head = buildPieceHead({ title: 'Sonata I', composer: '' }, source());
	assert.equal(parseMeiHeader(`<mei>${head}</mei>`)?.composer, 'L. van Beethoven');
});

test('a piece composer overrides the source composer', () => {
	const head = buildPieceHead({ title: 'Sonata I', composer: 'C. P. E. Bach' }, source());
	assert.equal(parseMeiHeader(`<mei>${head}</mei>`)?.composer, 'C. P. E. Bach');
});

test('a piece header stays well-formed when nothing is known', () => {
	const head = buildPieceHead({ title: '', composer: '' }, emptySourceMetadata());
	assert.equal(SyntaxValidator.validate(`<mei>${head}</mei>`), true);
});

test('the piece header drops into a facsimile scaffold', () => {
	const head = buildPieceHead({ title: 'Sonata I', composer: '' }, source());
	const mei = buildFacsimileMei({
		headXml: head,
		pages: [
			{
				image: 'img/01.jpg',
				width: 800,
				height: 1200,
				zones: [
					{ box: { ulx: 10, uly: 20, lrx: 110, lry: 220 }, label: '1', pb: true, sb: false, mdiv: false }
				]
			}
		]
	});
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.match(mei, /<title[^>]*>Sonata I<\/title>/);
	assert.match(mei, /<zone [^>]*type="measure"/);
});

test('replaceMeiHead swaps a converted encoding’s header for the piece’s', () => {
	const converted = '<mei><meiHead><fileDesc><titleStmt><title>From Verovio</title></titleStmt></fileDesc></meiHead><music/></mei>';
	const head = buildPieceHead({ title: 'Prelude', composer: 'J. S. Bach' }, emptySourceMetadata());
	const out = replaceMeiHead(converted, head);
	assert.equal(SyntaxValidator.validate(out), true);
	assert.ok(!out.includes('From Verovio'), 'the converter’s header must be gone');
	assert.equal(parseMeiHeader(out)?.title, 'Prelude');
	assert.ok(out.includes('<music/>'), 'the notation must survive untouched');
});

test('replaceMeiHead inserts a header when the document has none', () => {
	const out = replaceMeiHead('<mei><music/></mei>', buildPieceHead({ title: 'P', composer: '' }, emptySourceMetadata()));
	assert.equal(SyntaxValidator.validate(out), true);
	assert.equal(parseMeiHeader(out)?.title, 'P');
});

test('replaceMeiHead handles a self-closing header', () => {
	const out = replaceMeiHead('<mei><meiHead/><music/></mei>', buildPieceHead({ title: 'P', composer: '' }, emptySourceMetadata()));
	assert.equal(SyntaxValidator.validate(out), true);
	assert.equal(parseMeiHeader(out)?.title, 'P');
	assert.equal((out.match(/<meiHead/g) ?? []).length, 1, 'exactly one header');
});
