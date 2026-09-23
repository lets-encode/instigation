// Inserting a page's transcription into the piece's score: the measures of
// the converted page (an MEI document verovio made from the stitched page
// MusicXML) are matched system by system, left to right, to the skeleton's
// measures of that page, and each matched skeleton measure takes the
// converted measure's content — staves, layers and the control events
// (slurs, dynamics, ties) that reference them. The skeleton's own measure
// tags (xml:id, @n, @facs), its page and system breaks and everything outside
// the page stay as they are. Regex over the document text, no DOM.

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
 * system, and a different system count is refused. Converted staves beyond
 * the score definition's staff count are dropped with a warning, since a
 * staff without a staffDef is invalid.
 */
export function insertPageDraft(
	skeleton: string,
	locator: string,
	converted: string,
	measuresPerSystem: number[]
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
			result = result.replace(system[i].text, () => withContent(system[i].text, content.trim()));
			filled++;
		}
		cursor += available;
	}
	if (dropped) {
		warnings.push(`Page ${page}: staves beyond the score definition's ${staffCount} were left out.`);
	}
	return { mei: skeleton.slice(0, from) + result + skeleton.slice(to), filled, warnings };
}
