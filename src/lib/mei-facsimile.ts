// Build an MEI scaffold from detected page facsimiles. Pure functions: page
// geometry in, MEI string out. No DOM, filesystem or network access (the image
// rendering and measure detection live in facsimile-detect.ts).
//
// The output mirrors the shape a mei-friend export produces: a <facsimile> with
// one <surface>/<graphic> per page and one <zone type="measure"> per detected
// box, and a <score> whose <section> carries one <pb> per page and one empty
// <measure> per box — each measure facs-linked to its zone and holding a single
// staff/layer with an <mRest/>, ready for an encoder to fill in.

/** A detected measure box, in the page image's pixel space. */
export interface MeasureBox {
	ulx: number;
	uly: number;
	lrx: number;
	lry: number;
}

/** One page: its committed image filename, pixel dimensions and detected boxes. */
export interface FacsimilePage {
	/** Path written verbatim as the graphic @target; resolved relative to the score, e.g. `img/01.jpg`. */
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

// Escape the minimum needed to keep substituted values well-formed XML.
function xmlEscape(value: unknown): string {
	return String(value ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;');
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Sort measure boxes into reading order (top-to-bottom by system, left-to-right
 * within a system). Boxes are grouped into rows greedily: a box joins the
 * current row if its vertical centre falls above the row's running bottom edge,
 * else it starts a new row. Unit-agnostic — works on normalized or pixel boxes.
 */
export function sortReadingOrder(boxes: MeasureBox[]): MeasureBox[] {
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
	return rows.flatMap((row) => row.sort((a, b) => a.ulx - b.ulx));
}

/**
 * Build the MEI scaffold. `pages` are in reading order; measures are numbered
 * continuously across pages (n="1"…). Each page contributes one <surface> and
 * a <pb>; each detected box contributes one <zone>, one <measure> and their
 * facs link. xml:ids are deterministic (surface-1, zone-1-2, measure-3, …) so
 * the output is stable and diffable.
 */
export function buildFacsimileScore(pages: FacsimilePage[], meta: ScoreMeta = {}): string {
	const surfaces: string[] = [];
	const sectionParts: string[] = [];
	let measureNo = 0;

	pages.forEach((page, pi) => {
		const p = pi + 1;
		const surfaceId = `surface-${p}`;
		const zones: string[] = [];

		// A page break precedes the page's measures, tying the flow to the surface.
		sectionParts.push(`               <pb xml:id="pb-${p}" n="${pad2(p)}" facs="#${surfaceId}"/>`);

		page.measures.forEach((m, mi) => {
			measureNo++;
			const zoneId = `zone-${p}-${mi + 1}`;
			zones.push(
				`            <zone xml:id="${zoneId}" type="measure" ` +
					`ulx="${Math.round(m.ulx)}" uly="${Math.round(m.uly)}" ` +
					`lrx="${Math.round(m.lrx)}" lry="${Math.round(m.lry)}"/>`
			);
			sectionParts.push(
				`               <measure xml:id="measure-${measureNo}" n="${measureNo}" facs="#${zoneId}">\n` +
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

	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<?xml-model href="https://music-encoding.org/schema/5.0/mei-CMN.rng" type="application/xml" schematypens="http://relaxng.org/ns/structure/1.0"?>\n` +
		`<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">\n` +
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
		`   </meiHead>\n` +
		`   <music>\n` +
		`      <facsimile>\n` +
		surfaces.join('\n') +
		`\n      </facsimile>\n` +
		`      <body>\n` +
		`         <mdiv>\n` +
		`            <score>\n` +
		`               <scoreDef>\n` +
		`                  <staffGrp>\n` +
		`                     <staffDef n="1" lines="5" clef.shape="G" clef.line="2" meter.count="4" meter.unit="4"/>\n` +
		`                  </staffGrp>\n` +
		`               </scoreDef>\n` +
		`               <section>\n` +
		(sectionParts.length ? sectionParts.join('\n') + '\n' : '') +
		`               </section>\n` +
		`            </score>\n` +
		`         </mdiv>\n` +
		`      </body>\n` +
		`   </music>\n` +
		`</mei>`
	);
}
