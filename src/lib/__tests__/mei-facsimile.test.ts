import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntaxValidator } from 'fast-xml-validator';
import {
	buildBlankScoreMei,
	buildFacsimileMei,
	buildMeiHead,
	initialFacsimileModel,
	parseFacsimileMei,
	relinkFacsimileImages,
	sortReadingOrder,
	nextLabel,
	type FacsimilePage,
	type FacsimileModel
} from '../mei-facsimile.ts';

const twoPages: FacsimilePage[] = [
	{
		image: 'img/01.jpg',
		width: 2000,
		height: 2581,
		measures: [
			{ ulx: 127, uly: 259, lrx: 1036, lry: 804 },
			{ ulx: 142, uly: 767, lrx: 1016, lry: 1334 }
		]
	},
	{
		image: 'img/02.jpg',
		width: 2000,
		height: 2581,
		measures: [{ ulx: 238, uly: 244, lrx: 1005, lry: 790 }]
	}
];

const model = () => initialFacsimileModel(twoPages, { title: 'T', composer: 'C', license: 'L' });

test('stage A: surfaces, graphics and labelled zones — no measures, no breaks', () => {
	const mei = buildFacsimileMei(model());
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.equal((mei.match(/<surface /g) ?? []).length, 2);
	assert.equal((mei.match(/<graphic /g) ?? []).length, 2);
	assert.equal((mei.match(/<zone /g) ?? []).length, 3);
	assert.equal((mei.match(/<measure /g) ?? []).length, 0);
	assert.equal((mei.match(/<pb /g) ?? []).length, 0);
	assert.ok(mei.includes('target="img/01.jpg"'));
	// Zones carry their measure labels, numbered continuously across pages.
	assert.ok(mei.includes('<zone xml:id="zone-1-1" type="measure" n="1"'));
	assert.ok(mei.includes('<zone xml:id="zone-2-1" type="measure" n="3"'));
});

test('stage C: a pb per page, an sb per flagged measure (except page starts)', () => {
	const m = model();
	// Page 1's two boxes are two systems (stacked), so its second measure is a
	// system start — expect one <sb/> for it; page firsts are covered by <pb/>.
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.equal((mei.match(/<pb /g) ?? []).length, 2);
	assert.equal((mei.match(/<sb /g) ?? []).length, 1);
	assert.equal((mei.match(/<measure /g) ?? []).length, 3);
	assert.ok(/<pb[^>]*facs="#surface-1"/.test(mei));
});

test('volta labels: alphanumeric labels are emitted and nextLabel advances their leading number', () => {
	const m = model();
	m.pages[0].zones[1].label = '1a';
	// Automatic numbering derives the next label from the previous one.
	assert.equal(nextLabel('1a'), '2');
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.ok(mei.includes('n="1a" facs="#zone-1-2"'));
});

test('parseFacsimileMei rejects input without an MEI header', () => {
	assert.throws(() => parseFacsimileMei('<mei><music/></mei>'), /no <meiHead>/);
});

test('parseFacsimileMei round-trips the model through both active stages', () => {
	const m = model();
	m.pages[0].zones[1].label = '1a';

	const stageA = parseFacsimileMei(buildFacsimileMei(m));
	assert.equal(stageA.hasMeasures, false);
	assert.equal(stageA.pages.length, 2);
	assert.deepEqual(
		stageA.pages[0].zones.map((z) => z.label),
		['1', '1a']
	);
	assert.deepEqual(stageA.pages[0].zones[0].box, { ulx: 127, uly: 259, lrx: 1036, lry: 804 });

	const stageC = parseFacsimileMei(buildFacsimileMei(m, { withBreaks: true }));
	assert.equal(stageC.hasMeasures, true);
	assert.equal(stageC.hasBreaks, true);
	// The system flags survive: page 1's second measure starts a system.
	assert.equal(stageC.pages[0].zones[1].sb, true);

	// Rebuilding from the parsed model reproduces the file byte-for-byte.
	const rebuilt = buildFacsimileMei(
		{ headXml: stageC.headXml, pages: stageC.pages } satisfies FacsimileModel,
		{ withBreaks: true }
	);
	assert.equal(rebuilt, buildFacsimileMei(m, { withBreaks: true }));
});

test('movements: a flagged zone opens a new <mdiv>; flags round-trip', () => {
	const m = model();
	// Page 2's measure starts a new movement.
	m.pages[1].zones[0].mdiv = true;
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal((mei.match(/<mdiv /g) ?? []).length, 2);
	assert.equal((mei.match(/<scoreDef\b/g) ?? []).length, 2);
	// The second movement holds page 2's break and measure.
	const second = mei.slice(mei.indexOf('<mdiv xml:id="mdiv-2"'));
	assert.ok(/<pb[^>]*facs="#surface-2"/.test(second));
	assert.ok(second.includes('facs="#zone-2-1"'));

	const parsed = parseFacsimileMei(mei);
	assert.equal(parsed.pages[1].zones[0].mdiv, true);
	assert.equal(parsed.pages[0].zones[0].mdiv, false);
	const rebuilt = buildFacsimileMei(
		{ headXml: parsed.headXml, pages: parsed.pages },
		{ withBreaks: true }
	);
	assert.equal(rebuilt, mei);
});

test('a page break implies the system break: a pb measure emits <pb> only, and can still open a movement', () => {
	const m = model();
	// Page 2's first measure carries the page break (default) and starts a new
	// movement; its system break is implied by the pb, so no <sb/> is written.
	m.pages[1].zones[0].mdiv = true;
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal(SyntaxValidator.validate(mei), true);
	// Nothing between page 2's <pb> and its measure — no redundant <sb>.
	const second = mei.slice(mei.indexOf('<mdiv xml:id="mdiv-2"'));
	const beforeMeasure = second.slice(0, second.indexOf('facs="#zone-2-1"'));
	assert.ok(/<pb[^>]*facs="#surface-2"/.test(beforeMeasure));
	assert.ok(!/<sb\b/.test(beforeMeasure));

	const parsed = parseFacsimileMei(mei);
	const z = parsed.pages[1].zones[0];
	assert.equal(z.pb, true);
	assert.equal(z.sb, false);
	assert.equal(z.mdiv, true);
	const rebuilt = buildFacsimileMei({ headXml: parsed.headXml, pages: parsed.pages }, { withBreaks: true });
	assert.equal(rebuilt, mei);
});

test('breaks carry @n: a page break its page number, a system break its order', () => {
	const m = model();
	// Page 1 measure 1 opens page 1, page 2 measure 1 opens page 2; page 1's
	// second measure is the only explicit system break (sb #1).
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.ok(/<pb xml:id="pb-1" n="1"/.test(mei));
	assert.ok(/<pb xml:id="pb-2" n="2"/.test(mei));
	assert.ok(/<sb xml:id="sb-1-2" n="1"/.test(mei));
});

test('movements: the first zone never opens a second <mdiv>', () => {
	const m = model();
	m.pages[0].zones[0].mdiv = true;
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal((mei.match(/<mdiv /g) ?? []).length, 1);
});

test('fills and escapes the header metadata', () => {
	const mei = buildFacsimileMei(initialFacsimileModel(twoPages, { title: 'A & B', composer: '<X>', license: 'CC-BY-4.0' }));
	assert.match(mei, /<title[^>]*>A &amp; B<\/title>/);
	assert.match(mei, /<persName[^>]*role="composer"[^>]*>&lt;X&gt;<\/persName>/);
	assert.match(mei, /<useRestrict[^>]*>CC-BY-4\.0<\/useRestrict>/);
});

test('sortReadingOrder groups systems top-to-bottom and orders each left-to-right', () => {
	// Two systems, boxes handed in shuffled; expect row-major reading order.
	const shuffled = [
		{ ulx: 0.5, uly: 0.6, lrx: 0.7, lry: 0.9 }, // row 2, middle
		{ ulx: 0.5, uly: 0.1, lrx: 0.7, lry: 0.4 }, // row 1, middle
		{ ulx: 0.1, uly: 0.11, lrx: 0.3, lry: 0.4 }, // row 1, left
		{ ulx: 0.1, uly: 0.62, lrx: 0.3, lry: 0.9 }, // row 2, left
		{ ulx: 0.8, uly: 0.09, lrx: 0.95, lry: 0.4 } // row 1, right
	];
	const ordered = sortReadingOrder(shuffled);
	assert.deepEqual(
		ordered.map((b) => [b.ulx, b.uly]),
		[
			[0.1, 0.11],
			[0.5, 0.1],
			[0.8, 0.09],
			[0.1, 0.62],
			[0.5, 0.6]
		]
	);
});

test('a page with no detected measures still emits its surface', () => {
	const mei = buildFacsimileMei(
		initialFacsimileModel([{ image: 'img/01.jpg', width: 800, height: 600, measures: [] }], {})
	);
	assert.equal((mei.match(/<surface /g) ?? []).length, 1);
	assert.equal((mei.match(/<zone /g) ?? []).length, 0);
});

test('parseFacsimileMei reads a body that carries attributes', () => {
	const mei =
		`<mei><meiHead><fileDesc/></meiHead><music><body xml:id="b1"><mdiv><score><section>` +
		`<pb xml:id="p1" facs="#z1"/><measure xml:id="m1" facs="#z1" n="1"/>` +
		`</section></score></mdiv></body></music>` +
		`<facsimile><surface ulx="0" uly="0" lrx="799" lry="599">` +
		`<graphic target="img/01.jpg" width="800" height="600"/>` +
		`<zone xml:id="z1" type="measure" ulx="10" uly="20" lrx="110" lry="120"/>` +
		`</surface></facsimile></mei>`;
	const parsed = parseFacsimileMei(mei);
	assert.equal(parsed.hasMeasures, true);
	assert.equal(parsed.hasBreaks, true);
	assert.equal(parsed.pages[0].zones[0].pb, true);
});

test('relinkFacsimileImages retargets each surface and scales it to the image', () => {
	const mei =
		`<facsimile><surface xml:id="s1" ulx="0" uly="0" lrx="1999" lry="2580">` +
		`<graphic xml:id="g1" height="2581" target="img/01.jpg" width="2000"/>` +
		`<zone xml:id="z1" type="measure" ulx="200" uly="258" lrx="1000" lry="1290"/>` +
		`</surface><surface xml:id="s2">` +
		`<graphic xml:id="g2" target="img/02.jpg" width="2000" height="2581"/>` +
		`</surface></facsimile>`;
	// Half the width and height the encoding was authored against.
	const relinked = relinkFacsimileImages(mei, [
		{ target: '../img/01.jpg', width: 1000, height: 1290 }
	]);
	assert.match(relinked, /<graphic xml:id="g1" height="1290" target="\.\.\/img\/01\.jpg" width="1000"\/>/);
	assert.match(relinked, /<zone xml:id="z1" type="measure" ulx="100" uly="129" lrx="500" lry="645"\/>/);
	assert.match(relinked, /<surface xml:id="s1" ulx="0" uly="0" lrx="1000" lry="1290">/);
	// A surface past the end of the sequence is left alone.
	assert.match(relinked, /<graphic xml:id="g2" target="img\/02\.jpg" width="2000" height="2581"\/>/);
});

test('relinkFacsimileImages leaves a surface whose graphic declares no size', () => {
	const mei = `<facsimile><surface><graphic target="img/01.jpg"/><zone ulx="10" uly="20" lrx="30" lry="40"/></surface></facsimile>`;
	const relinked = relinkFacsimileImages(mei, [{ target: '../img/01.jpg', width: 800, height: 600 }]);
	assert.match(relinked, /<zone ulx="10" uly="20" lrx="30" lry="40"\/>/);
	assert.match(relinked, /target="\.\.\/img\/01\.jpg"/);
	assert.match(relinked, /width="800"/);
});

test('buildBlankScoreMei: one pb and one seed measure per page, no facsimile', () => {
	const mei = buildBlankScoreMei(buildMeiHead({ title: 'Blank' }), 3);
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.ok(!mei.includes('<facsimile>'));
	assert.equal((mei.match(/<pb /g) ?? []).length, 3);
	assert.ok(mei.includes('facs="#surface-2"'));
	assert.equal((mei.match(/<measure /g) ?? []).length, 3);
	// The parser sees encoded breaks and measures but no facsimile pages, which
	// is what makes the console preview paginate on the pb markers.
	const parsed = parseFacsimileMei(mei);
	assert.equal(parsed.pages.length, 0);
	assert.equal(parsed.hasBreaks, true);
	assert.equal(parsed.hasMeasures, true);
});

test('buildBlankScoreMei without a page count seeds a single unpaged measure', () => {
	const mei = buildBlankScoreMei(buildMeiHead({ title: 'Blank' }), 0);
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.ok(!mei.includes('<pb '));
	assert.equal((mei.match(/<measure /g) ?? []).length, 1);
});
