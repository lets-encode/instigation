import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	buildFacsimileMei,
	initialFacsimileModel,
	parseFacsimileMei,
	sortReadingOrder,
	nextLabel,
	type FacsimilePage,
	type FacsimileModel
} from './mei-facsimile.ts';

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

test('stage B: one empty measure per zone, labels from the zones, no breaks', () => {
	const mei = buildFacsimileMei(model(), { withMeasures: true });
	assert.equal((mei.match(/<measure /g) ?? []).length, 3);
	assert.equal((mei.match(/<mRest\/>/g) ?? []).length, 3);
	assert.equal((mei.match(/<pb /g) ?? []).length, 0);
	assert.ok(mei.includes('<measure xml:id="measure-1" n="1" facs="#zone-1-1">'));
	assert.ok(mei.includes('<measure xml:id="measure-3" n="3" facs="#zone-2-1">'));
	// Every facs target has a matching zone id.
	for (const [, id] of mei.matchAll(/facs="#(zone-[^"]+)"/g)) {
		assert.ok(mei.includes(`<zone xml:id="${id}"`), `missing ${id}`);
	}
});

test('stage C: a pb per page, an sb per flagged measure (except page starts)', () => {
	const m = model();
	// Page 1's two boxes are two systems (stacked), so its second measure is a
	// system start — expect one <sb/> for it; page firsts are covered by <pb/>.
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal((mei.match(/<pb /g) ?? []).length, 2);
	assert.equal((mei.match(/<sb /g) ?? []).length, 1);
	assert.ok(/<pb[^>]*facs="#surface-1"/.test(mei));
});

test('volta labels: an override interrupts the numbering and it continues after', () => {
	const m = model();
	m.pages[0].zones[1].label = '1a';
	// Automatic numbering derives the next label from the previous one.
	assert.equal(nextLabel('1a'), '2');
	const mei = buildFacsimileMei(m, { withMeasures: true });
	assert.ok(mei.includes('n="1a" facs="#zone-1-2"'));
});

test('parseFacsimileMei round-trips the model through every stage', () => {
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
	assert.equal((mei.match(/<scoreDef>/g) ?? []).length, 2);
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

test('movements: the first zone never opens a second <mdiv>', () => {
	const m = model();
	m.pages[0].zones[0].mdiv = true;
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal((mei.match(/<mdiv /g) ?? []).length, 1);
});

test('fills and escapes the header metadata', () => {
	const mei = buildFacsimileMei(initialFacsimileModel(twoPages, { title: 'A & B', composer: '<X>', license: 'CC-BY-4.0' }));
	assert.ok(mei.includes('<title>A &amp; B</title>'));
	assert.ok(mei.includes('<persName role="composer">&lt;X&gt;</persName>'));
	assert.ok(mei.includes('<useRestrict>CC-BY-4.0</useRestrict>'));
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
