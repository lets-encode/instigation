import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stitchPage } from '../omr-stitch.ts';

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
	const page = stitchPage(
		[
			[staff(KEY_TIME + G, [rest, rest]), staff(F, [rest, rest])],
			[staff(G, [rest]), staff(F, [rest])]
		],
		['G2', 'F4'],
		[
			[0, 1],
			[0, 1]
		]
	);
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

test('a key and time read by most staves are written to every part', () => {
	const page = stitchPage([[staff(KEY_TIME + G, [rest]), staff(KEY_TIME + F, [rest]), staff(F, [rest])]], ['G2', 'F4', 'F4'], [[0, 1, 2]]);
	for (const k of [1, 2, 3]) {
		const attributes = /<attributes>([\s\S]*?)<\/attributes>/.exec(partOf(page.musicxml, k))![1];
		assert.match(attributes, /^<divisions>1<\/divisions><key><fifths>-1<\/fifths><\/key><time>/, `part ${k}`);
		assert.ok(attributes.indexOf('<time>') < attributes.indexOf('<clef>'), `part ${k}: time before clef`);
	}
});

test('a staff with fewer measures than its system is padded; a missing staff is empty measures', () => {
	const page = stitchPage(
		[[staff(G, [rest, rest, rest]), null], [staff(G, [rest]), staff(F, [rest, rest])]],
		['G2', 'F4'],
		[
			[0, 1],
			[0, 1]
		]
	);
	assert.deepEqual(page.measuresPerSystem, [3, 2]);
	const p2 = partOf(page.musicxml, 2);
	assert.equal((p2.match(/<measure /g) ?? []).length, 5);
	// The empty part opens with its clef, then stays empty.
	assert.match(p2, /^<measure number="1"><attributes><divisions>1<\/divisions><key><fifths>0<\/fifths><\/key><clef><sign>F<\/sign><line>4<\/line><\/clef><\/attributes><\/measure><measure number="2"\/>/);
	// The padded measure of part 1 in system 2 is empty, not a rest.
	assert.match(partOf(page.musicxml, 1), /<measure number="5"\/>/);
});

test('no systems: an empty score', () => {
	const page = stitchPage([], [], []);
	assert.equal(page.parts, 0);
	assert.deepEqual(page.measuresPerSystem, []);
	assert.match(page.musicxml, /<part-list><\/part-list>/);
});

test('a short system fills the parts it is placed on and leaves the others empty', () => {
	const page = stitchPage(
		[
			[staff(KEY_TIME + G, [rest, rest]), staff(KEY_TIME + F, [rest, rest])],
			[staff(G, [rest]), staff(G, [rest]), staff(F, [rest])]
		],
		['G2', 'G2', 'F4'],
		[
			[1, 2],
			[0, 1, 2]
		]
	);
	assert.equal(page.parts, 3);
	assert.deepEqual(page.measuresPerSystem, [2, 1]);
	// Part 1 (the voice) is empty through the first system, then gets the second system's top staff.
	assert.match(partOf(page.musicxml, 1), /^<measure number="1"><attributes><divisions>1<\/divisions><key><fifths>-1<\/fifths><\/key><time>[\s\S]*?<\/time><clef><sign>G<\/sign><line>2<\/line><\/clef><\/attributes><\/measure><measure number="2"\/><measure number="3"[^>]*><print new-system="yes"\/>/);
	// The piano's right hand takes part 2 in both systems, with the key and time.
	assert.match(partOf(page.musicxml, 2), /<measure number="1"><attributes><divisions>1<\/divisions><key>/);
	assert.equal((partOf(page.musicxml, 3).match(/<measure number="\d+">/g) ?? []).length, 3);
});

test('a staff placed on -1 or beyond the definition is left out', () => {
	const page = stitchPage([[staff(G, [rest]), staff(F, [rest]), staff(F, [rest])]], ['G2', 'perc'], [[0, -1, 5]]);
	assert.equal(page.parts, 2);
	assert.match(partOf(page.musicxml, 2), /^<measure number="1"><attributes><divisions>1<\/divisions><key><fifths>0<\/fifths><\/key><clef><sign>percussion<\/sign><\/clef><\/attributes><\/measure>$/);
});

const note = (step: string, octave: number) =>
	`<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>4</duration><voice>1</voice></note>`;
const C3 = '<clef><sign>C</sign><line>3</line></clef>';
const clefsOf = (part: string) => part.match(/<clef>[\s\S]*?<\/clef>/g) ?? [];

test('the recognised clef is kept with its pitches, and the page opening names it', () => {
	const page = stitchPage([[staff(G, [note('B', 4)])]], ['C3'], [[0]]);
	const part = partOf(page.musicxml, 1);
	assert.deepEqual(clefsOf(part), [G]);
	assert.match(part, /<step>B<\/step><octave>4<\/octave>/);
	assert.deepEqual(page.opening.clefs, ['G2']);
	// A first clef equal to the one in force is no change.
	assert.deepEqual(stitchPage([[staff(G, [rest])]], ['G2'], [[0]]).opening.clefs, [null]);
});

test('a repeated system clef is dropped, a different one is kept as a change', () => {
	const page = stitchPage(
		[[staff(F, [rest])], [staff(F, [rest])], [staff(C3, [rest])], [staff(C3, [rest])]],
		['F4'],
		[[0], [0], [0], [0]]
	);
	assert.deepEqual(clefsOf(partOf(page.musicxml, 1)), [F, C3]);
	assert.match(partOf(page.musicxml, 1), /<measure number="3"><print new-system="yes"\/><attributes><divisions>1<\/divisions><clef><sign>C</);
});

test('a staff without a clef continues in the clef in force', () => {
	const page = stitchPage([[staff(C3, [rest])], [staff('', [rest])], [staff(C3, [rest])]], ['F4'], [[0], [0], [0]]);
	// The change to C3 holds through the system without a clef, so the third system repeats it.
	assert.deepEqual(clefsOf(partOf(page.musicxml, 1)), [C3]);
});

test('a part a system leaves out keeps its clef', () => {
	const page = stitchPage(
		[[staff(G, [rest]), staff(C3, [rest])], [staff(G, [rest])], [staff(G, [rest]), staff(C3, [rest])]],
		['G2', 'F4'],
		[[0, 1], [0], [0, 1]]
	);
	assert.deepEqual(clefsOf(partOf(page.musicxml, 2)), [C3]);
});

test('a clef change inside a staff is in force at the next system', () => {
	const change = `<attributes>${F}</attributes>${rest}`;
	const page = stitchPage([[staff(G, [rest, change])], [staff(F, [rest])]], ['G2'], [[0], [0]]);
	assert.deepEqual(clefsOf(partOf(page.musicxml, 1)), [G, F]);
});

test('an octave clef is told apart from its plain form', () => {
	const G8 = '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>';
	assert.deepEqual(stitchPage([[staff(G8, [rest])]], ['G2-1'], [[0]]).opening.clefs, [null]);
	assert.deepEqual(stitchPage([[staff(G8, [rest])]], ['G2'], [[0]]).opening.clefs, ['G2-1']);
});

const key = (fifths: number) => `<key><fifths>${fifths}</fifths></key>`;
const time = (beats: number, type: number) => `<time><beats>${beats}</beats><beat-type>${type}</beat-type></time>`;
const START = { fifths: -2, time: { beats: '3', beatType: '8', symbol: '' } };

test('key and meter change only on a majority of the staves, none reading another', () => {
	const page = stitchPage(
		[
			[staff(key(-2) + time(3, 8) + G, [rest]), staff(F, [rest])],
			// Disagreeing staves: the key in force stays.
			[staff(key(-2) + G, [rest]), staff(key(0) + F, [rest])],
			// A key both staves read and a meter one of two reads: the key changes.
			[staff(key(1) + time(4, 4) + G, [rest]), staff(key(1) + F, [rest])],
			// A meter both staves read: a change.
			[staff(time(2, 4) + G, [rest]), staff(time(2, 4) + F, [rest])],
			// Repeated: no change.
			[staff(key(1) + G, [rest]), staff(key(1) + F, [rest])]
		],
		['G2', 'F4'],
		[[0, 1], [0, 1], [0, 1], [0, 1], [0, 1]],
		START
	);
	assert.equal(page.opening.fifths, null);
	assert.equal(page.opening.time, null);
	for (const k of [1, 2]) {
		const part = partOf(page.musicxml, k);
		assert.deepEqual(part.match(/<fifths>-?\d+<\/fifths>/g), ['<fifths>-2</fifths>', '<fifths>1</fifths>'], `part ${k}`);
		assert.deepEqual(part.match(/<beats>\d+<\/beats>/g), ['<beats>3</beats>', '<beats>2</beats>'], `part ${k}`);
		assert.match(part, /<measure number="3"[^>]*>(<print new-system="yes"\/>)?<attributes>(<divisions>1<\/divisions>)?<key><fifths>1<\/fifths><\/key><\/attributes>/);
	}
});

test('a key the first system changes is reported for the page opening', () => {
	const page = stitchPage([[staff(key(3) + G, [rest]), staff(key(3) + F, [rest])]], ['G2', 'F4'], [[0, 1]], START);
	assert.equal(page.opening.fifths, 3);
	assert.equal(page.opening.time, null);
	// Two of three staves reading it are a majority; one of two is not.
	const three = [[staff(key(3) + G, [rest]), staff(key(3) + G, [rest]), staff(F, [rest])]];
	assert.equal(stitchPage(three, ['G2', 'G2', 'F4'], [[0, 1, 2]], START).opening.fifths, 3);
	assert.equal(stitchPage([[staff(key(3) + G, [rest]), staff(F, [rest])]], ['G2', 'F4'], [[0, 1]], START).opening.fifths, null);
});

test('a page whose first system has no transcription opens at the next system', () => {
	const page = stitchPage([[null, null], [staff(key(-2) + G, [rest]), staff(F, [rest])]], ['G2', 'G2'], [[0, 1], [0, 1]], START);
	assert.deepEqual(page.opening.clefs, [null, 'F4']);
	const p2 = partOf(page.musicxml, 2);
	assert.match(p2, /^<measure number="1"><attributes><divisions>1<\/divisions><key><fifths>-2<\/fifths><\/key><time>[\s\S]*?<\/time><clef><sign>F</);
});

test('a meter read without the symbol of the common time in force is no change', () => {
	const common = { fifths: 0, time: { beats: '4', beatType: '4', symbol: 'common' } };
	const page = stitchPage([[staff(time(4, 4) + G, [rest]), staff(time(4, 4) + F, [rest])]], ['G2', 'F4'], [[0, 1]], common);
	assert.equal(page.opening.time, null);
	assert.match(partOf(page.musicxml, 1), /<time symbol="common">/);
});
