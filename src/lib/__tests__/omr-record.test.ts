import { test } from 'node:test';
import assert from 'node:assert/strict';

import { entryFor, omrRecordPath, parseOmrRecord, serializeOmrRecord, type OmrRecord } from '../omr-record.ts';

const PIPELINE = { name: 'mzk-staff', version: '1' };
const OCR = { engine: 'tesseract.js', version: '7.0.0', language: 'deu+eng' };
// A staff transcription with the elements whose names the record's own share a prefix with.
const MUSICXML =
	`<?xml version='1.0' encoding='utf-8'?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
	`<score-partwise version="4.0"><defaults><page-layout/></defaults><part-list><score-part id="P1"/></part-list><part id="P1"><measure>` +
	`<attributes><staves>1</staves><clef><sign>G</sign><line>2</line></clef><staff-details/></attributes>` +
	`<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><staff>1</staff></note></measure></part></score-partwise>`;

const record = (): OmrRecord => ({
	cropMargin: 0.9,
	staffPipeline: PIPELINE,
	ocr: OCR,
	pages: [
		{
			n: 3,
			image: '../pages/p003.jpg',
			staves: [
				{ zone: 'staff-zone-3-1', box: { ulx: 212, uly: 388, lrx: 1810, lry: 452 }, label: 'Vl. I & "II"', musicxml: MUSICXML, error: '' },
				{ zone: 'staff-zone-3-2', box: { ulx: 212, uly: 540, lrx: 1810, lry: 604 }, label: '', musicxml: null, error: 'pipeline execution failed' },
				{ zone: 'staff-zone-3-3', box: { ulx: 212, uly: 700, lrx: 1810, lry: 764 }, label: 'Vc.', musicxml: null, error: 'pipeline execution failed' }
			]
		},
		{ n: 4, image: '../pages/p004.jpg', staves: [] }
	],
	assignments: [{ zone: 'staff-zone-4-7', staff: 3 }],
	clefs: [{ staff: 3, read: 'G2', corrected: 'F4' }]
});

test('a record survives writing and reading', () => {
	const xml = serializeOmrRecord(record());
	const back = parseOmrRecord(xml)!;
	const expected = record();
	// The MusicXML comes back without its DOCTYPE, with a declaration of its own.
	expected.pages[0].staves[0].musicxml = '<?xml version="1.0" encoding="UTF-8"?>\n' + MUSICXML.slice(MUSICXML.indexOf('<score-partwise'));
	assert.deepEqual(back, expected);
	assert.doesNotMatch(xml, /DOCTYPE|encoding='utf-8'/);
	assert.match(xml, /<staff zone="staff-zone-3-2" ulx="212" uly="540" lrx="1810" lry="604" error="pipeline execution failed"\/>/);
});

test('another schema or no file reads as no record', () => {
	assert.equal(parseOmrRecord(null), null);
	assert.equal(parseOmrRecord('<omr schema="2"></omr>'), null);
});

test('an entry is reused only for the same zone, box, pipeline and crop margin', () => {
	const r = record();
	const box = { ulx: 212, uly: 388, lrx: 1810, lry: 452 };
	assert.equal(entryFor(r, 'staff-zone-3-1', box, PIPELINE, 0.9)?.label, 'Vl. I & "II"');
	assert.equal(entryFor(r, 'staff-zone-3-1', { ...box, lry: 453 }, PIPELINE, 0.9), null);
	assert.equal(entryFor(r, 'staff-zone-3-1', box, { ...PIPELINE, version: '2' }, 0.9), null);
	assert.equal(entryFor(r, 'staff-zone-3-1', box, PIPELINE, 1), null);
	assert.equal(entryFor(r, 'staff-zone-9-1', box, PIPELINE, 0.9), null);
	assert.equal(entryFor(null, 'staff-zone-3-1', box, PIPELINE, 0.9), null);
});

test('the record sits next to the score', () => {
	assert.equal(omrRecordPath('sources/liszt/score.mei'), 'sources/liszt/omr.xml');
});
