import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidHandle, makeHandle } from '../campaign-handle.ts';

test('accepts handles matching the registry slug rules', () => {
	assert.equal(isValidHandle('sym'), true);
	assert.equal(isValidHandle('symphony-9-choral'), true);
	assert.equal(isValidHandle('a1'), false); // under 3 characters
	assert.equal(isValidHandle('Symphony'), false); // uppercase
	assert.equal(isValidHandle('-leading'), false);
	assert.equal(isValidHandle('trailing-'), false);
	assert.equal(isValidHandle('double--hyphen'), false);
	assert.equal(isValidHandle('a'.repeat(41)), false);
});

test('drops stop words, catalogue labels and their numbers', () => {
	assert.equal(makeHandle('The Art of Fugue'), 'art-fugue');
	assert.equal(makeHandle('Sonata, Op. 125'), 'sonata');
	assert.equal(makeHandle('Concerto BWV 1043'), 'concerto');
});

test('keeps the number a No. label names', () => {
	assert.equal(makeHandle('Symphony No. 9'), 'symphony-9');
});

test('normalises key designations across languages', () => {
	assert.equal(makeHandle('Sonata in C sharp minor'), 'sonata-cs-minor');
	assert.equal(makeHandle('Sonate c-Moll'), 'sonate-c-minor');
	assert.equal(makeHandle('Sonata in Si bemolle maggiore'), 'sonata-bb-major');
	// German B is B flat, H is B natural.
	assert.equal(makeHandle('Messe h-Moll'), 'messe-b-minor');
	assert.equal(makeHandle('Messe B-Dur'), 'messe-bb-major');
});

test('transliterates umlauts and strips diacritics', () => {
	assert.equal(makeHandle('Größe'), 'groesse');
	assert.equal(makeHandle('Cantándose'), 'cantandose');
	// "für" transliterates to "fuer", which is itself a German stop word.
	assert.equal(makeHandle('Für Elise'), 'elise');
});

test('keeps at most four words and never ends in a hyphen', () => {
	const h = makeHandle('Fantasia Chromatica Ricercata Toccata Passacaglia');
	assert.equal(h, 'fantasia-chromatica-ricercata-toccata');
	assert.ok(!h.endsWith('-'));
});

test('caps the handle at the registry length limit', () => {
	const h = makeHandle('Praeludium Fantasiestueck Ricercare Passacaglia');
	assert.ok(h.length <= 40, `expected ≤40 chars, got ${h.length}`);
	assert.ok(!h.endsWith('-'));
});

test('falls back to the raw words when every token is dropped', () => {
	assert.equal(makeHandle('The Of And'), 'the-of-and');
});

test('derives a valid handle from a realistic title', () => {
	const h = makeHandle('Symphony No. 9 in D minor, Op. 125');
	assert.equal(h, 'symphony-9-d-minor');
	assert.equal(isValidHandle(h), true);
});
