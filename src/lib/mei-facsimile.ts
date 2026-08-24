// The facsimile MEI model behind the pre-tasks. Pure functions: page geometry
// and MEI text in, MEI text and models out. No DOM, filesystem or network
// access (measure detection lives in measure-detection.ts, image handling in
// prepare-images.ts).
//
// A facsimile campaign's score.mei passes through stages, all emitted by
// buildFacsimileMei from one model:
//   A. facsimile-only  — <surface>/<graphic> per page, one labelled
//      <zone type="measure" n="…"> per measure box, one empty <mdiv>.
//      Committed at init; the measure-correction pre-task rewrites the zones.
//   B. + measures      — one <measure n="label" facs="#zone"> (holding an
//      <mRest/>) per zone.
//   C. + breaks        — a <pb/> before each page's first measure, an <sb/>
//      before each other measure flagged as a system start, and one <mdiv> per
//      movement/section/piece (a zone's mdiv flag starts a new one). A page
//      break implies a system break, so a page's first measure emits only the
//      <pb/>. A <pb/> @n is its page number; an <sb/> @n counts system breaks in
//      document order. Written by the measure-correction pre-task's submission.
// parseFacsimileMei reads any stage back into the model; the <meiHead> block
// is carried verbatim across rebuilds, and the <scoreDef> — staves, clefs, key
// signature, meter and instrument labels, written by the score-setup task and
// defaulting to DEFAULT_SCORE_DEF — is parsed and re-emitted alongside it.

import { addXmlIds } from './mei-ids.ts';
import { xmlEscape, xmlUnescape } from './mei-xml.ts';

/** A detected measure box, in the page image's pixel space. */
export interface MeasureBox {
	ulx: number;
	uly: number;
	lrx: number;
	lry: number;
}

/** One measure zone: its box, its measure label (@n), and its break flags. */
export interface ZoneModel {
	box: MeasureBox;
	/** The measure number/label written as @n — "12", but also "10a"/"10b" for voltas. */
	label: string;
	/**
	 * Whether the measure starts a new page — emitted as <pb facs="#surface-N"/>
	 * at stage C (each page's first measure). A page break implies a system
	 * break, so a measure with pb emits no separate <sb/>.
	 */
	pb: boolean;
	/** Whether the measure starts a new system (emitted as <sb/> at stage C, unless pb already implies it). */
	sb: boolean;
	/**
	 * Whether the measure starts a new movement/section/piece — it opens a new
	 * <mdiv> at stage C. The score's first measure always opens the first
	 * <mdiv>; its flag is ignored.
	 */
	mdiv: boolean;
}

/** One page of the facsimile model. */
export interface PageModel {
	/** Written verbatim as the graphic @target; resolved relative to the score, e.g. `img/01.jpg`. */
	image: string;
	width: number;
	height: number;
	zones: ZoneModel[];
}

/** One staff of the score definition. */
export interface StaffModel {
	/** MEI clef.shape: 'G', 'F', 'C', 'perc' (percussion) or 'TAB' (tablature). */
	clefShape: string;
	/** MEI clef.line: the staff line the clef sits on, counted from the bottom. */
	clefLine: number;
	/** MEI clef.dis: octave displacement ('8', '15'); '' emits none. */
	clefDis: string;
	/** MEI clef.dis.place: 'below' or 'above'; written with clefDis. */
	clefDisPlace: string;
	/** MEI staffDef @lines: how many lines the staff has. */
	lines: number;
	/**
	 * MEI staffDef @notationtype, for tablature staves: 'tab.guitar' (modern),
	 * 'tab.lute.french', 'tab.lute.italian' or 'tab.lute.german'. '' emits
	 * none (common notation).
	 */
	notationType: string;
	/** Instrument label, written as a <label> child; '' emits none. */
	label: string;
}

/** A run of staves joined by one symbol: a brace (one instrument, like a
 * piano — its barlines run through) or a bracket (a section, like the
 * strings). Staff numbers are 1-based and inclusive. */
export interface StaffGroupModel {
	start: number;
	end: number;
	/** MEI staffGrp @symbol: 'brace' or 'bracket'. */
	symbol: string;
	/** Group label, written as a <label> child; '' emits none. */
	label: string;
}

/** The initial score definition: staves with clefs, key signature and meter. */
export interface ScoreDefModel {
	staves: StaffModel[];
	/** Non-overlapping staff groups, each wrapping its staves in a <staffGrp>. */
	groups: StaffGroupModel[];
	/** MEI @keysig: '0' (no accidentals), '1s'…'7s' or '1f'…'7f'. */
	keysig: string;
	/** MEI @meter.count. Unused when meterSym is set. */
	meterCount: string;
	/** MEI @meter.unit. Unused when meterSym is set. */
	meterUnit: string;
	/** MEI @meter.sym: 'common' (C) or 'cut' (¢); '' writes the numeric meter. */
	meterSym: string;
}

/** The score definition a piece carries until its setup task replaces it. */
export const DEFAULT_SCORE_DEF: ScoreDefModel = {
	staves: [
		{ clefShape: 'G', clefLine: 2, clefDis: '', clefDisPlace: '', lines: 5, notationType: '', label: '' }
	],
	groups: [],
	keysig: '0',
	meterCount: '4',
	meterUnit: '4',
	meterSym: ''
};

/** A copy of DEFAULT_SCORE_DEF, safe for a caller to edit. */
const defaultScoreDef = (): ScoreDefModel => ({
	...DEFAULT_SCORE_DEF,
	staves: DEFAULT_SCORE_DEF.staves.map((staff) => ({ ...staff })),
	groups: []
});

/** The whole facsimile model — everything buildFacsimileMei needs. */
export interface FacsimileModel {
	/** The `<meiHead>…</meiHead>` block, carried verbatim. */
	headXml: string;
	/** The score definition; absent falls back to DEFAULT_SCORE_DEF. */
	scoreDef?: ScoreDefModel;
	pages: PageModel[];
}

/** One page as measure detection produces it (boxes only, no labels yet). */
export interface FacsimilePage {
	image: string;
	width: number;
	height: number;
	measures: MeasureBox[];
}

/**
 * Group measure boxes into systems (rows), top-to-bottom, each row ordered
 * left-to-right. Boxes are grouped greedily: a box joins the current row if its
 * vertical centre falls above the row's running bottom edge, else it starts a
 * new row. Unit-agnostic — works on normalized or pixel boxes.
 */
export function readingOrderRows(boxes: MeasureBox[]): MeasureBox[][] {
	const byTop = [...boxes].sort((a, b) => a.uly - b.uly);
	const rows: MeasureBox[][] = [];
	let rowBottom = -Infinity;
	for (const box of byTop) {
		const centre = (box.uly + box.lry) / 2;
		if (!rows.length || centre >= rowBottom) {
			rows.push([box]);
			rowBottom = box.lry;
		} else {
			rows[rows.length - 1].push(box);
			rowBottom = Math.max(rowBottom, box.lry);
		}
	}
	return rows.map((row) => [...row].sort((a, b) => a.ulx - b.ulx));
}

/** Sort measure boxes into reading order (readingOrderRows, flattened). */
export function sortReadingOrder(boxes: MeasureBox[]): MeasureBox[] {
	return readingOrderRows(boxes).flat();
}

/**
 * The label following `prevLabel` in the automatic numbering: its leading
 * integer plus one ("10" → "11", "10a" → "11", none/invalid → "1").
 */
export function nextLabel(prevLabel: string | undefined): string {
	const n = parseInt(prevLabel ?? '', 10);
	return String((Number.isNaN(n) ? 0 : n) + 1);
}

/**
 * The initial model for freshly detected pages: labels numbered continuously
 * across pages in the given order, system flags from the row grouping. The
 * header is left empty — the caller supplies its own headXml (buildPieceHead).
 */
export function initialFacsimileModel(pages: FacsimilePage[]): FacsimileModel {
	let label: string | undefined;
	return {
		headXml: '',
		pages: pages.map((page) => {
			const rows = readingOrderRows(page.measures);
			let firstOfPage = true;
			return {
				image: page.image,
				width: page.width,
				height: page.height,
				zones: rows.flatMap((row) =>
					row.map((box, i) => {
						label = nextLabel(label);
						// The page's first measure carries the page break; other row
						// starts carry a system break. pb and sb stay independent, so a
						// page's first measure does not also default to sb.
						const zone = { box, label, pb: firstOfPage, sb: i === 0 && !firstOfPage, mdiv: false };
						firstOfPage = false;
						return zone;
					})
				)
			};
		})
	};
}

// The <scoreDef> block at its fixed indentation inside <score>: the key
// signature on the scoreDef, one staffDef per staff carrying its clef, the
// meter and an optional <label>. keysig '0' means no accidentals and emits no
// attribute. Grouped staves nest in their own <staffGrp>; a brace joins the
// staves of one instrument, so its barlines run through (bar.thru).
function buildScoreDefXml(scoreDef: ScoreDefModel): string {
	const keysig = scoreDef.keysig === '0' ? '' : ` keysig="${xmlEscape(scoreDef.keysig)}"`;
	const meter = scoreDef.meterSym
		? `meter.sym="${xmlEscape(scoreDef.meterSym)}"`
		: `meter.count="${xmlEscape(scoreDef.meterCount)}" meter.unit="${xmlEscape(scoreDef.meterUnit)}"`;
	const staffDefXml = (staff: StaffModel, n: number, indent: string): string => {
		const dis = staff.clefDis
			? ` clef.dis="${xmlEscape(staff.clefDis)}" clef.dis.place="${xmlEscape(staff.clefDisPlace)}"`
			: '';
		const notation = staff.notationType
			? ` notationtype="${xmlEscape(staff.notationType)}"`
			: '';
		// A lute tablature staff carries no clef; the TAB lettering belongs to
		// the modern (guitar) kind only.
		const clef = staff.notationType.startsWith('tab.lute.')
			? ''
			: ` clef.shape="${xmlEscape(staff.clefShape)}" clef.line="${staff.clefLine}"${dis}`;
		const open = `${indent}<staffDef n="${n}" lines="${staff.lines}"${notation}${clef} ` + meter;
		if (!staff.label) return `${open}/>`;
		return (
			`${open}>\n` +
			`${indent}   <label>${xmlEscape(staff.label)}</label>\n` +
			`${indent}</staffDef>`
		);
	};
	const groups = [...scoreDef.groups].sort((a, b) => a.start - b.start);
	const base = '                     ';
	const rows: string[] = [];
	let n = 1;
	while (n <= scoreDef.staves.length) {
		const group = groups.find((g) => g.start === n);
		if (!group) {
			rows.push(staffDefXml(scoreDef.staves[n - 1], n, base));
			n++;
			continue;
		}
		const end = Math.min(group.end, scoreDef.staves.length);
		const thru = group.symbol === 'brace' ? ' bar.thru="true"' : '';
		rows.push(`${base}<staffGrp symbol="${xmlEscape(group.symbol)}"${thru}>`);
		if (group.label) rows.push(`${base}   <label>${xmlEscape(group.label)}</label>`);
		while (n <= end) {
			rows.push(staffDefXml(scoreDef.staves[n - 1], n, `${base}   `));
			n++;
		}
		rows.push(`${base}</staffGrp>`);
	}
	return (
		`               <scoreDef${keysig}>\n` +
		`                  <staffGrp>\n` +
		rows.join('\n') +
		`\n                  </staffGrp>\n` +
		`               </scoreDef>`
	);
}

// A seed measure's body: one staff per staffDef, each holding a resting layer.
function seedStaves(staffCount: number): string {
	return Array.from(
		{ length: Math.max(1, staffCount) },
		(_, i) =>
			`                  <staff n="${i + 1}">\n` +
			`                     <layer n="1">\n` +
			`                        <mRest/>\n` +
			`                     </layer>\n` +
			`                  </staff>\n`
	).join('');
}

/**
 * Emit the model as MEI. Stage A (`{}`) contains facsimile zones only; stage C
 * (`{ withBreaks: true }`) adds measures, page/system breaks and movements.
 * Every element carries a deterministic xml:id (surface-1, zone-1-2,
 * measure-3, staff-4, …) so rebuilds are stable and diffable.
 */
export function buildFacsimileMei(
	model: FacsimileModel,
	opts: { withBreaks?: boolean } = {}
): string {
	const withBreaks = Boolean(opts.withBreaks);
	const withMeasures = withBreaks;
	const scoreDef = model.scoreDef ?? DEFAULT_SCORE_DEF;
	const surfaces: string[] = [];
	// Section content grouped per movement: mdivParts[k] holds <mdiv> k+1's lines.
	const mdivParts: string[][] = [[]];
	let measureNo = 0;
	// System breaks are numbered in document order; a page break's @n records its
	// page number (the surface ordinal), per the MEI guidelines for <pb>.
	let sbNo = 0;

	model.pages.forEach((page, pi) => {
		const p = pi + 1;
		const surfaceId = `surface-${p}`;
		const zones: string[] = [];

		page.zones.forEach((zone, zi) => {
			measureNo++;
			const zoneId = `zone-${p}-${zi + 1}`;
			const m = zone.box;
			zones.push(
				`            <zone xml:id="${zoneId}" type="measure" n="${xmlEscape(zone.label)}" ` +
					`ulx="${Math.round(m.ulx)}" uly="${Math.round(m.uly)}" ` +
					`lrx="${Math.round(m.lrx)}" lry="${Math.round(m.lry)}"/>`
			);
			if (!withMeasures) return;
			// A flagged measure opens the next movement (the first one is implicit).
			if (zone.mdiv && measureNo > 1) mdivParts.push([]);
			const parts = mdivParts[mdivParts.length - 1];
			// A page break ties the flow to the page surface and, per the MEI
			// guidelines, implies a system break — so a measure that starts a page
			// emits only the <pb/>, never a redundant <sb/>. A page break's @n is
			// its page number; a system break's @n counts system breaks in order.
			if (zone.pb) {
				parts.push(`               <pb xml:id="pb-${p}" n="${p}" facs="#${surfaceId}"/>`);
			} else if (zone.sb) {
				parts.push(`               <sb xml:id="sb-${p}-${zi + 1}" n="${++sbNo}"/>`);
			}
			parts.push(
				`               <measure xml:id="measure-${measureNo}" n="${xmlEscape(zone.label)}" facs="#${zoneId}">\n` +
					seedStaves(scoreDef.staves.length) +
					`               </measure>`
			);
		});

		surfaces.push(
			`         <surface xml:id="${surfaceId}" n="${p}" ulx="0" uly="0" ` +
				`lrx="${page.width}" lry="${page.height}">\n` +
				`            <graphic xml:id="graphic-${p}" target="${xmlEscape(page.image)}" ` +
				`width="${page.width}" height="${page.height}"/>\n` +
				(zones.length ? zones.join('\n') + '\n' : '') +
				`         </surface>`
		);
	});

	const mdivs = mdivParts.map(
		(parts, i) =>
			`         <mdiv xml:id="mdiv-${i + 1}" n="${i + 1}">\n` +
			`            <score>\n` +
			buildScoreDefXml(scoreDef) +
			`\n               <section>\n` +
			(parts.length ? parts.join('\n') + '\n' : '') +
			`               </section>\n` +
			`            </score>\n` +
			`         </mdiv>`
	);

	return addXmlIds(
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<?xml-model href="https://music-encoding.org/schema/5.1/mei-CMN.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>\n` +
		`<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1">\n` +
		model.headXml +
		`\n   <music>\n` +
		`      <facsimile>\n` +
		surfaces.join('\n') +
		`\n      </facsimile>\n` +
		`      <body>\n` +
		mdivs.join('\n') +
		`\n      </body>\n` +
		`   </music>\n` +
		`</mei>`
	);
}

/**
 * Emit the blank score of a physical piece — one transcribed from the source
 * itself, with no facsimile. With a page count, each page opens with a
 * `<pb facs="#surface-N"/>` marker and holds one seed measure, so per-page
 * tasks address the same `surface-N` locators a facsimile campaign uses (the
 * page-span join replaces a page's content wholesale; see mei-page-splice.ts).
 * Without one, a single seed measure gives the encoder a valid file to start
 * from. Every element carries a deterministic xml:id so rebuilds are stable
 * and diffable.
 */
export function buildBlankScoreMei(
	headXml: string,
	pages = 0,
	scoreDef: ScoreDefModel = DEFAULT_SCORE_DEF
): string {
	const parts: string[] = [];
	for (let p = 1; p <= Math.max(1, pages); p++) {
		if (pages > 0) {
			parts.push(`               <pb xml:id="pb-${p}" n="${p}" facs="#surface-${p}"/>`);
		}
		parts.push(
			`               <measure xml:id="measure-${p}" n="${p}">\n` +
				seedStaves(scoreDef.staves.length) +
				`               </measure>`
		);
	}
	return addXmlIds(
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<?xml-model href="https://music-encoding.org/schema/5.1/mei-CMN.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>\n` +
		`<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1">\n` +
		headXml +
		`\n   <music>\n` +
		`      <body>\n` +
		`         <mdiv xml:id="mdiv-1" n="1">\n` +
		`            <score>\n` +
		buildScoreDefXml(scoreDef) +
		`\n               <section>\n` +
		parts.join('\n') +
		`\n               </section>\n` +
		`            </score>\n` +
		`         </mdiv>\n` +
		`      </body>\n` +
		`   </music>\n` +
		`</mei>`
	);
}

// One attribute's value from an XML tag string, unescaped; null if absent.
function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
	return m ? xmlUnescape(m[1]) : null;
}

/**
 * Parse the first `<scoreDef>` of an MEI document back into the model. The key
 * signature is read from the scoreDef; the meter (symbol, or count and unit)
 * from the scoreDef where it carries one, else from the first staffDef (where
 * buildScoreDefXml writes it). A document without a scoreDef, or one whose
 * scoreDef has no staffDef, yields the default.
 */
export function parseScoreDef(text: string): ScoreDefModel {
	const block = /<scoreDef\b[^>]*\/>|<scoreDef\b[^>]*>[\s\S]*?<\/scoreDef>/.exec(text)?.[0];
	if (!block) return defaultScoreDef();
	const open = /<scoreDef\b[^>]*>/.exec(block)![0];
	const staves: StaffModel[] = [];
	for (const match of block.matchAll(/<staffDef\b[^>]*\/>|<staffDef\b[^>]*>([\s\S]*?)<\/staffDef>/g)) {
		const tag = /<staffDef\b[^>]*>/.exec(match[0])![0];
		const label = /<label\b[^>]*>([\s\S]*?)<\/label>/.exec(match[1] ?? '')?.[1];
		// A tablature staffDef may carry no clef attributes; its shape is the
		// TAB convention, so the model stays complete.
		const notationType = attr(tag, 'notationtype') ?? '';
		const tab = notationType.startsWith('tab');
		staves.push({
			clefShape: attr(tag, 'clef\\.shape') ?? (tab ? 'TAB' : 'G'),
			clefLine: Number(attr(tag, 'clef\\.line') ?? (tab ? 3 : 2)),
			clefDis: attr(tag, 'clef\\.dis') ?? '',
			clefDisPlace: attr(tag, 'clef\\.dis\\.place') ?? '',
			lines: Number(attr(tag, 'lines') ?? 5),
			notationType,
			label: label ? xmlUnescape(label.trim()) : ''
		});
	}
	if (!staves.length) return defaultScoreDef();
	// Nested <staffGrp> elements (below the root one) are the staff groups,
	// each spanning the staffDefs it wraps, in document order.
	const groups: StaffGroupModel[] = [];
	let staffNo = 0;
	let depth = 0;
	let inner: { start: number; symbol: string; label: string } | null = null;
	const tokenRe = /<staffGrp\b[^>]*>|<\/staffGrp>|<staffDef\b/g;
	let token: RegExpExecArray | null;
	while ((token = tokenRe.exec(block))) {
		if (token[0] === '<staffDef') {
			staffNo++;
		} else if (token[0].startsWith('</')) {
			if (depth === 2 && inner && staffNo >= inner.start) {
				groups.push({ start: inner.start, end: staffNo, symbol: inner.symbol, label: inner.label });
			}
			if (depth === 2) inner = null;
			depth--;
		} else {
			depth++;
			if (depth === 2) {
				// A label directly after the open tag names the group (a staff's
				// own label sits inside its staffDef instead).
				const label = /^\s*<label\b[^>]*>([\s\S]*?)<\/label>/.exec(
					block.slice(tokenRe.lastIndex)
				)?.[1];
				inner = {
					start: staffNo + 1,
					symbol: attr(token[0], 'symbol') ?? 'bracket',
					label: label ? xmlUnescape(label.trim()) : ''
				};
			}
		}
	}
	const firstStaff = /<staffDef\b[^>]*>/.exec(block)?.[0] ?? '';
	// A symbol signature implies its numeric meter — common time is 4/4, cut
	// time 2/2 — so the model stays complete either way.
	const meterSym = attr(open, 'meter\\.sym') ?? attr(firstStaff, 'meter\\.sym') ?? '';
	if (meterSym !== '') {
		return {
			staves,
			groups,
			keysig: attr(open, 'keysig') ?? '0',
			meterCount: meterSym === 'cut' ? '2' : '4',
			meterUnit: meterSym === 'cut' ? '2' : '4',
			meterSym
		};
	}
	return {
		staves,
		groups,
		keysig: attr(open, 'keysig') ?? '0',
		meterCount: attr(open, 'meter\\.count') ?? attr(firstStaff, 'meter\\.count') ?? '4',
		meterUnit: attr(open, 'meter\\.unit') ?? attr(firstStaff, 'meter\\.unit') ?? '4',
		meterSym: ''
	};
}

/** What stage the parsed file was at, alongside the model. */
export interface ParsedFacsimile extends FacsimileModel {
	/** Always present on a parse; the default when the document carries none. */
	scoreDef: ScoreDefModel;
	hasMeasures: boolean;
	hasBreaks: boolean;
}

/**
 * Parse a facsimile score (any stage, as emitted by buildFacsimileMei) back
 * into the model. Labels fall back to continuous
 * numbering when zones carry no @n; system flags come from the section's
 * <sb/>/<pb/> tokens where present, else from the row grouping.
 */
export function parseFacsimileMei(text: string): ParsedFacsimile {
	const headXml = /[ \t]*<meiHead\b[^>]*>[\s\S]*?<\/meiHead>/.exec(text)?.[0];
	if (!headXml) throw new Error('Not a facsimile score: no <meiHead> found.');

	// Which zones the body marks as system/page starts and as movement starts
	// (stage C), keyed by zone id via each measure's facs link. A second or
	// later <mdiv> flags its first measure; the first <mdiv> is implicit.
	const body = /<body\b[^>]*>([\s\S]*?)<\/body>/.exec(text)?.[1] ?? '';
	const pbZones = new Set<string>();
	const sbZones = new Set<string>();
	const mdivZones = new Set<string>();
	let hasMeasures = false;
	let hasBreaks = false;
	let pendingPb = false;
	let pendingSb = false;
	let pendingMdiv = false;
	let seenMdiv = false;
	for (const token of body.match(/<(mdiv|pb|sb|measure)\b[^>]*>/g) ?? []) {
		if (token.startsWith('<mdiv')) {
			if (seenMdiv) pendingMdiv = true;
			seenMdiv = true;
		} else if (token.startsWith('<pb')) {
			pendingPb = true;
			hasBreaks = true;
		} else if (token.startsWith('<sb')) {
			pendingSb = true;
		} else {
			hasMeasures = true;
			const facs = attr(token, 'facs');
			if (facs?.startsWith('#')) {
				if (pendingPb) pbZones.add(facs.slice(1));
				if (pendingSb) sbZones.add(facs.slice(1));
				if (pendingMdiv) mdivZones.add(facs.slice(1));
			}
			pendingPb = false;
			pendingSb = false;
			pendingMdiv = false;
		}
	}

	const pages: PageModel[] = [];
	let label: string | undefined;
	// A self-closing <surface/> is a complete (zone-less, graphic-less) element,
	// so the first alternative keeps it from swallowing text up to the next
	// </surface>.
	for (const surfaceMatch of text.matchAll(/<surface\b[^>]*\/>|<surface\b[^>]*>([\s\S]*?)<\/surface>/g)) {
		const body = surfaceMatch[1] ?? '';
		const graphic = /<graphic\b[^>]*>/.exec(body)?.[0];
		if (!graphic) continue;
		const zones: ZoneModel[] = [];
		const boxesOnly: MeasureBox[] = [];
		for (const zoneMatch of body.matchAll(/<zone\b[^>]*>/g)) {
			const tag = zoneMatch[0];
			if (attr(tag, 'type') !== 'measure') continue;
			const box = {
				ulx: Number(attr(tag, 'ulx') ?? 0),
				uly: Number(attr(tag, 'uly') ?? 0),
				lrx: Number(attr(tag, 'lrx') ?? 0),
				lry: Number(attr(tag, 'lry') ?? 0)
			};
			label = attr(tag, 'n') ?? nextLabel(label);
			const id = attr(tag, 'xml:id') ?? '';
			zones.push({ box, label, pb: pbZones.has(id), sb: sbZones.has(id), mdiv: mdivZones.has(id) });
			boxesOnly.push(box);
		}
		if (!hasBreaks) {
			// No breaks recorded yet — default the page break to the first measure
			// and suggest system starts for the other row starts (kept independent).
			const rowStarts = new Set(readingOrderRows(boxesOnly).map((row) => row[0]));
			const pageFirst = boxesOnly[0];
			for (const zone of zones) {
				zone.pb = zone.box === pageFirst;
				zone.sb = rowStarts.has(zone.box) && zone.box !== pageFirst;
			}
		}
		pages.push({
			image: attr(graphic, 'target') ?? '',
			width: Number(attr(graphic, 'width') ?? 0),
			height: Number(attr(graphic, 'height') ?? 0),
			zones
		});
	}

	return { headXml, scoreDef: parseScoreDef(text), pages, hasMeasures, hasBreaks };
}

/** A committed page image a surface can be relinked to. */
export interface FacsimileImage {
	/** Written as the graphic @target; resolved relative to the score file. */
	target: string;
	/** The image's real pixel size, which the surface's coordinates become. */
	width: number;
	height: number;
}

/**
 * Relink an MEI's facsimile to a given sequence of page images: the nth
 * `<surface>` is pointed at the nth image, and that surface's coordinates are
 * scaled from the size its `<graphic>` declared to the image's real pixel size.
 * Surfaces past the end of the sequence, and any without a `<graphic>`, are left
 * as they are.
 *
 * Used on an uploaded encoding, whose facsimile references the files and pixel
 * sizes it was authored against rather than the copies committed alongside it.
 */
export function relinkFacsimileImages(mei: string, images: FacsimileImage[]): string {
	let index = 0;
	// The first alternative matches a self-closing <surface/> whole, so it does
	// not swallow text up to the next </surface>.
	return mei.replace(/<surface\b[^>]*\/>|<surface\b[^>]*>[\s\S]*?<\/surface>/g, (surface) => {
		const image = images[index++];
		const graphic = /<graphic\b[^>]*>/.exec(surface)?.[0];
		if (!image || !graphic) return surface;
		const width = Number(attr(graphic, 'width') ?? 0);
		const height = Number(attr(graphic, 'height') ?? 0);
		const sx = width > 0 ? image.width / width : 1;
		const sy = height > 0 ? image.height / height : 1;
		// The surface's own box and its zones are in the coordinate space the
		// graphic declares, so both move with it.
		return surface
			.replace(/<(?:surface|zone)\b[^>]*>/g, (tag) => scaleBox(tag, sx, sy))
			.replace(/<graphic\b[^>]*>/, () =>
				setAttrs(graphic, { target: image.target, width: image.width, height: image.height })
			);
	});
}

// Scale a tag's bounding box, when it has one; a tag without stays as it is.
function scaleBox(tag: string, sx: number, sy: number): string {
	if (attr(tag, 'ulx') === null) return tag;
	return setAttrs(tag, {
		ulx: Math.round(Number(attr(tag, 'ulx') ?? 0) * sx),
		uly: Math.round(Number(attr(tag, 'uly') ?? 0) * sy),
		lrx: Math.round(Number(attr(tag, 'lrx') ?? 0) * sx),
		lry: Math.round(Number(attr(tag, 'lry') ?? 0) * sy)
	});
}

// Set attributes on an XML tag string: an attribute already present is
// rewritten in place, one that is absent is appended.
function setAttrs(tag: string, values: Record<string, string | number>): string {
	let out = tag;
	for (const [name, value] of Object.entries(values)) {
		const attribute = `${name}="${xmlEscape(value)}"`;
		const present = new RegExp(`\\b${name}="[^"]*"`);
		out = present.test(out)
			? out.replace(present, () => attribute)
			: out.replace(/\s*\/?>$/, (end) => ` ${attribute}${end.trimStart()}`);
	}
	return out;
}

/**
 * Swap an MEI document's `<meiHead>` for another. Used on an uploaded encoding
 * once it has been converted: the converter emits its own header, which the
 * campaign replaces with the piece's, so every piece MEI describes itself and
 * its source the same way. A document with no header gets one inserted after
 * the root element's start tag.
 */
export function replaceMeiHead(mei: string, headXml: string): string {
	const head = /<meiHead\b[^>]*>[\s\S]*?<\/meiHead>|<meiHead\b[^>]*\/>/.exec(mei);
	if (head) return mei.slice(0, head.index) + headXml.trim() + mei.slice(head.index + head[0].length);
	const root = /<mei\b[^>]*>/.exec(mei);
	if (!root) return mei;
	const at = root.index + root[0].length;
	return `${mei.slice(0, at)}\n${headXml}${mei.slice(at)}`;
}
