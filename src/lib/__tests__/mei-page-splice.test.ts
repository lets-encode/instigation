import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertSpliceIntegrity, splicePage, splicePageSpan } from '../mei-page-splice.ts';
import {
	initialFacsimileModel,
	buildBlankScoreMei,
	buildFacsimileMei,
	type FacsimilePage
} from '../mei-facsimile.ts';
import { buildPieceHead, emptySourceMetadata } from '../source-metadata.ts';

const HEAD = buildPieceHead({ title: 'Blank', composer: '' }, emptySourceMetadata(), {
	date: '2026-08-14'
});

// Two pages: page 1 with 2 measures, page 2 with 3, laid out as single rows so
// reading order is simple. Boxes are pixel-space and non-overlapping.
const box = (uly: number, i: number) => ({ ulx: 100 * i, uly, lrx: 100 * i + 90, lry: uly + 80 });
const PAGES: FacsimilePage[] = [
	{ image: 'img/01.jpg', width: 400, height: 200, measures: [box(10, 0), box(10, 1)] },
	{ image: 'img/02.jpg', width: 400, height: 200, measures: [box(10, 0), box(10, 1), box(10, 2)] }
];

// A stage-C score (measures, breaks) as it stands in the repo after the
// measure-correction pre-task; every measure holds an <mRest/>.
const base = buildFacsimileMei({ ...initialFacsimileModel(PAGES), headXml: HEAD }, { withBreaks: true });
// A fork that "encoded" every page: each <mRest/> became a note.
const forkAll = base.replace(/<mRest\b[^>]*\/>/g, '<note dur="4" oct="4" pname="c"/>');

test('splicePage takes only the target page\'s span from the fork', () => {
	const spliced = splicePage(base, forkAll, 'surface-2');
	// Page 1 (2 measures) stays as it is in the base; page 2 (3) takes the fork.
	assert.equal((spliced.match(/<mRest\b/g) ?? []).length, 2);
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

test('splicePage keeps a scoreDef the fork added between measures', () => {
	// A mid-piece meter change on page 2, between its first and second measure.
	const scoreDef = '<scoreDef xml:id="msd-1" meter.count="3" meter.unit="4"/>';
	const forkWithScoreDef = forkAll.replace(
		'<measure xml:id="measure-4"',
		`${scoreDef}\n               <measure xml:id="measure-4"`
	);
	const spliced = splicePage(base, forkWithScoreDef, 'surface-2');
	assert.ok(spliced.includes(scoreDef), 'the inter-measure scoreDef survives the splice');
});

test('splicePage keeps a measure the fork added on the page', () => {
	const added =
		'<measure xml:id="measure-added" n="3a"><staff n="1"><layer n="1">' +
		'<note dur="4" oct="4" pname="e"/></layer></staff></measure>';
	const forkWithAdded = forkAll.replace(
		/(<measure xml:id="measure-5"[\s\S]*?<\/measure>)/,
		`$1\n               ${added}`
	);
	const spliced = splicePage(base, forkWithAdded, 'surface-2');
	assert.ok(spliced.includes('measure-added'));
	assert.equal((spliced.match(/<measure /g) ?? []).length, 6);
});

test('splicePage drops a measure the fork removed from the page', () => {
	const forkMissing = forkAll.replace(/<measure xml:id="measure-5"[\s\S]*?<\/measure>\n?/, '');
	const spliced = splicePage(base, forkMissing, 'surface-2');
	assert.ok(!spliced.includes('measure-5'));
	assert.equal((spliced.match(/<measure /g) ?? []).length, 4);
});

test('splicePage rejects a fork span smuggling a page break for another surface', () => {
	// An extra <pb> for surface 1 inside page 2's span would duplicate it.
	const forkSmuggled = forkAll.replace(
		'<measure xml:id="measure-4"',
		'<pb xml:id="pb-x" n="1" facs="#surface-1"/>\n               <measure xml:id="measure-4"'
	);
	assert.throws(() => splicePage(base, forkSmuggled, 'surface-2'), /2 page breaks for surface-1/);
});

test('splicePage rejects a fork span smuggling a page break the base does not have', () => {
	const forkSmuggled = forkAll.replace(
		'<measure xml:id="measure-4"',
		'<pb xml:id="pb-x" n="9" facs="#surface-9"/>\n               <measure xml:id="measure-4"'
	);
	assert.throws(
		() => splicePage(base, forkSmuggled, 'surface-2'),
		/page break for surface-9 the base score does not have/
	);
});

test('splicePage rejects a fork whose page duplicates another page\'s measure id', () => {
	// Page 2's first measure renamed to page 1's measure-1: two measure-1s.
	const forkDuplicate = forkAll.replace('<measure xml:id="measure-3"', '<measure xml:id="measure-1"');
	assert.throws(
		() => splicePage(base, forkDuplicate, 'surface-2'),
		/Duplicate measure xml:id "measure-1" after splicing surface-2/
	);
});

test('assertSpliceIntegrity passes an untouched score', () => {
	assertSpliceIntegrity(base, base, 'surface-1');
});

// A physical piece's blank score: no facsimile, one seed measure per page.
// Its pages have no fixed measure grid, so they are joined span-wise.
const blank = buildBlankScoreMei(HEAD, 2);
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

test('splicePageSpan rejects duplicated measure ids across pages', () => {
	// The fork transcribed page 2 reusing page 1's seed measure id.
	const forkDuplicate = blankFork.replace('<measure xml:id="m-a"', '<measure xml:id="measure-1"');
	assert.throws(
		() => splicePageSpan(blank, forkDuplicate, 'surface-2'),
		/Duplicate measure xml:id "measure-1" after splicing surface-2/
	);
});

test('the last page\'s span ends at the enclosing close, nested sections included', () => {
	// The fork transcribed page 2 as a nested section: its inner </section> must
	// not end the span early, or the trailing measure would be dropped.
	const nested =
		'<section xml:id="s-inner"><measure xml:id="m-a" n="1"><staff n="1"><layer n="1">' +
		'<note dur="4" oct="4" pname="c"/></layer></staff></measure></section>\n' +
		'               <measure xml:id="m-b" n="2"><staff n="1"><layer n="1">' +
		'<note dur="4" oct="4" pname="d"/></layer></staff></measure>';
	const forkNested = blank.replace(/<measure xml:id="measure-2"[\s\S]*?<\/measure>/, nested);
	const spliced = splicePageSpan(blank, forkNested, 'surface-2');
	assert.ok(spliced.includes('s-inner'));
	assert.ok(spliced.includes('m-b'), 'the measure after the nested section survives');
	// The enclosing structure is kept from the base, not doubled.
	assert.equal((spliced.match(/<\/score>/g) ?? []).length, 1);
	assert.equal((spliced.match(/<\/mdiv>/g) ?? []).length, 1);
});
