import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpreads, defaultSpreadView } from '../page-spreads.ts';

test('single view: one spread per page', () => {
	assert.deepEqual(buildSpreads(3, 'single', true), [
		{ pages: [0] },
		{ pages: [1] },
		{ pages: [2] }
	]);
});

test('double view, page 1 on the right: 1 | 2–3 | 4–5 …', () => {
	assert.deepEqual(buildSpreads(4, 'double', true), [
		{ pages: [0], lonelySide: 'right' },
		{ pages: [1, 2] },
		{ pages: [3], lonelySide: 'left' }
	]);
});

test('double view, page 1 on the left: 1–2 | 3–4 …', () => {
	assert.deepEqual(buildSpreads(4, 'double', false), [
		{ pages: [0, 1] },
		{ pages: [2, 3] }
	]);
	assert.deepEqual(buildSpreads(3, 'double', false), [
		{ pages: [0, 1] },
		{ pages: [2], lonelySide: 'left' }
	]);
});

test('default view: two pages open side by side, everything else single', () => {
	assert.deepEqual(defaultSpreadView(2), { view: 'double', firstOnRight: false });
	assert.deepEqual(defaultSpreadView(1), { view: 'single', firstOnRight: true });
	assert.deepEqual(defaultSpreadView(3), { view: 'single', firstOnRight: true });
	assert.deepEqual(defaultSpreadView(0), { view: 'single', firstOnRight: true });
});

test('no pages: no spreads', () => {
	assert.deepEqual(buildSpreads(0, 'single', true), []);
	assert.deepEqual(buildSpreads(0, 'double', true), []);
});
