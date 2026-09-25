import { test } from 'node:test';
import assert from 'node:assert/strict';

import { insertPageDraft } from '../omr-draft.ts';
import { buildFacsimileMei, DEFAULT_SCORE_DEF, type ZoneModel } from '../mei-facsimile.ts';

const HEAD = '   <meiHead><fileDesc><titleStmt><title>t</title></titleStmt><pubStmt/></fileDesc></meiHead>';
const box = (i: number, s: number) => ({ ulx: i * 100, uly: s * 300, lrx: i * 100 + 90, lry: s * 300 + 250 });

/** A two-page skeleton: page 1 has systems of `counts` measures, page 2 one measure. */
function skeleton(counts: number[], staffCount = 2): string {
	let label = 0;
	const zones: ZoneModel[] = counts.flatMap((c, s) =>
		Array.from({ length: c }, (_, i) => ({
			box: box(i, s),
			label: String(++label),
			pb: s === 0 && i === 0,
			sb: i === 0 && s > 0,
			mdiv: false
		}))
	);
	const scoreDef = { ...DEFAULT_SCORE_DEF, staves: Array.from({ length: staffCount }, () => DEFAULT_SCORE_DEF.staves[0]) };
	return buildFacsimileMei(
		{
			headXml: HEAD,
			scoreDef,
			pages: [
				{ image: 'img/01.jpg', width: 1000, height: 2000, zones },
				{ image: 'img/02.jpg', width: 1000, height: 2000, zones: [{ box: box(0, 0), label: String(++label), pb: true, sb: false, mdiv: false }] }
			]
		},
		{ withBreaks: true, emptyMeasures: true }
	);
}

/** A converted page as verovio would emit it: measures with staves, a slur as a control event. */
function converted(measures: number, staves = 2): string {
	const staff = (n: number, m: number) =>
		`<staff n="${n}"><layer n="1"><note xml:id="n${m}-${n}" pname="c" oct="4" dur="4"/></layer></staff>`;
	return (
		'<mei><music><body><mdiv><score><section>' +
		Array.from({ length: measures }, (_, m) =>
			`<measure n="${m + 1}">${Array.from({ length: staves }, (_, n) => staff(n + 1, m + 1)).join('')}<slur startid="#n${m + 1}-1" endid="#n${m + 1}-2"/></measure>`
		).join('') +
		'</section></score></mdiv></body></music></mei>'
	);
}

/** Per system, every staff 1…staffCount printed, on zones named `z<system>-<n>`. */
const allPrinted = (systems: number, staffCount = 2) =>
	Array.from({ length: systems }, (_, s) => new Map(Array.from({ length: staffCount }, (_, i) => [i + 1, `z${s + 1}-${i + 1}`])));

test('each skeleton measure of the page takes the converted measure of the same system and position', () => {
	const result = insertPageDraft(skeleton([2, 2]), 'surface-1', converted(4), [2, 2], allPrinted(2));
	assert.equal(result.filled, 4);
	assert.deepEqual(result.warnings, []);
	// Skeleton tags stay; the content is the converted one, control events included.
	assert.match(result.mei, /<measure xml:id="measure-1" n="1" facs="#zone-1-1">\s*<staff n="1" facs="#z1-1"><layer n="1"><note xml:id="n1-1"/);
	assert.equal((result.mei.match(/<slur /g) ?? []).length, 4);
	// Page 2 is untouched: its measure keeps its empty layers.
	assert.match(result.mei, /<measure xml:id="measure-5" n="5" facs="#zone-2-1">\s*<staff xml:id="[^"]*" n="1">\s*<layer xml:id="[^"]*" n="1"\/>/);
	// The breaks are untouched.
	assert.equal((result.mei.match(/<pb /g) ?? []).length, 2);
	assert.equal((result.mei.match(/<sb /g) ?? []).length, 1);
});

test('mismatched systems are filled as far as they go and reported', () => {
	// Skeleton: 3 + 1 boxes; transcribed: 2 + 2 measures.
	const result = insertPageDraft(skeleton([3, 1]), 'surface-1', converted(4), [2, 2], allPrinted(2));
	assert.equal(result.filled, 3);
	assert.deepEqual(result.warnings, [
		'Page 1, system 1: 3 measure box(es), 2 measure(s) transcribed.',
		'Page 1, system 2: 1 measure box(es), 2 measure(s) transcribed.'
	]);
	// The third box of system 1 stays empty; system 2's box takes the first measure of transcribed system 2.
	assert.match(result.mei, /<measure xml:id="measure-3" n="3" facs="#zone-1-3">\s*<staff xml:id="[^"]*" n="1">\s*<layer xml:id="[^"]*" n="1"\/>/);
	assert.match(result.mei, /<measure xml:id="measure-4" n="4" facs="#zone-1-4">\s*<staff n="1" facs="#z2-1"><layer n="1"><note xml:id="n3-1"/);
});

test('a differing system count is refused', () => {
	assert.throws(
		() => insertPageDraft(skeleton([2], 1), 'surface-1', converted(2, 2), [1, 1], allPrinted(2, 1)),
		/Page 1: 1 system\(s\) of measure boxes, 2 transcribed\./
	);
});

test('staves beyond the score definition are dropped', () => {
	const result = insertPageDraft(skeleton([2], 1), 'surface-1', converted(2, 2), [2], allPrinted(1, 1));
	assert.equal(result.filled, 2);
	assert.ok(result.warnings.includes("Page 1: staves beyond the score definition's 1 were left out."));
	// The converted second staves were dropped; the skeleton itself has one staff per measure.
	assert.equal((result.mei.match(/<staff n="2"/g) ?? []).length, 0);
});

test('a page the skeleton does not have is an error', () => {
	assert.throws(() => insertPageDraft(skeleton([1]), 'surface-9', converted(1), [1], allPrinted(1)), /No page break found for surface-9/);
});

test('a staff the system does not print rests; a printed staff links its zone', () => {
	// System 2 prints staff 2 only.
	const printed = [new Map([[1, 'a'], [2, 'b']]), new Map([[2, 'c']])];
	const result = insertPageDraft(skeleton([1, 1]), 'surface-1', converted(2), [1, 1], printed);
	const measure = (n: number) => new RegExp(`<measure[^>]* n="${n}"[^>]*>([\\s\\S]*?)</measure>`).exec(result.mei)![1];
	assert.match(measure(1), /<staff n="1" facs="#a"><layer n="1"><note xml:id="n1-1"/);
	assert.match(measure(2), /<staff n="1"><layer n="1"><mRest\/><\/layer><\/staff>/);
	assert.match(measure(2), /<staff n="2" facs="#c"><layer n="1"><note xml:id="n2-2"/);
	// Control events follow the staves.
	assert.match(measure(2), /<\/staff>\n<slur /);
});

test('a self-closing converted staff does not swallow the staff after it', () => {
	const converted = '<mei><section><measure n="1"><staff n="1"/><staff n="2"><layer n="1"><note xml:id="x2" pname="c" oct="4" dur="1"/></layer></staff></measure></section></mei>';
	const result = insertPageDraft(skeleton([1]), 'surface-1', converted, [1], allPrinted(1));
	assert.match(result.mei, /<staff n="1" facs="#z1-1"><layer n="1"\/><\/staff>/);
	assert.match(result.mei, /<staff n="2" facs="#z1-2"><layer n="1"><note xml:id="x2"/);
});

test('a clef verovio put inside a tremolo follows the tremolo', () => {
	const converted =
		'<mei><section><measure n="1"><staff n="1"><layer n="1"><bTrem><note xml:id="t1" pname="c" oct="4" dur="2"/>' +
		'<clef shape="F" line="4"/></bTrem></layer></staff></measure></section></mei>';
	const result = insertPageDraft(skeleton([1], 1), 'surface-1', converted, [1], allPrinted(1, 1));
	assert.match(result.mei, /<bTrem><note xml:id="t1" pname="c" oct="4" dur="2"\/><\/bTrem><clef shape="F" line="4"\/><\/layer>/);
});

test('the page opening puts its clefs first in the page\'s first layers and its key and meter before the first measure', () => {
	const result = insertPageDraft(skeleton([1, 1]), 'surface-1', converted(2), [1, 1], allPrinted(2), {
		clefs: [null, 'G2-1'],
		fifths: -3,
		time: { beats: '6', beatType: '8', symbol: '' }
	});
	assert.match(
		result.mei,
		/<scoreDef><keySig sig="3f"\/><meterSig count="6" unit="8"\/><\/scoreDef><measure xml:id="measure-1"/
	);
	assert.match(result.mei, /<staff n="2" facs="#z1-2"><layer n="1"><clef shape="G" line="2" dis="8" dis.place="below"\/><note xml:id="n1-2"/);
	assert.equal((result.mei.match(/<clef /g) ?? []).length, 1);
	assert.equal((result.mei.match(/<scoreDef>/g) ?? []).length, 1);
});

test('a key or meter change verovio writes before a measure goes before the skeleton measure it fills', () => {
	const converted =
		'<mei><score><scoreDef><keySig sig="0"/></scoreDef><section>' +
		'<measure n="1"><staff n="1"><layer n="1"/></staff></measure><sb/>' +
		'<scoreDef ppq="8"/><scoreDef ppq="4"><keySig sig="1f"/></scoreDef><measure n="2"><staff n="1"><layer n="1"/></staff></measure>' +
		'</section></score></mei>';
	const result = insertPageDraft(skeleton([1, 1], 1), 'surface-1', converted, [1, 1], allPrinted(2, 1));
	// The document's own scoreDef is not taken; the change lands between the system break and measure 2.
	assert.doesNotMatch(result.mei, /keySig sig="0"/);
	assert.match(result.mei, /<sb [^>]*\/>\s*<scoreDef><keySig sig="1f"\/><\/scoreDef><measure xml:id="measure-2"/);
});

test('a staff the system does not print keeps the clef change verovio placed on it', () => {
	const converted =
		'<mei><section><measure n="1"><staff n="1"><layer n="1"><note xml:id="c1" pname="c" oct="4" dur="1"/></layer></staff>' +
		'<staff n="2"><layer n="1"><clef shape="C" line="3"/></layer></staff></measure></section></mei>';
	const result = insertPageDraft(skeleton([1]), 'surface-1', converted, [1], [new Map([[1, 'a']])]);
	assert.match(result.mei, /<staff n="2"><layer n="1"><mRest\/><clef shape="C" line="3"\/><\/layer><\/staff>/);
});
