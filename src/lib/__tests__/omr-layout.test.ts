import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layoutBoxes, staffCountOf, staffCrops, stavesBySystem } from '../omr-layout.ts';

// The category ids the layout model uses (layout.json's `categories`).
const categories = [
	{ id: 0, name: 'staff' },
	{ id: 2, name: 'grandstaff' },
	{ id: 3, name: 'system' },
	{ id: 4, name: 'staffMeasure' },
	{ id: 6, name: 'systemMeasure' }
];

test('systemMeasure boxes become measures, staff boxes staves; other categories are ignored', () => {
	const layout = {
		categories,
		images: [{ id: 0, width: 1000, height: 1500, file_name: 'image.jpg' }],
		annotations: [
			{ category_id: 6, bbox: [100.4, 200.6, 300, 120] as [number, number, number, number] },
			{ category_id: 0, bbox: [90, 210, 800, 40] as [number, number, number, number] },
			{ category_id: 3, bbox: [80, 190, 850, 150] as [number, number, number, number] },
			{ category_id: 4, bbox: [100, 210, 300, 40] as [number, number, number, number] },
			{ category_id: 2, bbox: [80, 190, 850, 150] as [number, number, number, number] }
		]
	};
	assert.deepEqual(layoutBoxes(layout, { width: 1000, height: 1500 }), {
		measures: [{ ulx: 100, uly: 201, lrx: 400, lry: 321 }],
		staves: [{ ulx: 90, uly: 210, lrx: 890, lry: 250 }]
	});
});

test('boxes are scaled to the page when the document declares another image size, and clamped', () => {
	const layout = {
		categories,
		images: [{ width: 500, height: 750 }],
		annotations: [
			{ category_id: 6, bbox: [400, 700, 200, 100] as [number, number, number, number] },
			// No area once clamped to the page: dropped.
			{ category_id: 0, bbox: [500, 10, 50, 20] as [number, number, number, number] }
		]
	};
	assert.deepEqual(layoutBoxes(layout, { width: 1000, height: 1500 }), {
		measures: [{ ulx: 800, uly: 1400, lrx: 1000, lry: 1500 }],
		staves: []
	});
});

test('a layout without annotations or categories is an empty page', () => {
	assert.deepEqual(layoutBoxes({}, { width: 10, height: 10 }), { measures: [], staves: [] });
});

test('staffCrops grows each staff by its height times the margin, clamped to the page', () => {
	assert.deepEqual(
		staffCrops([{ ulx: 100, uly: 50, lrx: 900, lry: 110 }, { ulx: 100, uly: 500, lrx: 900, lry: 560 }], { width: 1000, height: 600 }),
		[
			{ ulx: 46, uly: 0, lrx: 954, lry: 164 },
			{ ulx: 46, uly: 446, lrx: 954, lry: 600 }
		]
	);
	assert.deepEqual(staffCrops([{ ulx: 10, uly: 10, lrx: 90, lry: 20 }], { width: 100, height: 100 }, 0), [
		{ ulx: 10, uly: 10, lrx: 90, lry: 20 }
	]);
});

test('stavesBySystem assigns staves to the measure row they overlap, top to bottom', () => {
	// Two systems of two measures each; three staves in the first, two in the second,
	// one stray staff between them that overlaps neither row.
	const measures = [
		{ ulx: 0, uly: 100, lrx: 500, lry: 400 },
		{ ulx: 500, uly: 100, lrx: 1000, lry: 400 },
		{ ulx: 0, uly: 600, lrx: 500, lry: 800 },
		{ ulx: 500, uly: 600, lrx: 1000, lry: 800 }
	];
	const staves = [
		{ ulx: 0, uly: 700, lrx: 1000, lry: 760 },
		{ ulx: 0, uly: 300, lrx: 1000, lry: 360 },
		{ ulx: 0, uly: 120, lrx: 1000, lry: 180 },
		{ ulx: 0, uly: 210, lrx: 1000, lry: 270 },
		{ ulx: 0, uly: 610, lrx: 1000, lry: 670 },
		{ ulx: 0, uly: 450, lrx: 1000, lry: 500 }
	];
	const systems = stavesBySystem(measures, staves);
	assert.deepEqual(
		systems.map((system) => system.map((s) => s.uly)),
		[[120, 210, 300, 450], [610, 700]]
	);
	assert.deepEqual(stavesBySystem([], staves), []);
});

test('staffCountOf is the most frequent staves-per-system, larger count on a tie, 1 without staves', () => {
	const system = (top: number, count: number) => ({
		measures: [{ ulx: 0, uly: top, lrx: 1000, lry: top + 300 }],
		staves: Array.from({ length: count }, (_, i) => ({ ulx: 0, uly: top + 10 + i * 90, lrx: 1000, lry: top + 60 + i * 90 }))
	});
	const merge = (...pages: ReturnType<typeof system>[]) => ({
		measures: pages.flatMap((p) => p.measures),
		staves: pages.flatMap((p) => p.staves)
	});
	assert.equal(staffCountOf([merge(system(0, 3), system(400, 3), system(800, 2))]), 3);
	assert.equal(staffCountOf([merge(system(0, 3), system(400, 2))]), 3);
	assert.equal(staffCountOf([merge(system(0, 0))]), 1);
	assert.equal(staffCountOf([]), 1);
});
