import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keysigFor, proposeScoreDef, readAttributes } from '../omr-musicxml.ts';

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
