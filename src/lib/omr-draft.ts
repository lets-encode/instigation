// Inserting a page's transcription into the piece's score: the measures of
// the converted page (an MEI document verovio made from the stitched page
// MusicXML) are matched system by system, left to right, to the skeleton's
// measures of that page, and each matched skeleton measure takes the
// converted measure's content — staves, layers and the control events
// (slurs, dynamics, ties) that reference them. The skeleton's own measure
// tags (xml:id, @n, @facs), its page and system breaks and everything outside
// the page stay as they are. Each system's staves are written as `printed`
// gives them: a printed staff takes the converted staff of its number and
// links its staff zone (@facs); a staff the system leaves out rests, keeping
// any clef change verovio placed on it. Key and meter changes verovio writes
// as a `<scoreDef>` before a measure go before the skeleton measure it fills.
// What the page's first system changes against the page start (`opening`,
// from the stitching) is written by the insertion itself: a clef as the first
// element of the staff's layer in the page's first measure, a key or meter as
// a `<scoreDef>` before that measure. Regex over the document text, no DOM.

import { parseScoreDef } from './mei-facsimile.ts';
import { keysigFor } from './omr-musicxml.ts';
import type { PageOpening } from './omr-stitch.ts';

export interface DraftInsertion {
	mei: string;
	/** Skeleton measures that received content. */
	filled: number;
	/** What did not line up: a system with more boxes than transcribed measures, or the reverse. */
	warnings: string[];
}

const MEASURE_OR_SCOREDEF =
	/<scoreDef\b[^>]*\/>|<scoreDef\b[^>]*>[\s\S]*?<\/scoreDef>|<measure\b[^>]*>[\s\S]*?<\/measure>|<measure\b[^>]*\/>/g;

/**
 * The `<measure>` elements of a converted document's sections in order, each
 * with its inner content and the `<scoreDef>` elements since the measure
 * before it.
 */
function measuresOf(mei: string): { text: string; inner: string; before: string }[] {
	const sections = mei.slice(Math.max(0, mei.search(/<section\b/)));
	const measures: { text: string; inner: string; before: string }[] = [];
	let before = '';
	for (const text of sections.match(MEASURE_OR_SCOREDEF) ?? []) {
		if (text.startsWith('<scoreDef')) {
			// Only a key or meter change, without verovio's ppq, which also makes up scoreDefs of its own.
			if (/<(keySig|meterSig)\b|\s(keysig|meter\.(count|unit|sym))=/.test(text)) {
				before += text.replace(/^(<scoreDef\b[^>]*?)\s+ppq="[^"]*"/, '$1');
			}
			continue;
		}
		measures.push({
			text,
			inner: /\/>$/.test(text) ? '' : text.replace(/^<measure\b[^>]*>/, '').replace(/<\/measure>$/, ''),
			before
		});
		before = '';
	}
	return measures;
}

/** An MEI `<clef>` for a clef token (`G2`, `F4`, `G2-1`, `perc`, `TAB`; see `clefXml`). */
export function meiClef(token: string): string {
	const m = /^([A-Z])(\d)([+-]\d)?$/.exec(token);
	if (!m) return `<clef shape="${token === 'TAB' ? 'TAB' : 'perc'}"/>`;
	const octaves = Math.abs(Number(m[3] ?? 0));
	const dis = octaves
		? ` dis="${octaves === 1 ? 8 : octaves === 2 ? 15 : 22}" dis.place="${Number(m[3]) < 0 ? 'below' : 'above'}"`
		: '';
	return `<clef shape="${m[1]}" line="${m[2]}"${dis}/>`;
}

/** A `<scoreDef>` for the key and meter the page's first system changes, or '' when it changes neither. */
function openingScoreDef(opening: PageOpening): string {
	const key = opening.fifths !== null ? `<keySig sig="${keysigFor(opening.fifths)}"/>` : '';
	const time = opening.time
		? opening.time.symbol
			? `<meterSig sym="${opening.time.symbol}"/>`
			: `<meterSig count="${opening.time.beats}" unit="${opening.time.beatType}"/>`
		: '';
	return key || time ? `<scoreDef>${key}${time}</scoreDef>` : '';
}

/** Staff content with `clef` as the first element of its first layer. */
const withLeadingClef = (content: string, clef: string): string =>
	/^\s*<layer\b[^>]*\/>/.test(content)
		? content.replace(/^\s*<layer\b([^>]*?)\s*\/>/, `<layer$1>${clef}</layer>`)
		: content.replace(/<layer\b[^>]*>/, (tag) => `${tag}${clef}`);

// The self-closing form comes first, so it never runs on to the next </staff>.
const STAFF = /<staff\b[^>]*\/>|<staff\b[^>]*>[\s\S]*?<\/staff>/g;

/**
 * Staff content with every `<clef>` inside a `<bTrem>` or `<fTrem>` moved to
 * just after it. Verovio's MusicXML import puts the next system's clef change
 * inside a tremolo that ends an overfull measure, where MEI allows only notes
 * and chords.
 */
function clefsOutOfTremolos(content: string): string {
	return content.replace(/<(bTrem|fTrem)\b[^>]*>[\s\S]*?<\/\1>/g, (tremolo) => {
		const clefs = tremolo.match(/<clef\b[^>]*\/>/g);
		return clefs ? tremolo.replace(/\s*<clef\b[^>]*\/>/g, '') + clefs.join('') : tremolo;
	});
}

/**
 * A measure's staves 1…staffCount from converted content: a staff in
 * `printed` (staff n → staff zone id) takes the converted staff's content and
 * links its zone, with `leadingClefs` (staff n → MEI clef) put first in its
 * layer; the others rest, followed by the clefs their converted content
 * holds. The converted control events follow.
 */
function measureStaves(
	content: string,
	staffCount: number,
	printed: Map<number, string>,
	leadingClefs: Map<number, string> = new Map()
): string {
	const convertedStaves = content.match(STAFF) ?? [];
	const byN = new Map(convertedStaves.map((staff) => [Number(/\bn="(\d+)"/.exec(staff)?.[1]), staff]));
	const staves = Array.from({ length: staffCount }, (_, i) => {
		const n = i + 1;
		const zone = printed.get(n);
		const converted = byN.get(n);
		if (!zone) {
			const clefs = converted?.match(/<clef\b[^>]*\/>/g)?.join('') ?? '';
			return `<staff n="${n}"><layer n="1"><mRest/>${clefs}</layer></staff>`;
		}
		const inner =
			!converted || /\/>$/.test(converted)
				? '<layer n="1"/>'
				: clefsOutOfTremolos(converted.replace(/^<staff\b[^>]*>/, '').replace(/<\/staff>$/, ''));
		const clef = leadingClefs.get(n);
		return `<staff n="${n}" facs="#${zone}">${clef ? withLeadingClef(inner, clef) : inner}</staff>`;
	});
	const controlEvents = convertedStaves.reduce((rest, staff) => rest.replace(staff, ''), content).trim();
	return staves.join('\n') + (controlEvents ? `\n${controlEvents}` : '');
}

/** A skeleton measure with `content` in place of its inner content, keeping its start tag. */
function withContent(measure: string, content: string): string {
	const open = /^<measure\b[^>]*?>/.exec(measure)![0].replace(/\/>$/, '>');
	return `${open}\n${content}\n               </measure>`;
}

/**
 * Put the converted page's measures into the skeleton's measures of the page
 * `locator` (`surface-N`) names. Systems are the runs of skeleton measures
 * opened by a `<pb>` or `<sb>`; the converted document's systems are given by
 * `measuresPerSystem` (what the stitching produced), one entry per skeleton
 * system, and a different system count is refused. `printed` gives, per
 * system, the staves it prints (staff n → staff zone id). `opening` is what
 * the page's first system changes against the page start. Converted staves
 * beyond the score definition's staff count are dropped with a warning,
 * since a staff without a staffDef is invalid.
 */
export function insertPageDraft(
	skeleton: string,
	locator: string,
	converted: string,
	measuresPerSystem: number[],
	printed: Map<number, string>[],
	opening: PageOpening = { clefs: [], fifths: null, time: null }
): DraftInsertion {
	const warnings: string[] = [];
	const page = Number(/^surface-(\d+)$/.exec(locator)?.[1]);
	const pbTag = new RegExp(`<pb\\b[^>]*\\bfacs="#${locator}"[^>]*>`);
	const pb = pbTag.exec(skeleton);
	if (!pb) throw new Error(`No page break found for ${locator}.`);
	const from = pb.index + pb[0].length;
	const nextPb = /<pb\b[^>]*>/g;
	nextPb.lastIndex = from;
	const next = nextPb.exec(skeleton);
	const to = next ? next.index : skeleton.length;
	const span = skeleton.slice(from, to);

	// The skeleton's systems on this page: measures grouped at each <sb>.
	const systems: { text: string; inner: string }[][] = [[]];
	for (const token of span.match(/<sb\b[^>]*>|<measure\b[^>]*>[\s\S]*?<\/measure>|<measure\b[^>]*\/>/g) ?? []) {
		if (token.startsWith('<sb')) {
			if (systems[systems.length - 1].length) systems.push([]);
			continue;
		}
		systems[systems.length - 1].push({
			text: token,
			inner: /\/>$/.test(token) ? '' : token.replace(/^<measure\b[^>]*>/, '').replace(/<\/measure>$/, '')
		});
	}
	if (!systems[0].length) systems.shift();

	const staffCount = parseScoreDef(skeleton).staves.length;
	const convertedMeasures = measuresOf(converted);
	if (systems.length !== measuresPerSystem.length) {
		throw new Error(
			`Page ${page}: ${systems.length} system(s) of measure boxes, ${measuresPerSystem.length} transcribed.`
		);
	}

	const leadingClefs = new Map<number, string>();
	opening.clefs.forEach((token, k) => {
		if (token) leadingClefs.set(k + 1, meiClef(token));
	});
	const startScoreDef = openingScoreDef(opening);

	let filled = 0;
	let dropped = false;
	let cursor = 0;
	let result = span;
	for (const [s, system] of systems.entries()) {
		const available = measuresPerSystem[s] ?? 0;
		const take = Math.min(system.length, available);
		if (system.length !== available) {
			warnings.push(
				`Page ${page}, system ${s + 1}: ${system.length} measure box(es), ${available} measure(s) transcribed.`
			);
		}
		for (let i = 0; i < take; i++) {
			const measure = convertedMeasures[cursor + i];
			if (!measure) break;
			// Staves the score definition does not have are left out.
			let content = measure.inner;
			const extra = content.match(/<staff\b[^>]*\bn="(\d+)"[^>]*>[\s\S]*?<\/staff>/g) ?? [];
			for (const staff of extra) {
				const n = Number(/\bn="(\d+)"/.exec(staff)![1]);
				if (n > staffCount) {
					content = content.replace(staff, '');
					dropped = true;
				}
			}
			const first = s === 0 && i === 0;
			const staves = measureStaves(content, staffCount, printed[s] ?? new Map(), first ? leadingClefs : undefined);
			const before = (first ? startScoreDef : '') + measure.before;
			result = result.replace(system[i].text, () => before + withContent(system[i].text, staves));
			filled++;
		}
		cursor += available;
	}
	if (dropped) {
		warnings.push(`Page ${page}: staves beyond the score definition's ${staffCount} were left out.`);
	}
	return { mei: skeleton.slice(0, from) + result + skeleton.slice(to), filled, warnings };
}
