// The facsimile MEI model behind the pre-tasks. Pure functions: page geometry
// and MEI text in, MEI text and models out. No DOM, filesystem or network
// access (image rendering and measure detection live in facsimile-detect.ts).
//
// A facsimile campaign's score.mei passes through stages, all emitted by
// buildFacsimileMei from one model:
//   A. facsimile-only  — <surface>/<graphic> per page, one labelled
//      <zone type="measure" n="…"> per measure box, one empty <mdiv>.
//      Committed at init; the measure-correction pre-task rewrites the zones.
//   B. + measures      — one <measure n="label" facs="#zone"> (holding an
//      <mRest/>) per zone.
//   C. + breaks        — a <pb/> before each page's first measure, an <sb/>
//      before each measure flagged as starting a system, and one <mdiv> per
//      movement/section/piece (a zone's mdiv flag starts a new one). Written
//      by the measure-correction pre-task's submission.
// parseFacsimileMei reads any stage back into the model; the <meiHead> block
// is carried verbatim across rebuilds.

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
	/** Whether the measure starts a new system (emitted as <sb/> at stage C). */
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

/** The whole facsimile model — everything buildFacsimileMei needs. */
export interface FacsimileModel {
	/** The `<meiHead>…</meiHead>` block, carried verbatim. */
	headXml: string;
	pages: PageModel[];
}

/** One page as produced by facsimile-detect.ts (boxes only, no labels yet). */
export interface FacsimilePage {
	image: string;
	width: number;
	height: number;
	measures: MeasureBox[];
}

export interface ScoreMeta {
	title?: string;
	composer?: string;
	license?: string;
}

// Escape the minimum needed to keep substituted values well-formed XML, in
// text and double-quoted attribute contexts.
function xmlEscape(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

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

/** Build the `<meiHead>` block from campaign metadata. */
export function buildMeiHead(meta: ScoreMeta = {}): string {
	return (
		`   <meiHead>\n` +
		`      <fileDesc>\n` +
		`         <titleStmt>\n` +
		`            <title>${xmlEscape(meta.title)}</title>\n` +
		`            <respStmt>\n` +
		`               <persName role="composer">${xmlEscape(meta.composer)}</persName>\n` +
		`            </respStmt>\n` +
		`         </titleStmt>\n` +
		`         <pubStmt>\n` +
		`            <availability>\n` +
		`               <useRestrict>${xmlEscape(meta.license)}</useRestrict>\n` +
		`            </availability>\n` +
		`         </pubStmt>\n` +
		`      </fileDesc>\n` +
		`      <encodingDesc>\n` +
		`         <appInfo>\n` +
		`            <application version="1">\n` +
		`               <name>Let's Encode!</name>\n` +
		`            </application>\n` +
		`         </appInfo>\n` +
		`      </encodingDesc>\n` +
		`   </meiHead>`
	);
}

/**
 * The initial model for freshly detected pages: labels numbered continuously
 * across pages in the given order, system flags from the row grouping.
 */
export function initialFacsimileModel(pages: FacsimilePage[], meta: ScoreMeta = {}): FacsimileModel {
	let label: string | undefined;
	return {
		headXml: buildMeiHead(meta),
		pages: pages.map((page) => {
			const rows = readingOrderRows(page.measures);
			return {
				image: page.image,
				width: page.width,
				height: page.height,
				zones: rows.flatMap((row) =>
					row.map((box, i) => {
						label = nextLabel(label);
						return { box, label, sb: i === 0, mdiv: false };
					})
				)
			};
		})
	};
}

/**
 * Emit the model as MEI. Stage A (`{}`), B (`{ withMeasures: true }`) or
 * C (`{ withMeasures: true, withBreaks: true }`); breaks imply measures.
 * xml:ids are deterministic (surface-1, zone-1-2, measure-3, …) so rebuilds
 * are stable and diffable.
 */
export function buildFacsimileMei(
	model: FacsimileModel,
	opts: { withMeasures?: boolean; withBreaks?: boolean } = {}
): string {
	const withMeasures = Boolean(opts.withMeasures || opts.withBreaks);
	const withBreaks = Boolean(opts.withBreaks);
	const surfaces: string[] = [];
	// Section content grouped per movement: mdivParts[k] holds <mdiv> k+1's lines.
	const mdivParts: string[][] = [[]];
	let measureNo = 0;

	model.pages.forEach((page, pi) => {
		const p = pi + 1;
		const surfaceId = `surface-${p}`;
		const zones: string[] = [];
		// A page break precedes the page's first measure, tying the flow to the
		// surface — emitted lazily so it lands inside that measure's <mdiv>.
		let pbPending = withBreaks;

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
			if (pbPending) {
				parts.push(`               <pb xml:id="pb-${p}" n="${pad2(p)}" facs="#${surfaceId}"/>`);
				pbPending = false;
			} else if (withBreaks && zone.sb && zi > 0) {
				// The page break already implies a new system for a page's first measure.
				parts.push(`               <sb xml:id="sb-${p}-${zi + 1}"/>`);
			}
			parts.push(
				`               <measure xml:id="measure-${measureNo}" n="${xmlEscape(zone.label)}" facs="#${zoneId}">\n` +
					`                  <staff n="1">\n` +
					`                     <layer n="1">\n` +
					`                        <mRest/>\n` +
					`                     </layer>\n` +
					`                  </staff>\n` +
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
			`               <scoreDef>\n` +
			`                  <staffGrp>\n` +
			`                     <staffDef n="1" lines="5" clef.shape="G" clef.line="2" meter.count="4" meter.unit="4"/>\n` +
			`                  </staffGrp>\n` +
			`               </scoreDef>\n` +
			`               <section>\n` +
			(parts.length ? parts.join('\n') + '\n' : '') +
			`               </section>\n` +
			`            </score>\n` +
			`         </mdiv>`
	);

	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<?xml-model href="https://music-encoding.org/schema/5.0/mei-CMN.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>\n` +
		`<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">\n` +
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

// One attribute's value from an XML tag string, unescaped; null if absent.
function attr(tag: string, name: string): string | null {
	const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
	if (!m) return null;
	return m[1]
		.replaceAll('&quot;', '"')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&amp;', '&');
}

/** What stage the parsed file was at, alongside the model. */
export interface ParsedFacsimile extends FacsimileModel {
	hasMeasures: boolean;
	hasBreaks: boolean;
}

/**
 * Parse a facsimile score (any stage, as emitted by buildFacsimileMei or the
 * pre-redesign scaffold) back into the model. Labels fall back to continuous
 * numbering when zones carry no @n; system flags come from the section's
 * <sb/>/<pb/> tokens where present, else from the row grouping.
 */
export function parseFacsimileMei(text: string): ParsedFacsimile {
	const headXml = /[ \t]*<meiHead>[\s\S]*?<\/meiHead>/.exec(text)?.[0];
	if (!headXml) throw new Error('Not a facsimile score: no <meiHead> found.');

	// Which zones the body marks as system/page starts and as movement starts
	// (stage C), keyed by zone id via each measure's facs link. A second or
	// later <mdiv> flags its first measure; the first <mdiv> is implicit.
	const body = /<body>([\s\S]*?)<\/body>/.exec(text)?.[1] ?? '';
	const sbZones = new Set<string>();
	const mdivZones = new Set<string>();
	let hasMeasures = false;
	let hasBreaks = false;
	let pendingBreak = false;
	let pendingMdiv = false;
	let seenMdiv = false;
	for (const token of body.match(/<(mdiv|pb|sb|measure)\b[^>]*>/g) ?? []) {
		if (token.startsWith('<mdiv')) {
			if (seenMdiv) pendingMdiv = true;
			seenMdiv = true;
		} else if (token.startsWith('<pb') || token.startsWith('<sb')) {
			pendingBreak = true;
			if (token.startsWith('<pb')) hasBreaks = true;
		} else {
			hasMeasures = true;
			const facs = attr(token, 'facs');
			if (facs?.startsWith('#')) {
				if (pendingBreak) sbZones.add(facs.slice(1));
				if (pendingMdiv) mdivZones.add(facs.slice(1));
			}
			pendingBreak = false;
			pendingMdiv = false;
		}
	}

	const pages: PageModel[] = [];
	let label: string | undefined;
	for (const surfaceMatch of text.matchAll(/<surface\b[^>]*>([\s\S]*?)<\/surface>/g)) {
		const body = surfaceMatch[1];
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
			zones.push({ box, label, sb: sbZones.has(id), mdiv: mdivZones.has(id) });
			boxesOnly.push(box);
		}
		if (!hasBreaks) {
			// No breaks recorded yet — suggest system starts from the row grouping.
			const rowStarts = new Set(readingOrderRows(boxesOnly).map((row) => row[0]));
			for (const zone of zones) zone.sb = rowStarts.has(zone.box);
		}
		pages.push({
			image: attr(graphic, 'target') ?? '',
			width: Number(attr(graphic, 'width') ?? 0),
			height: Number(attr(graphic, 'height') ?? 0),
			zones
		});
	}

	return { headXml, pages, hasMeasures, hasBreaks };
}
