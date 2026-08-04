import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splicePage, splicePageSpan } from '../mei-page-splice.ts';
import {
	initialFacsimileModel,
	buildBlankScoreMei,
	buildFacsimileMei,
	buildMeiHead,
	type FacsimilePage
} from '../mei-facsimile.ts';

// Two pages: page 1 with 2 measures, page 2 with 3, laid out as single rows so
// reading order is simple. Boxes are pixel-space and non-overlapping.
const box = (uly: number, i: number) => ({ ulx: 100 * i, uly, lrx: 100 * i + 90, lry: uly + 80 });
const PAGES: FacsimilePage[] = [
	{ image: 'img/01.jpg', width: 400, height: 200, measures: [box(10, 0), box(10, 1)] },
	{ image: 'img/02.jpg', width: 400, height: 200, measures: [box(10, 0), box(10, 1), box(10, 2)] }
];

// A stage-C score (measures, breaks) as it stands in the repo after the
// measure-correction pre-task; every measure holds an <mRest/>.
const base = buildFacsimileMei(initialFacsimileModel(PAGES), { withBreaks: true });
// A fork that "encoded" every page: each <mRest/> became a note.
const forkAll = base.replaceAll('<mRest/>', '<note dur="4" oct="4" pname="c"/>');

test('splicePage takes only the target page\'s measures from the fork', () => {
	const spliced = splicePage(base, forkAll, 'surface-2');
	// Page 1 (2 measures) stays as it is in the base; page 2 (3) takes the fork.
	assert.equal((spliced.match(/<mRest\/>/g) ?? []).length, 2);
	assert.equal((spliced.match(/<note /g) ?? []).length, 3);
	// Structure around the untouched page is byte-identical to the base.
	assert.ok(spliced.includes('<measure xml:id="measure-1"'));
	assert.ok(spliced.includes('<pb xml:id="pb-1"') && spliced.includes('<pb xml:id="pb-2"'));
});

test('splicePage leaves the base untouched when nothing on the page changed', () => {
	assert.equal(splicePage(base, base, 'surface-1'), base);
});

test('splicePage throws when the page break is missing', () => {
	assert.throws(() => splicePage(base, forkAll, 'surface-9'), /No page break found/);
});

test('splicePage throws when the fork dropped a measure the page carries', () => {
	// Remove page 2's last measure (measure-5) from the fork.
	const forkMissing = forkAll.replace(/<measure xml:id="measure-5"[\s\S]*?<\/measure>\n?/, '');
	assert.throws(() => splicePage(base, forkMissing, 'surface-2'), /missing measure measure-5/);
});

// A physical piece's blank score: no facsimile, one seed measure per page.
// Its pages have no fixed measure grid, so they are joined span-wise.
const blank = buildBlankScoreMei(buildMeiHead({ title: 'Blank' }), 2);
// A fork that transcribed page 2 into three real measures.
const blankFork = blank.replace(
	/<measure xml:id="measure-2"[\s\S]*?<\/measure>/,
	'<measure xml:id="m-a" n="1"><staff n="1"><layer n="1"><note dur="4" oct="4" pname="c"/></layer></staff></measure>\n' +
		'<measure xml:id="m-b" n="2"><staff n="1"><layer n="1"><note dur="4" oct="4" pname="d"/></layer></staff></measure>\n' +
		'<measure xml:id="m-c" n="3"><staff n="1"><layer n="1"><note dur="4" oct="4" pname="e"/></layer></staff></measure>'
);

test('splicePageSpan takes the whole page span from the fork, added measures included', () => {
	const spliced = splicePageSpan(blank, blankFork, 'surface-2');
	// Page 1 keeps its seed measure; page 2 carries the fork's three measures.
	assert.ok(spliced.includes('<measure xml:id="measure-1"'));
	assert.ok(!spliced.includes('<measure xml:id="measure-2"'));
	assert.equal((spliced.match(/<note /g) ?? []).length, 3);
	// The enclosing section markup survives the last page's replacement.
	assert.ok(spliced.includes('</section>'));
	assert.ok(spliced.includes('<pb xml:id="pb-2"'));
});

test('splicePageSpan leaves other pages as the base has them', () => {
	// The fork also "changed" page 1, but only page 2 is being submitted.
	const forkBoth = blankFork.replace(
		/<measure xml:id="measure-1"[\s\S]*?<\/measure>/,
		'<measure xml:id="m-x" n="0"><staff n="1"><layer n="1"><note dur="4" oct="4" pname="g"/></layer></staff></measure>'
	);
	const spliced = splicePageSpan(blank, forkBoth, 'surface-2');
	assert.ok(spliced.includes('<measure xml:id="measure-1"'));
	assert.ok(!spliced.includes('m-x'));
});

test('splicePageSpan throws when either side is missing the page break', () => {
	assert.throws(() => splicePageSpan(blank, blankFork, 'surface-9'), /No page break found/);
	const forkNoPb = blankFork.replace(/<pb xml:id="pb-2"[^>]*>/, '');
	assert.throws(() => splicePageSpan(blank, forkNoPb, 'surface-2'), /No page break found/);
});
