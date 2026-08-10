import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildSourceHead,
	emptySourceMetadata,
	parseSourceHead,
	type SourceMetadata
} from '../source-metadata.ts';

function filled(): SourceMetadata {
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

test('round-trips every field it models', () => {
	const meta = filled();
	assert.deepEqual(parseSourceHead(buildSourceHead(meta)), meta);
});

test('escapes markup-significant characters in values', () => {
	const meta = { ...emptySourceMetadata(), title: 'Sonata <b> & "Co"' };
	const xml = buildSourceHead(meta);
	assert.ok(xml.includes('<title>Sonata &lt;b&gt; &amp; &quot;Co&quot;</title>'));
	assert.equal(parseSourceHead(xml).title, 'Sonata <b> & "Co"');
});

test('leaves unknown fields out rather than emitting empty elements', () => {
	const xml = buildSourceHead({ ...emptySourceMetadata(), title: 'Untitled' });
	assert.ok(!xml.includes('<publisher>'));
	assert.ok(!xml.includes('<sourceDesc>'));
	assert.ok(!xml.includes('<respStmt>'));
	// pubStmt is required by MEI, so it stays even when empty.
	assert.ok(xml.includes('<pubStmt>'));
});

test('keeps the composer and editor distinct from other contributors', () => {
	const xml = buildSourceHead(filled());
	assert.ok(xml.includes('<persName role="composer">L. van Beethoven</persName>'));
	assert.ok(xml.includes('<persName role="editor">A. Editor</persName>'));
	assert.ok(xml.includes('<persName role="lyricist">J. W. von Goethe</persName>'));
	const parsed = parseSourceHead(xml);
	assert.equal(parsed.composer, 'L. van Beethoven');
	assert.equal(parsed.editor, 'A. Editor');
	assert.equal(parsed.lyricist, 'J. W. von Goethe');
	assert.deepEqual(
		parsed.contributors.map((c) => c.role),
		['engraver']
	);
});

test("the edition's year is a date within the edition", () => {
	const xml = buildSourceHead(filled());
	assert.ok(xml.includes('<edition>2nd revised edition <date>1854</date></edition>'));
	const parsed = parseSourceHead(xml);
	assert.equal(parsed.edition, '2nd revised edition');
	assert.equal(parsed.editionDate, '1854');

	// A year with no edition text still has a home.
	const dateOnly = buildSourceHead({ ...emptySourceMetadata(), editionDate: '1854' });
	assert.ok(dateOnly.includes('<edition><date>1854</date></edition>'));
	assert.equal(parseSourceHead(dateOnly).editionDate, '1854');
});

test('drops contributors with no name', () => {
	const meta = {
		...emptySourceMetadata(),
		contributors: [
			{ name: '  ', role: 'engraver' },
			{ name: 'Real Person', role: 'engraver' }
		]
	};
	assert.deepEqual(parseSourceHead(buildSourceHead(meta)).contributors, [
		{ name: 'Real Person', role: 'engraver' }
	]);
});

test('preserves head markup the form does not model, across a round trip', () => {
	const hand = `<meiHead>
   <fileDesc>
      <titleStmt><title>Hand written</title></titleStmt>
      <pubStmt></pubStmt>
   </fileDesc>
   <workList>
      <work><title>The work behind the source</title></work>
   </workList>
</meiHead>`;
	const parsed = parseSourceHead(hand);
	assert.equal(parsed.title, 'Hand written');
	assert.ok(parsed.extraHeadXml.includes('<workList>'));

	// The preserved block survives a rebuild, and a second parse is stable.
	const rebuilt = buildSourceHead(parsed);
	assert.ok(rebuilt.includes('<work><title>The work behind the source</title></work>'));
	assert.deepEqual(parseSourceHead(rebuilt), parsed);
});

test('returns empty metadata for text with no header', () => {
	assert.deepEqual(parseSourceHead('<mei><music/></mei>'), emptySourceMetadata());
});

test('describes the source in the manifestation, not the file', () => {
	const xml = buildSourceHead(filled());
	const manifestation = /<manifestation\b[\s\S]*<\/manifestation>/.exec(xml)?.[0] ?? '';
	assert.match(manifestation, /<pubStmt>[\s\S]*<publisher>Breitkopf &amp; Härtel<\/publisher>/);
	assert.match(manifestation, /<editionStmt>\s*<edition>2nd revised edition <date>1854<\/date><\/edition>/);
	assert.match(
		manifestation,
		/<physLoc>\s*<repository>Austrian National Library<\/repository>\s*<identifier>Mus\.Hs\.16481<\/identifier>/
	);
	// The file's own pubStmt stays, but says nothing about the source.
	const fileDesc = /<fileDesc\b[\s\S]*<\/fileDesc>/.exec(xml)?.[0] ?? '';
	assert.ok(!fileDesc.includes('<publisher>'));
});

test('a shelfmark without a repository becomes the manifestation identifier', () => {
	const meta = { ...emptySourceMetadata(), shelfmark: 'Mus.Hs.16481' };
	const xml = buildSourceHead(meta);
	assert.ok(!xml.includes('<physLoc>'));
	assert.match(xml, /<manifestation[^>]*>\s*<identifier>Mus\.Hs\.16481<\/identifier>/);
	assert.equal(parseSourceHead(xml).shelfmark, 'Mus.Hs.16481');
});

test('reads publication details from a header that carries them in fileDesc', () => {
	const old = `<meiHead>
   <fileDesc>
      <titleStmt><title>Older header</title></titleStmt>
      <pubStmt><publisher>Peters</publisher><date>1890</date></pubStmt>
   </fileDesc>
</meiHead>`;
	const parsed = parseSourceHead(old);
	assert.equal(parsed.publisher, 'Peters');
	assert.equal(parsed.date, '1890');
});

test('trims surrounding whitespace from typed values', () => {
	const xml = buildSourceHead({ ...emptySourceMetadata(), title: '  Padded  ' });
	assert.ok(xml.includes('<title>Padded</title>'));
});
