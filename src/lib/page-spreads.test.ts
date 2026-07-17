import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpreads } from './page-spreads.ts';

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

test('no pages: no spreads', () => {
	assert.deepEqual(buildSpreads(0, 'single', true), []);
	assert.deepEqual(buildSpreads(0, 'double', true), []);
});
