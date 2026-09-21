import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layoutBoxes, layoutRecord, staffCountOf, staffCrops, stavesBySystem } from '../omr-layout.ts';

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

test('stavesBySystem joins the staves a measure spans, top to bottom', () => {
	// Two systems of two measures each; three staves in the first, two in the second,
	// one stray staff between them that no measure spans.
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

test('stavesBySystem keeps a system together when some measures cover one staff only', () => {
	// Two systems of two staves. The last measure of the first system was
	// detected as two one-staff boxes, the first measure of the second system
	// as a one-staff box above a full-height duplicate.
	const measures = [
		{ ulx: 0, uly: 750, lrx: 800, lry: 921 },
		{ ulx: 800, uly: 748, lrx: 1000, lry: 802 },
		{ ulx: 800, uly: 865, lrx: 1000, lry: 917 },
		{ ulx: 0, uly: 984, lrx: 200, lry: 1037 },
		{ ulx: 0, uly: 987, lrx: 200, lry: 1153 },
		{ ulx: 200, uly: 985, lrx: 1000, lry: 1152 }
	];
	const staves = [
		{ ulx: 0, uly: 750, lrx: 1000, lry: 806 },
		{ ulx: 0, uly: 867, lrx: 1000, lry: 923 },
		{ ulx: 0, uly: 984, lrx: 1000, lry: 1039 },
		{ ulx: 0, uly: 1101, lrx: 1000, lry: 1155 }
	];
	assert.deepEqual(
		stavesBySystem(measures, staves).map((system) => system.map((s) => s.uly)),
		[[750, 867], [984, 1101]]
	);
	// Measures that span no staff give no system.
	assert.deepEqual(stavesBySystem([{ ulx: 0, uly: 0, lrx: 10, lry: 10 }], staves), []);
});

test('staffCountOf is the most frequent staves-per-system above one, larger count on a tie, else 1', () => {
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
	// Single-staff systems do not vote: a page whose measure boxes each cover one staff.
	assert.equal(staffCountOf([merge(system(0, 2)), merge(system(0, 1), system(400, 1), system(800, 1))]), 2);
	assert.equal(staffCountOf([merge(system(0, 1), system(400, 1))]), 1);
	assert.equal(staffCountOf([merge(system(0, 0))]), 1);
	assert.equal(staffCountOf([]), 1);
});

test('layoutRecord marks the raw layouts as uncorrected and names the model', () => {
	const layout = { categories, images: [{ width: 10, height: 10 }], annotations: [] };
	const record = layoutRecord({ name: 'dvorak-ola', version: '2.0' }, [{ image: 'img/01.jpg', layout }]);
	assert.equal(record.corrected, false);
	assert.deepEqual(record.model, { name: 'dvorak-ola', version: '2.0' });
	assert.match(record.note, /not corrected/);
	assert.deepEqual(record.pages, [{ image: 'img/01.jpg', layout }]);
});
