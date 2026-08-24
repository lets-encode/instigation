import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntaxValidator } from 'fast-xml-validator';
import {
	buildBlankScoreMei,
	buildFacsimileMei,
	initialFacsimileModel,
	parseFacsimileMei,
	parseScoreDef,
	relinkFacsimileImages,
	sortReadingOrder,
	nextLabel,
	DEFAULT_SCORE_DEF,
	type FacsimilePage,
	type FacsimileModel,
	type ScoreDefModel
} from '../mei-facsimile.ts';

// A minimal header for the generated scores; production headers come from
// buildPieceHead (source-metadata.ts).
const HEAD = '   <meiHead xml:id="head-1">\n      <fileDesc xml:id="fileDesc-1"/>\n   </meiHead>';

const twoPages: FacsimilePage[] = [
	{
		image: 'img/01.jpg',
		width: 2000,
		height: 2581,
		measures: [
			{ ulx: 127, uly: 259, lrx: 1036, lry: 804 },
			{ ulx: 142, uly: 767, lrx: 1016, lry: 1334 }
		]
	},
	{
		image: 'img/02.jpg',
		width: 2000,
		height: 2581,
		measures: [{ ulx: 238, uly: 244, lrx: 1005, lry: 790 }]
	}
];

const model = () => ({ ...initialFacsimileModel(twoPages), headXml: HEAD });

test('stage A: surfaces, graphics and labelled zones — no measures, no breaks', () => {
	const mei = buildFacsimileMei(model());
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.equal((mei.match(/<surface /g) ?? []).length, 2);
	assert.equal((mei.match(/<graphic /g) ?? []).length, 2);
	assert.equal((mei.match(/<zone /g) ?? []).length, 3);
	assert.equal((mei.match(/<measure /g) ?? []).length, 0);
	assert.equal((mei.match(/<pb /g) ?? []).length, 0);
	assert.ok(mei.includes('target="img/01.jpg"'));
	// Zones carry their measure labels, numbered continuously across pages.
	assert.ok(mei.includes('<zone xml:id="zone-1-1" type="measure" n="1"'));
	assert.ok(mei.includes('<zone xml:id="zone-2-1" type="measure" n="3"'));
});

test('stage C: a pb per page, an sb per flagged measure (except page starts)', () => {
	const m = model();
	// Page 1's two boxes are two systems (stacked), so its second measure is a
	// system start — expect one <sb/> for it; page firsts are covered by <pb/>.
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.equal((mei.match(/<pb /g) ?? []).length, 2);
	assert.equal((mei.match(/<sb /g) ?? []).length, 1);
	assert.equal((mei.match(/<measure /g) ?? []).length, 3);
	assert.ok(/<pb[^>]*facs="#surface-1"/.test(mei));
});

test('volta labels: alphanumeric labels are emitted and nextLabel advances their leading number', () => {
	const m = model();
	m.pages[0].zones[1].label = '1a';
	// Automatic numbering derives the next label from the previous one.
	assert.equal(nextLabel('1a'), '2');
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.ok(mei.includes('n="1a" facs="#zone-1-2"'));
});

test('parseFacsimileMei rejects input without an MEI header', () => {
	assert.throws(() => parseFacsimileMei('<mei><music/></mei>'), /no <meiHead>/);
});

test('parseFacsimileMei round-trips the model through both active stages', () => {
	const m = model();
	m.pages[0].zones[1].label = '1a';

	const stageA = parseFacsimileMei(buildFacsimileMei(m));
	assert.equal(stageA.hasMeasures, false);
	assert.equal(stageA.pages.length, 2);
	assert.deepEqual(
		stageA.pages[0].zones.map((z) => z.label),
		['1', '1a']
	);
	assert.deepEqual(stageA.pages[0].zones[0].box, { ulx: 127, uly: 259, lrx: 1036, lry: 804 });

	const stageC = parseFacsimileMei(buildFacsimileMei(m, { withBreaks: true }));
	assert.equal(stageC.hasMeasures, true);
	assert.equal(stageC.hasBreaks, true);
	// The system flags survive: page 1's second measure starts a system.
	assert.equal(stageC.pages[0].zones[1].sb, true);

	// Rebuilding from the parsed model reproduces the file byte-for-byte.
	const rebuilt = buildFacsimileMei(
		{ headXml: stageC.headXml, pages: stageC.pages } satisfies FacsimileModel,
		{ withBreaks: true }
	);
	assert.equal(rebuilt, buildFacsimileMei(m, { withBreaks: true }));
});

test('movements: a flagged zone opens a new <mdiv>; flags round-trip', () => {
	const m = model();
	// Page 2's measure starts a new movement.
	m.pages[1].zones[0].mdiv = true;
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal((mei.match(/<mdiv /g) ?? []).length, 2);
	assert.equal((mei.match(/<scoreDef\b/g) ?? []).length, 2);
	// The second movement holds page 2's break and measure.
	const second = mei.slice(mei.indexOf('<mdiv xml:id="mdiv-2"'));
	assert.ok(/<pb[^>]*facs="#surface-2"/.test(second));
	assert.ok(second.includes('facs="#zone-2-1"'));

	const parsed = parseFacsimileMei(mei);
	assert.equal(parsed.pages[1].zones[0].mdiv, true);
	assert.equal(parsed.pages[0].zones[0].mdiv, false);
	const rebuilt = buildFacsimileMei(
		{ headXml: parsed.headXml, pages: parsed.pages },
		{ withBreaks: true }
	);
	assert.equal(rebuilt, mei);
});

test('a page break implies the system break: a pb measure emits <pb> only, and can still open a movement', () => {
	const m = model();
	// Page 2's first measure carries the page break (default) and starts a new
	// movement; its system break is implied by the pb, so no <sb/> is written.
	m.pages[1].zones[0].mdiv = true;
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal(SyntaxValidator.validate(mei), true);
	// Nothing between page 2's <pb> and its measure — no redundant <sb>.
	const second = mei.slice(mei.indexOf('<mdiv xml:id="mdiv-2"'));
	const beforeMeasure = second.slice(0, second.indexOf('facs="#zone-2-1"'));
	assert.ok(/<pb[^>]*facs="#surface-2"/.test(beforeMeasure));
	assert.ok(!/<sb\b/.test(beforeMeasure));

	const parsed = parseFacsimileMei(mei);
	const z = parsed.pages[1].zones[0];
	assert.equal(z.pb, true);
	assert.equal(z.sb, false);
	assert.equal(z.mdiv, true);
	const rebuilt = buildFacsimileMei({ headXml: parsed.headXml, pages: parsed.pages }, { withBreaks: true });
	assert.equal(rebuilt, mei);
});

test('breaks carry @n: a page break its page number, a system break its order', () => {
	const m = model();
	// Page 1 measure 1 opens page 1, page 2 measure 1 opens page 2; page 1's
	// second measure is the only explicit system break (sb #1).
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.ok(/<pb xml:id="pb-1" n="1"/.test(mei));
	assert.ok(/<pb xml:id="pb-2" n="2"/.test(mei));
	assert.ok(/<sb xml:id="sb-1-2" n="1"/.test(mei));
});

test('movements: the first zone never opens a second <mdiv>', () => {
	const m = model();
	m.pages[0].zones[0].mdiv = true;
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.equal((mei.match(/<mdiv /g) ?? []).length, 1);
});

test('escapes markup-significant characters in labels and targets', () => {
	const m = model();
	m.pages[0].image = 'img/d\'un & "co".jpg';
	m.pages[0].zones[0].label = '1 & <2>';
	const mei = buildFacsimileMei(m, { withBreaks: true });
	assert.match(mei, /target="img\/d'un &amp; &quot;co&quot;\.jpg"/);
	assert.match(mei, /n="1 &amp; &lt;2&gt;"/);
	// The values round-trip through the parser.
	const parsed = parseFacsimileMei(mei);
	assert.equal(parsed.pages[0].image, 'img/d\'un & "co".jpg');
	assert.equal(parsed.pages[0].zones[0].label, '1 & <2>');
});

test('an attribute carrying &apos; round-trips without double escaping', () => {
	// An externally authored file may escape the apostrophe; a rebuild must
	// emit it plainly, not re-escape the entity to &amp;apos;.
	const withApos = buildFacsimileMei(model(), { withBreaks: true }).replace(
		'type="measure" n="1"',
		'type="measure" n="l&apos;istesso"'
	);
	const parsed = parseFacsimileMei(withApos);
	assert.equal(parsed.pages[0].zones[0].label, "l'istesso");
	const rebuilt = buildFacsimileMei(
		{ headXml: parsed.headXml, pages: parsed.pages },
		{ withBreaks: true }
	);
	assert.ok(rebuilt.includes(`n="l'istesso"`));
	assert.ok(!rebuilt.includes('&amp;apos;'));
});

test('sortReadingOrder groups systems top-to-bottom and orders each left-to-right', () => {
	// Two systems, boxes handed in shuffled; expect row-major reading order.
	const shuffled = [
		{ ulx: 0.5, uly: 0.6, lrx: 0.7, lry: 0.9 }, // row 2, middle
		{ ulx: 0.5, uly: 0.1, lrx: 0.7, lry: 0.4 }, // row 1, middle
		{ ulx: 0.1, uly: 0.11, lrx: 0.3, lry: 0.4 }, // row 1, left
		{ ulx: 0.1, uly: 0.62, lrx: 0.3, lry: 0.9 }, // row 2, left
		{ ulx: 0.8, uly: 0.09, lrx: 0.95, lry: 0.4 } // row 1, right
	];
	const ordered = sortReadingOrder(shuffled);
	assert.deepEqual(
		ordered.map((b) => [b.ulx, b.uly]),
		[
			[0.1, 0.11],
			[0.5, 0.1],
			[0.8, 0.09],
			[0.1, 0.62],
			[0.5, 0.6]
		]
	);
});

test('a page with no detected measures still emits its surface', () => {
	const mei = buildFacsimileMei(
		initialFacsimileModel([{ image: 'img/01.jpg', width: 800, height: 600, measures: [] }])
	);
	assert.equal((mei.match(/<surface /g) ?? []).length, 1);
	assert.equal((mei.match(/<zone /g) ?? []).length, 0);
});

test('parseFacsimileMei reads a body that carries attributes', () => {
	const mei =
		`<mei><meiHead><fileDesc/></meiHead><music><body xml:id="b1"><mdiv><score><section>` +
		`<pb xml:id="p1" facs="#z1"/><measure xml:id="m1" facs="#z1" n="1"/>` +
		`</section></score></mdiv></body></music>` +
		`<facsimile><surface ulx="0" uly="0" lrx="799" lry="599">` +
		`<graphic target="img/01.jpg" width="800" height="600"/>` +
		`<zone xml:id="z1" type="measure" ulx="10" uly="20" lrx="110" lry="120"/>` +
		`</surface></facsimile></mei>`;
	const parsed = parseFacsimileMei(mei);
	assert.equal(parsed.hasMeasures, true);
	assert.equal(parsed.hasBreaks, true);
	assert.equal(parsed.pages[0].zones[0].pb, true);
});

test('relinkFacsimileImages retargets each surface and scales it to the image', () => {
	const mei =
		`<facsimile><surface xml:id="s1" ulx="0" uly="0" lrx="1999" lry="2580">` +
		`<graphic xml:id="g1" height="2581" target="img/01.jpg" width="2000"/>` +
		`<zone xml:id="z1" type="measure" ulx="200" uly="258" lrx="1000" lry="1290"/>` +
		`</surface><surface xml:id="s2">` +
		`<graphic xml:id="g2" target="img/02.jpg" width="2000" height="2581"/>` +
		`</surface></facsimile>`;
	// Half the width and height the encoding was authored against.
	const relinked = relinkFacsimileImages(mei, [
		{ target: '../img/01.jpg', width: 1000, height: 1290 }
	]);
	assert.match(relinked, /<graphic xml:id="g1" height="1290" target="\.\.\/img\/01\.jpg" width="1000"\/>/);
	assert.match(relinked, /<zone xml:id="z1" type="measure" ulx="100" uly="129" lrx="500" lry="645"\/>/);
	assert.match(relinked, /<surface xml:id="s1" ulx="0" uly="0" lrx="1000" lry="1290">/);
	// A surface past the end of the sequence is left alone.
	assert.match(relinked, /<graphic xml:id="g2" target="img\/02\.jpg" width="2000" height="2581"\/>/);
});

test('a self-closing surface is complete: the surface after it still parses', () => {
	const mei =
		`<mei><meiHead><fileDesc/></meiHead><music/>` +
		`<facsimile><surface xml:id="s1" n="1"/>` +
		`<surface xml:id="s2" n="2">` +
		`<graphic target="img/02.jpg" width="800" height="600"/>` +
		`<zone xml:id="z1" type="measure" ulx="10" uly="20" lrx="110" lry="120"/>` +
		`</surface></facsimile></mei>`;
	const parsed = parseFacsimileMei(mei);
	// The self-closing surface has no graphic and yields no page; the one
	// following it must not be swallowed by its match.
	assert.equal(parsed.pages.length, 1);
	assert.equal(parsed.pages[0].image, 'img/02.jpg');
	assert.equal(parsed.pages[0].zones.length, 1);
});

test('relinkFacsimileImages leaves a self-closing surface as it is', () => {
	const mei =
		`<facsimile><surface xml:id="s1"/>` +
		`<surface xml:id="s2"><graphic target="img/02.jpg" width="100" height="100"/></surface></facsimile>`;
	const relinked = relinkFacsimileImages(mei, [
		{ target: '../img/01.jpg', width: 50, height: 50 },
		{ target: '../img/02.jpg', width: 50, height: 50 }
	]);
	assert.ok(relinked.includes('<surface xml:id="s1"/>'));
	assert.match(relinked, /<graphic target="\.\.\/img\/02\.jpg" width="50" height="50"\/>/);
});

test('relinkFacsimileImages leaves a surface whose graphic declares no size', () => {
	const mei = `<facsimile><surface><graphic target="img/01.jpg"/><zone ulx="10" uly="20" lrx="30" lry="40"/></surface></facsimile>`;
	const relinked = relinkFacsimileImages(mei, [{ target: '../img/01.jpg', width: 800, height: 600 }]);
	assert.match(relinked, /<zone ulx="10" uly="20" lrx="30" lry="40"\/>/);
	assert.match(relinked, /target="\.\.\/img\/01\.jpg"/);
	assert.match(relinked, /width="800"/);
});

test('buildBlankScoreMei: one pb and one seed measure per page, no facsimile', () => {
	const mei = buildBlankScoreMei(HEAD, 3);
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.ok(!mei.includes('<facsimile>'));
	assert.equal((mei.match(/<pb /g) ?? []).length, 3);
	assert.ok(mei.includes('facs="#surface-2"'));
	assert.equal((mei.match(/<measure /g) ?? []).length, 3);
	// The parser sees encoded breaks and measures but no facsimile pages, which
	// is what makes the console preview paginate on the pb markers.
	const parsed = parseFacsimileMei(mei);
	assert.equal(parsed.pages.length, 0);
	assert.equal(parsed.hasBreaks, true);
	assert.equal(parsed.hasMeasures, true);
});

test('buildBlankScoreMei without a page count seeds a single unpaged measure', () => {
	const mei = buildBlankScoreMei(HEAD, 0);
	assert.equal(SyntaxValidator.validate(mei), true);
	assert.ok(!mei.includes('<pb '));
	assert.equal((mei.match(/<measure /g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// Score definition (score-setup pre-task)

const PLAIN = { clefDis: '', clefDisPlace: '', lines: 5, notationType: '' };

const THREE_STAVES: ScoreDefModel = {
	staves: [
		{ clefShape: 'G', clefLine: 2, ...PLAIN, label: 'Violino' },
		{ clefShape: 'C', clefLine: 3, ...PLAIN, label: '' },
		{ clefShape: 'F', clefLine: 4, ...PLAIN, label: 'Violoncello & Basso' }
	],
	groups: [],
	keysig: '2f',
	meterCount: '3',
	meterUnit: '8',
	meterSym: ''
};

test('a model without a scoreDef emits the default score definition verbatim', () => {
	for (const mei of [buildFacsimileMei(model(), { withBreaks: true }), buildBlankScoreMei(HEAD, 2)]) {
		assert.match(
			mei,
			/<scoreDef xml:id="scoreDef-1">\n\s*<staffGrp xml:id="staffGrp-1">\n\s*<staffDef xml:id="staffDef-1" n="1" lines="5" clef\.shape="G" clef\.line="2" meter\.count="4" meter\.unit="4"\/>\n\s*<\/staffGrp>\n\s*<\/scoreDef>/
		);
	}
});

test('the score definition round-trips through both builders', () => {
	const facsimile = buildFacsimileMei(
		{ ...model(), scoreDef: THREE_STAVES },
		{ withBreaks: true }
	);
	const blank = buildBlankScoreMei(HEAD, 2, THREE_STAVES);
	for (const mei of [facsimile, blank]) {
		assert.equal(SyntaxValidator.validate(mei), true);
		assert.deepEqual(parseScoreDef(mei), THREE_STAVES);
	}
	// The label with markup-significant characters is escaped in the emission.
	assert.ok(facsimile.includes('>Violoncello &amp; Basso</label>'));
});

test('keysig 0 means no accidentals and emits no attribute', () => {
	const mei = buildFacsimileMei({
		...model(),
		scoreDef: { ...DEFAULT_SCORE_DEF, staves: [{ clefShape: 'F', clefLine: 4, ...PLAIN, label: '' }] }
	});
	assert.ok(!mei.includes('keysig'));
	assert.equal(parseScoreDef(mei).keysig, '0');
});

test('a symbol signature emits meter.sym instead of the numeric meter', () => {
	const cut: ScoreDefModel = {
		...DEFAULT_SCORE_DEF,
		staves: [{ clefShape: 'G', clefLine: 2, ...PLAIN, label: '' }],
		meterCount: '2',
		meterUnit: '2',
		meterSym: 'cut'
	};
	const mei = buildFacsimileMei({ ...model(), scoreDef: cut }, { withBreaks: true });
	assert.ok(mei.includes('meter.sym="cut"'));
	assert.ok(!mei.includes('meter.count'));
	assert.deepEqual(parseScoreDef(mei), cut);
	// Common time implies 4/4 on the parse.
	const common = parseScoreDef('<scoreDef meter.sym="common"><staffGrp><staffDef n="1"/></staffGrp></scoreDef>');
	assert.equal(common.meterSym, 'common');
	assert.equal(common.meterCount, '4');
	assert.equal(common.meterUnit, '4');
});

test('parseScoreDef falls back to the first staffDef for the meter', () => {
	// Older generated files carried the meter on the staffDef, not the scoreDef.
	const legacy =
		'<scoreDef><staffGrp>' +
		'<staffDef n="1" lines="5" clef.shape="G" clef.line="2" meter.count="6" meter.unit="8"/>' +
		'</staffGrp></scoreDef>';
	const parsed = parseScoreDef(legacy);
	assert.equal(parsed.meterCount, '6');
	assert.equal(parsed.meterUnit, '8');
	assert.deepEqual(parsed.staves, [{ clefShape: 'G', clefLine: 2, ...PLAIN, label: '' }]);
});

test('parseScoreDef yields the default without a scoreDef or without staffDefs', () => {
	assert.deepEqual(parseScoreDef('<mei/>'), DEFAULT_SCORE_DEF);
	assert.deepEqual(parseScoreDef('<scoreDef><staffGrp/></scoreDef>'), DEFAULT_SCORE_DEF);
	// The yielded model is a copy — editing it must not corrupt the default.
	const parsed = parseScoreDef('<mei/>');
	parsed.staves.push({ clefShape: 'F', clefLine: 4, ...PLAIN, label: '' });
	assert.equal(DEFAULT_SCORE_DEF.staves.length, 1);
});

test('staff groups nest their staves in a symbol-carrying staffGrp and round-trip', () => {
	const piano: ScoreDefModel = {
		...DEFAULT_SCORE_DEF,
		staves: [
			{ clefShape: 'G', clefLine: 2, ...PLAIN, label: 'Piano' },
			{ clefShape: 'F', clefLine: 4, ...PLAIN, label: '' },
			{ clefShape: 'G', clefLine: 2, ...PLAIN, label: 'Violino' }
		],
		groups: [{ start: 1, end: 2, symbol: 'brace', label: 'Piano & Co.' }]
	};
	const mei = buildFacsimileMei({ ...model(), scoreDef: piano });
	// The group label sits directly inside the staffGrp, escaped.
	assert.match(mei, /<staffGrp[^>]*symbol="brace"[^>]*>\n\s*<label[^>]*>Piano &amp; Co\.<\/label>/);
	// The braced pair sits in its own staffGrp with barlines through; the
	// third staff stays outside it.
	assert.match(
		mei,
		/<staffGrp xml:id="staffGrp-2" symbol="brace" bar\.thru="true">[\s\S]*?n="2"[\s\S]*?<\/staffGrp>\n\s*<staffDef[^>]*n="3"/
	);
	assert.deepEqual(parseScoreDef(mei), piano);
	// A bracket groups without running the barlines through.
	const bracketed = { ...piano, groups: [{ start: 2, end: 3, symbol: 'bracket', label: '' }] };
	const bracketMei = buildFacsimileMei({ ...model(), scoreDef: bracketed });
	assert.ok(bracketMei.includes('symbol="bracket"'));
	assert.ok(!bracketMei.includes('bar.thru'));
	assert.deepEqual(parseScoreDef(bracketMei), bracketed);
});

test('percussion, tablature and octave-displaced staves round-trip', () => {
	const mixed: ScoreDefModel = {
		...DEFAULT_SCORE_DEF,
		staves: [
			{ ...PLAIN, clefShape: 'G', clefLine: 2, clefDis: '8', clefDisPlace: 'below', label: 'Tenore' },
			{ ...PLAIN, clefShape: 'perc', clefLine: 3, lines: 1, label: 'Snare' },
			{ ...PLAIN, clefShape: 'TAB', clefLine: 3, lines: 6, notationType: 'tab.guitar', label: '' },
			{ ...PLAIN, clefShape: 'TAB', clefLine: 3, lines: 7, notationType: 'tab.lute.german', label: 'Laute' }
		]
	};
	const mei = buildFacsimileMei({ ...model(), scoreDef: mixed });
	assert.ok(mei.includes('clef.dis="8" clef.dis.place="below"'));
	assert.ok(mei.includes('lines="1" clef.shape="perc"'));
	// A modern tablature staff carries its notation type and the TAB clef; a
	// lute tablature staff carries no clef at all.
	assert.ok(mei.includes('lines="6" notationtype="tab.guitar" clef.shape="TAB"'));
	assert.ok(mei.includes('lines="7" notationtype="tab.lute.german" meter.count'));
	assert.deepEqual(parseScoreDef(mei), mixed);
});

test('parseFacsimileMei carries the scoreDef alongside the header', () => {
	const mei = buildFacsimileMei({ ...model(), scoreDef: THREE_STAVES }, { withBreaks: true });
	assert.deepEqual(parseFacsimileMei(mei).scoreDef, THREE_STAVES);
});

test('seed measures hold one resting staff per staffDef in both builders', () => {
	const facsimile = buildFacsimileMei(
		{ ...model(), scoreDef: THREE_STAVES },
		{ withBreaks: true }
	);
	const blank = buildBlankScoreMei(HEAD, 2, THREE_STAVES);
	for (const mei of [facsimile, blank]) {
		const measures = mei.match(/<measure[\s\S]*?<\/measure>/g) ?? [];
		assert.ok(measures.length > 0);
		for (const measure of measures) {
			assert.equal((measure.match(/<staff /g) ?? []).length, 3);
			assert.equal((measure.match(/<mRest\b/g) ?? []).length, 3);
			assert.ok(measure.includes('n="3"'));
		}
	}
});
