import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clefStaff, correctClef, keysigFor, proposeScoreDef, readAttributes, staffClefToken } from '../omr-musicxml.ts';

// The shape the staff model writes: one part, attributes on the first measure.
const staff = (attributes: string) =>
	`<?xml version='1.0' encoding='utf-8'?>\n<score-partwise version="3.1"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>` +
	`<part id="P1"><measure><attributes><divisions>1</divisions>${attributes}</attributes><note><rest measure="yes" /><duration>4</duration><voice>1</voice></note></measure></part></score-partwise>`;

test('readAttributes: clef, key and time of the first attributes block', () => {
	assert.deepEqual(
		readAttributes(
			staff(
				'<key><fifths>-3</fifths></key><time symbol="common"><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line><clef-octave-change>-1</clef-octave-change></clef>'
			)
		),
		{
			clef: { sign: 'F', line: 4, octaveChange: -1 },
			fifths: -3,
			time: { beats: '4', beatType: '4', symbol: 'common' }
		}
	);
	// An unprinted signature is read as none; a staff without attributes has nothing.
	assert.deepEqual(readAttributes(staff('<clef><sign>G</sign><line>2</line></clef>')), {
		clef: { sign: 'G', line: 2, octaveChange: 0 },
		fifths: null,
		time: null
	});
	assert.deepEqual(readAttributes('<score-partwise/>'), { clef: null, fifths: null, time: null });
});

test('keysigFor maps fifths to MEI keysig', () => {
	assert.equal(keysigFor(0), '0');
	assert.equal(keysigFor(2), '2s');
	assert.equal(keysigFor(-3), '3f');
	assert.equal(keysigFor(9), '7s');
});

test('proposeScoreDef: each staff its own clef; key and meter from the first staff carrying them', () => {
	const proposal = proposeScoreDef([
		staff('<key><fifths>2</fifths></key><time><beats>3</beats><beat-type>8</beat-type></time><clef><sign>G</sign><line>2</line></clef>'),
		staff('<clef><sign>G</sign><line>2</line></clef>'),
		staff('<clef><sign>F</sign><line>4</line></clef>')
	]);
	assert.deepEqual(
		proposal.staves.map((s) => `${s.clefShape}${s.clefLine}${s.clefDis}`),
		['G2', 'G2', 'F4']
	);
	assert.equal(proposal.keysig, '2s');
	assert.equal(proposal.meterCount, '3');
	assert.equal(proposal.meterUnit, '8');
	assert.equal(proposal.meterSym, '');
	assert.deepEqual(proposal.groups, []);
});

test('proposeScoreDef: a failed staff keeps the treble clef; a symbol meter is carried; empty input is one staff', () => {
	const proposal = proposeScoreDef([
		null,
		staff('<time symbol="cut"><beats>2</beats><beat-type>2</beat-type></time><clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>')
	]);
	assert.deepEqual(proposal.staves.map((s) => [s.clefShape, s.clefDis, s.clefDisPlace]), [
		['G', '', ''],
		['G', '8', 'below']
	]);
	assert.equal(proposal.keysig, '0');
	assert.equal(proposal.meterSym, 'cut');
	assert.equal(proposal.meterCount, '2');
	assert.equal(proposeScoreDef([]).staves.length, 1);
});

const G = '<clef><sign>G</sign><line>2</line></clef>';
const F = '<clef><sign>F</sign><line>4</line></clef>';

test('proposeScoreDef: signatures are read from the given sources before the clef system', () => {
	const proposal = proposeScoreDef(
		[staff(G), staff(F)],
		[staff('<key><fifths>-2</fifths></key><time><beats>6</beats><beat-type>8</beat-type></time>' + F)]
	);
	assert.deepEqual(proposal.staves.map((s) => s.clefShape), ['G', 'F']);
	assert.equal(proposal.keysig, '2f');
	assert.equal(`${proposal.meterCount}/${proposal.meterUnit}`, '6/8');
});

const C3 = '<clef><sign>C</sign><line>3</line></clef>';
const doc = (...measures: string[]) =>
	`<score-partwise><part id="P1">${measures.map((m) => `<measure>${m}</measure>`).join('')}</part></score-partwise>`;
const opening = (clef: string) => `<attributes><divisions>1</divisions>${clef}</attributes>`;
const pitch = (step: string, octave: number, extra = '') =>
	`<note><pitch><step>${step}</step>${extra.includes('<alter>') ? /<alter>.*?<\/alter>/.exec(extra)![0] : ''}<octave>${octave}</octave></pitch>${extra.replace(/<alter>.*?<\/alter>/, '')}</note>`;
const pitches = (xml: string) =>
	[...xml.matchAll(/<pitch><step>([A-G])<\/step>(?:<alter>(-?\d+)<\/alter>)?<octave>(-?\d+)<\/octave><\/pitch>/g)].map(
		(m) => `${m[1]}${m[2] ? (Number(m[2]) > 0 ? '#' : 'b') : ''}${m[3]}`
	);

test('correctClef moves the notes so they keep their lines and spaces', () => {
	// Read in treble, printed in bass: the bottom line E4 is G2.
	const { musicxml, state } = correctClef(doc(opening(G) + pitch('E', 4) + pitch('A', 5)), 'G2', 'F4', 'misread');
	assert.equal(state, 'misread');
	assert.match(musicxml, /<clef><sign>F<\/sign><line>4<\/line><\/clef>/);
	assert.deepEqual(pitches(musicxml), ['G2', 'C4']);
});

test('correctClef takes the alter from the printed accidental, which holds to the barline', () => {
	const sharp = '<alter>1</alter><accidental>sharp</accidental>';
	const { musicxml } = correctClef(
		// A key-signature flat read as alter without an accidental; a printed sharp, then the same line again.
		doc(opening(G) + pitch('B', 4, '<alter>-1</alter>') + pitch('F', 4, sharp) + pitch('F', 4), pitch('F', 4)),
		'G2',
		'F4',
		'misread'
	);
	// B4 → D3 follows the key; F4 → A2 keeps the printed sharp, the next A2 carries it, the next measure does not.
	assert.deepEqual(pitches(musicxml), ['D3', 'A#2', 'A#2', 'A2']);
});

test('correctClef stops at the first clef read as something else, for good', () => {
	const change = `<attributes>${C3}</attributes>`;
	const back = `<attributes>${G}</attributes>`;
	const first = correctClef(doc(opening(G) + pitch('E', 4), change + pitch('C', 4), back + pitch('E', 4)), 'G2', 'F4', 'misread');
	assert.equal(first.state, 'ended');
	assert.deepEqual(pitches(first.musicxml), ['G2', 'C4', 'E4']);
	// The misread clef after the real change is kept as read.
	assert.equal((first.musicxml.match(/<sign>G<\/sign>/g) ?? []).length, 1);
	// An inactive correction, or one without pitch, leaves the staff alone.
	const staff = doc(opening(G) + pitch('E', 4));
	assert.deepEqual(correctClef(staff, 'G2', 'F4', 'ended'), { musicxml: staff, state: 'ended' });
	assert.deepEqual(correctClef(staff, 'G2', 'perc', 'misread'), { musicxml: staff, state: 'misread' });
});

test('correctClef moves a staff without a clef, which continues in the misread one', () => {
	const { musicxml, state } = correctClef(doc(pitch('E', 4)), 'G2', 'F4', 'misread');
	assert.equal(state, 'misread');
	assert.deepEqual(pitches(musicxml), ['G2']);
	assert.deepEqual(pitches(correctClef(doc(opening(F) + pitch('G', 2)), 'F4', 'G2-1', 'misread').musicxml), ['E3']);
});

test('clef tokens and staff values convert both ways', () => {
	for (const token of ['G2', 'F4', 'C3', 'G2-1', 'F4+2', 'perc', 'TAB']) {
		assert.equal(staffClefToken(clefStaff(token)), token);
	}
});

test('correctClef keeps the alter of a note tied from the measure before', () => {
	const tieStop = '<alter>1</alter><tie type="stop"/>';
	const { musicxml } = correctClef(doc(opening(G) + pitch('C', 5, '<alter>1</alter><accidental>sharp</accidental>'), pitch('C', 5, tieStop)), 'G2', 'C3', 'misread');
	assert.deepEqual(pitches(musicxml), ['D#4', 'D#4']);
});

test('correctClef leaves a clef read as the corrected one in force, and replaces a clef of the same lines', () => {
	const bass = `<attributes>${F}</attributes>`;
	const { musicxml, state } = correctClef(doc(opening(G) + pitch('E', 4), bass + pitch('G', 2), `<attributes>${G}</attributes>` + pitch('E', 4)), 'G2', 'F4', 'misread');
	assert.equal(state, 'misread');
	assert.deepEqual(pitches(musicxml), ['G2', 'G2', 'G2']);
	// A staff that ended in the corrected clef as read continues unmoved.
	const after = correctClef(doc(opening(G) + pitch('E', 4), bass + pitch('G', 2)), 'G2', 'F4', 'misread');
	assert.equal(after.state, 'read');
	assert.deepEqual(pitches(correctClef(doc(pitch('G', 2)), 'G2', 'F4', after.state).musicxml), ['G2']);
	// F3 and C5 put the same pitch on the bottom line: only the clef changes.
	const F3 = '<clef><sign>F</sign><line>3</line></clef>';
	const same = correctClef(doc(opening(F3) + pitch('B', 2, '<alter>-1</alter>')), 'F3', 'C5', 'misread').musicxml;
	assert.match(same, /<sign>C<\/sign><line>5<\/line>/);
	assert.deepEqual(pitches(same), ['Bb2']);
});
