import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFacsimileScore, sortReadingOrder, type FacsimilePage } from './mei-facsimile.ts';

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

test('emits one surface, graphic and pb per page', () => {
	const mei = buildFacsimileScore(twoPages, {});
	assert.equal((mei.match(/<surface /g) ?? []).length, 2);
	assert.equal((mei.match(/<graphic /g) ?? []).length, 2);
	assert.equal((mei.match(/<pb /g) ?? []).length, 2);
	assert.ok(mei.includes('target="img/01.jpg"'));
	assert.ok(mei.includes('target="img/02.jpg"'));
});

test('emits one zone and one empty measure per detected box', () => {
	const mei = buildFacsimileScore(twoPages, {});
	assert.equal((mei.match(/<zone /g) ?? []).length, 3);
	assert.equal((mei.match(/<measure /g) ?? []).length, 3);
	assert.equal((mei.match(/<mRest\/>/g) ?? []).length, 3);
});

test('numbers measures continuously across pages and links each to its zone', () => {
	const mei = buildFacsimileScore(twoPages, {});
	assert.ok(mei.includes('<measure xml:id="measure-1" n="1" facs="#zone-1-1">'));
	assert.ok(mei.includes('<measure xml:id="measure-2" n="2" facs="#zone-1-2">'));
	// Page 2's first box continues the numbering but resets the per-page zone index.
	assert.ok(mei.includes('<measure xml:id="measure-3" n="3" facs="#zone-2-1">'));
	// Every facs target has a matching zone id.
	for (const [, id] of mei.matchAll(/facs="#(zone-[^"]+)"/g)) {
		assert.ok(mei.includes(`<zone xml:id="${id}"`), `missing ${id}`);
	}
});

test('surface carries the page pixel dimensions; zones round to integers', () => {
	const mei = buildFacsimileScore(
		[{ image: 'img/01.jpg', width: 1200, height: 1600, measures: [{ ulx: 242.9, uly: 171.1, lrx: 437.4, lry: 613.5 }] }],
		{}
	);
	assert.ok(mei.includes('lrx="1200" lry="1600"'));
	assert.ok(mei.includes('width="1200" height="1600"'));
	assert.ok(mei.includes('ulx="243" uly="171" lrx="437" lry="614"'));
});

test('fills and escapes the header metadata', () => {
	const mei = buildFacsimileScore(twoPages, { title: 'A & B', composer: '<X>', license: 'CC-BY-4.0' });
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

test('a page with no detected measures still emits its surface and pb', () => {
	const mei = buildFacsimileScore([{ image: 'img/01.jpg', width: 800, height: 600, measures: [] }], {});
	assert.equal((mei.match(/<surface /g) ?? []).length, 1);
	assert.equal((mei.match(/<pb /g) ?? []).length, 1);
	assert.equal((mei.match(/<zone /g) ?? []).length, 0);
	assert.equal((mei.match(/<measure /g) ?? []).length, 0);
});
