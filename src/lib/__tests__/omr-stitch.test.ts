import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alignStaves, stitchPage } from '../omr-stitch.ts';

// A staff transcription as the staff model writes it: one part, attributes on
// the first measure, no measure numbers.
const staff = (attributes: string, measures: string[]) =>
	`<?xml version='1.0' encoding='utf-8'?><score-partwise version="3.1"><part-list><score-part id="P2"><part-name>Piano</part-name></score-part></part-list><part id="P2">` +
	measures.map((m, i) => `<measure>${i === 0 ? `<attributes><divisions>1</divisions>${attributes}</attributes>` : ''}${m}</measure>`).join('') +
	`</part></score-partwise>`;
const rest = '<note><rest measure="yes"/><duration>4</duration><voice>1</voice></note>';
const G = '<clef><sign>G</sign><line>2</line></clef>';
const F = '<clef><sign>F</sign><line>4</line></clef>';
const KEY_TIME = '<key><fifths>-1</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time>';

const partOf = (xml: string, k: number) => new RegExp(`<part id="P${k}">([\\s\\S]*?)</part>`).exec(xml)![1];

test('staff k of every system becomes part k; systems follow with a system break', () => {
	const page = stitchPage([
		[staff(KEY_TIME + G, [rest, rest]), staff(F, [rest, rest])],
		[staff(G, [rest]), staff(F, [rest])]
	]);
	assert.equal(page.parts, 2);
	assert.deepEqual(page.measuresPerSystem, [2, 1]);
	assert.equal((page.musicxml.match(/<score-part /g) ?? []).length, 2);
	const p1 = partOf(page.musicxml, 1);
	const p2 = partOf(page.musicxml, 2);
	assert.equal((p1.match(/<measure /g) ?? []).length, 3);
	assert.equal((p2.match(/<measure /g) ?? []).length, 3);
	// Measures are numbered through the part; the second system opens with a break on part 1 only.
	assert.match(p1, /<measure number="3"[^>]*><print new-system="yes"\/>/);
	assert.doesNotMatch(p2, /new-system/);
	assert.match(p1, /<measure number="1"/);
});

test('the key and time of the first staff that carries them are copied to the staves without', () => {
	const page = stitchPage([[staff(G, [rest]), staff(KEY_TIME + F, [rest]), staff(F, [rest])]]);
	for (const k of [1, 2, 3]) {
		const attributes = /<attributes>([\s\S]*?)<\/attributes>/.exec(partOf(page.musicxml, k))![1];
		assert.match(attributes, /^<divisions>1<\/divisions><key><fifths>-1<\/fifths><\/key><time>/, `part ${k}`);
		assert.ok(attributes.indexOf('<time>') < attributes.indexOf('<clef>'), `part ${k}: time before clef`);
	}
});

test('a staff with fewer measures than its system is padded; a missing staff is empty measures', () => {
	const page = stitchPage([[staff(G, [rest, rest, rest]), null], [staff(G, [rest]), staff(F, [rest, rest])]]);
	assert.deepEqual(page.measuresPerSystem, [3, 2]);
	const p2 = partOf(page.musicxml, 2);
	assert.equal((p2.match(/<measure /g) ?? []).length, 5);
	assert.match(p2, /<measure number="1"\/>/);
	// The padded measure of part 1 in system 2 is empty, not a rest.
	assert.match(partOf(page.musicxml, 1), /<measure number="5"\/>/);
});

test('no systems: an empty score', () => {
	const page = stitchPage([]);
	assert.equal(page.parts, 0);
	assert.deepEqual(page.measuresPerSystem, []);
	assert.match(page.musicxml, /<part-list><\/part-list>/);
});

test('alignStaves places a system\'s staves on the parts whose clefs match, lowest on a tie', () => {
	// A piano introduction (G, F) under a voice + piano definition (G, G, F).
	assert.deepEqual(alignStaves(['G2', 'F4'], ['G2', 'G2', 'F4']), [1, 2]);
	// An unknown clef matches anything; the tie goes to the lower placement.
	assert.deepEqual(alignStaves([null, 'F4'], ['G2', 'G2', 'F4']), [1, 2]);
	assert.deepEqual(alignStaves(['G2'], ['G2', 'G2']), [1]);
	// A clef that matches only the top part goes there.
	assert.deepEqual(alignStaves(['C3', 'F4'], ['C3', 'G2', 'F4']), [0, 2]);
	// Full or overfull systems keep their order; extra bottom staves are dropped.
	assert.deepEqual(alignStaves(['G2', 'G2', 'F4'], ['G2', 'G2', 'F4']), [0, 1, 2]);
	assert.deepEqual(alignStaves(['G2', 'G2', 'F4', 'F4'], ['G2', 'G2', 'F4']), [0, 1, 2, -1]);
});

test('with part clefs, a short system fills the matching parts and leaves the others empty', () => {
	const page = stitchPage(
		[
			[staff(KEY_TIME + G, [rest, rest]), staff(F, [rest, rest])],
			[staff(G, [rest]), staff(G, [rest]), staff(F, [rest])]
		],
		['G2', 'G2', 'F4']
	);
	assert.equal(page.parts, 3);
	assert.deepEqual(page.measuresPerSystem, [2, 1]);
	// Part 1 (the voice) is empty through the first system, then gets the second system's top staff.
	assert.match(partOf(page.musicxml, 1), /^<measure number="1"\/><measure number="2"\/><measure number="3"[^>]*><print new-system="yes"\/>/);
	// The piano's right hand takes part 2 in both systems, with the key and time copied.
	assert.match(partOf(page.musicxml, 2), /<measure number="1"><attributes><divisions>1<\/divisions><key>/);
	assert.equal((partOf(page.musicxml, 3).match(/<measure number="\d+">/g) ?? []).length, 3);
});
