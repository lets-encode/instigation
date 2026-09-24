// Inserting a page's transcription into the piece's score: the measures of
// the converted page (an MEI document verovio made from the stitched page
// MusicXML) are matched system by system, left to right, to the skeleton's
// measures of that page, and each matched skeleton measure takes the
// converted measure's content — staves, layers and the control events
// (slurs, dynamics, ties) that reference them. The skeleton's own measure
// tags (xml:id, @n, @facs), its page and system breaks and everything outside
// the page stay as they are. Each system's staves are written as `printed`
// gives them: a printed staff takes the converted staff of its number and
// links its staff zone (@facs); a staff the system leaves out rests. Regex
// over the document text, no DOM.

import { parseScoreDef } from './mei-facsimile.ts';

export interface DraftInsertion {
	mei: string;
	/** Skeleton measures that received content. */
	filled: number;
	/** What did not line up: a system with more boxes than transcribed measures, or the reverse. */
	warnings: string[];
}

const MEASURE = /<measure\b[^>]*>[\s\S]*?<\/measure>|<measure\b[^>]*\/>/g;

/** The `<measure>` elements of a document in order, each with its inner content. */
function measuresOf(mei: string): { text: string; inner: string }[] {
	return (mei.match(MEASURE) ?? []).map((text) => ({
		text,
		inner: /\/>$/.test(text) ? '' : text.replace(/^<measure\b[^>]*>/, '').replace(/<\/measure>$/, '')
	}));
}

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
 * links its zone, the others rest; the converted control events follow.
 */
function measureStaves(content: string, staffCount: number, printed: Map<number, string>): string {
	const convertedStaves = content.match(STAFF) ?? [];
	const byN = new Map(convertedStaves.map((staff) => [Number(/\bn="(\d+)"/.exec(staff)?.[1]), staff]));
	const staves = Array.from({ length: staffCount }, (_, i) => {
		const n = i + 1;
		const zone = printed.get(n);
		if (!zone) return `<staff n="${n}"><layer n="1"><mRest/></layer></staff>`;
		const converted = byN.get(n);
		const inner =
			!converted || /\/>$/.test(converted)
				? '<layer n="1"/>'
				: clefsOutOfTremolos(converted.replace(/^<staff\b[^>]*>/, '').replace(/<\/staff>$/, ''));
		return `<staff n="${n}" facs="#${zone}">${inner}</staff>`;
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
 * system, the staves it prints (staff n → staff zone id). Converted staves
 * beyond the score definition's staff count are dropped with a warning,
 * since a staff without a staffDef is invalid.
 */
export function insertPageDraft(
	skeleton: string,
	locator: string,
	converted: string,
	measuresPerSystem: number[],
	printed: Map<number, string>[]
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
			const staves = measureStaves(content, staffCount, printed[s] ?? new Map());
			result = result.replace(system[i].text, () => withContent(system[i].text, staves));
			filled++;
		}
		cursor += available;
	}
	if (dropped) {
		warnings.push(`Page ${page}: staves beyond the score definition's ${staffCount} were left out.`);
	}
	return { mei: skeleton.slice(0, from) + result + skeleton.slice(to), filled, warnings };
}
