import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SCORE_DEF, type PageModel, type ScoreDefModel } from '../mei-facsimile.ts';
import type { OmrRecord } from '../omr-record.ts';
import { openingClefs, pageStart, pieceStaves, scoreStaves } from '../omr-timeline.ts';

const G = '<clef><sign>G</sign><line>2</line></clef>';
const F = '<clef><sign>F</sign><line>4</line></clef>';
const C3 = '<clef><sign>C</sign><line>3</line></clef>';
const staffXml = (clef: string, notes = '') =>
	`<score-partwise version="3.1"><part id="P1"><measure><attributes><divisions>1</divisions>${clef}</attributes>${notes}<note><rest measure="yes"/><duration>4</duration></note></measure></part></score-partwise>`;
const e4 = '<note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration></note>';

/** Pages of one system each, with one staff box per system: `clefs[p]` is the clef page p+1's staff reads. */
function piece(clefs: string[], corrections: OmrRecord['clefs'] = []) {
	const box = { ulx: 100, uly: 100, lrx: 900, lry: 160 };
	const pages: PageModel[] = clefs.map((_, p) => ({
		image: `img/${p + 1}.jpg`,
		width: 1000,
		height: 1000,
		zones: [{ box: { ulx: 100, uly: 80, lrx: 900, lry: 180 }, label: String(p + 1), pb: true, sb: false, mdiv: false }],
		staves: [box]
	}));
	const record: OmrRecord = {
		cropMargin: 0.9,
		staffPipeline: { name: 'mzk-staff', version: '1' },
		ocr: { engine: 'tesseract.js', version: '7.0.0', language: 'deu+eng' },
		pages: clefs.map((clef, p) => ({
			n: p + 1,
			image: `img/${p + 1}.jpg`,
			staves: [{ zone: `staff-zone-${p + 1}-1`, box, label: '', musicxml: staffXml(clef, e4), error: '' }]
		})),
		assignments: [],
		clefs: corrections
	};
	return { pages, record };
}
const def = (clefShape: string, clefLine: number): ScoreDefModel => ({
	...DEFAULT_SCORE_DEF,
	staves: [{ ...DEFAULT_SCORE_DEF.staves[0], clefShape, clefLine }]
});

test('the clef in force at a page start carries the changes of the pages before it', () => {
	const { pages, record } = piece([F, C3, C3, G]);
	const parsed = { pages, scoreDef: def('F', 4) };
	const staves = pieceStaves(parsed, record, scoreStaves(parsed));
	assert.deepEqual([1, 2, 3, 4].map((n) => pageStart(parsed, staves, n).clefs), [['F4'], ['F4'], ['C3'], ['C3']]);
	assert.equal(pageStart(parsed, staves, 1).fifths, 0);
});

test('a clef correction applies across pages until the first clef read as something else', () => {
	// Read as treble, printed in bass; the third page really changes to alto; the fourth returns to the misread clef.
	const { pages, record } = piece([G, G, C3, G], [{ staff: 1, read: 'G2', corrected: 'F4' }]);
	const parsed = { pages, scoreDef: def('F', 4) };
	const staves = pieceStaves(parsed, record, scoreStaves(parsed));
	const first = (p: number) => /<clef>[\s\S]*?<\/clef>/.exec(staves[p].transcriptions[0][0]!)![0];
	assert.deepEqual([0, 1, 2, 3].map(first), [F, F, C3, G]);
	// The corrected pages have their notes moved: E4 on the bottom line is G2.
	assert.match(staves[1].transcriptions[0][0]!, /<step>G<\/step><octave>2<\/octave>/);
	assert.match(staves[3].transcriptions[0][0]!, /<step>E<\/step><octave>4<\/octave>/);
	// The entries themselves keep what the model read.
	assert.match(staves[1].entries[0][0]!.musicxml!, /<sign>G<\/sign>/);
});

test('each score staff opens with the clef of the first box placed on it, as read', () => {
	const { pages, record } = piece([C3, G], [{ staff: 1, read: 'C3', corrected: 'F4' }]);
	const parsed = { pages, scoreDef: def('F', 4) };
	assert.deepEqual(openingClefs(pieceStaves(parsed, record, scoreStaves(parsed)), 1), ['C3']);
	// A staff no transcribed box shows has none.
	record.pages[0].staves[0].musicxml = null;
	record.pages[1].staves[0].musicxml = null;
	assert.deepEqual(openingClefs(pieceStaves(parsed, record, scoreStaves(parsed)), 1), [null]);
});

test('a box the record describes with another box has no entry', () => {
	const { pages, record } = piece([G]);
	record.pages[0].staves[0].box = { ulx: 100, uly: 100, lrx: 900, lry: 161 };
	const parsed = { pages, scoreDef: def('G', 2) };
	const [page] = pieceStaves(parsed, record, scoreStaves(parsed));
	assert.equal(page.entries[0][0], null);
	assert.equal(page.transcriptions[0][0], null);
});

test('a placement from the record is kept, and the next system follows it', () => {
	const { pages, record } = piece([G, G]);
	record.assignments = [{ zone: 'staff-zone-1-1', staff: 2 }];
	const two: ScoreDefModel = { ...DEFAULT_SCORE_DEF, staves: [DEFAULT_SCORE_DEF.staves[0], DEFAULT_SCORE_DEF.staves[0]] };
	const parsed = { pages, scoreDef: two };
	const staves = pieceStaves(parsed, record, scoreStaves(parsed));
	assert.deepEqual(staves.map((s) => s.assigned), [[[2]], [[2]]]);
	record.assignments = [];
	assert.deepEqual(pieceStaves(parsed, record, scoreStaves(parsed)).map((s) => s.assigned), [[[1]], [[1]]]);
});
