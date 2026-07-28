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
		contributors: [
			{ name: 'A. Editor', role: 'editor' },
			{ name: 'B. Engraver', role: 'engraver' }
		],
		pubPlace: 'Leipzig',
		extent: '48 pages',
		condition: 'Foxing on the title page',
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

test('keeps the composer distinct from other contributors', () => {
	const xml = buildSourceHead(filled());
	assert.ok(xml.includes('<persName role="composer">L. van Beethoven</persName>'));
	const parsed = parseSourceHead(xml);
	assert.equal(parsed.composer, 'L. van Beethoven');
	assert.deepEqual(
		parsed.contributors.map((c) => c.role),
		['editor', 'engraver']
	);
});

test('drops contributors with no name', () => {
	const meta = {
		...emptySourceMetadata(),
		contributors: [
			{ name: '  ', role: 'editor' },
			{ name: 'Real Person', role: 'editor' }
		]
	};
	assert.deepEqual(parseSourceHead(buildSourceHead(meta)).contributors, [
		{ name: 'Real Person', role: 'editor' }
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

test('trims surrounding whitespace from typed values', () => {
	const xml = buildSourceHead({ ...emptySourceMetadata(), title: '  Padded  ' });
	assert.ok(xml.includes('<title>Padded</title>'));
});
