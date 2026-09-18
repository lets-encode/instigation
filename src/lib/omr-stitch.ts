// Stitching the staff model's per-staff MusicXML into one page-level MusicXML
// document: every staff of a system becomes a part, the systems follow one
// another with a system break at each start. A system with fewer staves than
// the score has parts (a voice resting through a piano introduction, say)
// places its staves by clef: the part sequence that matches its clef sequence
// best, and the lowest such placement on a tie, since an omitted staff is
// usually a top one. The parts it leaves out get empty measures. Regex over
// the document text, no DOM.
//
// The staff model transcribes one staff at a time and reads an unprinted key
// or time signature as none, so within a system the key and the time of the
// first staff that carries them are copied to the staves that do not. Staves
// of one system may disagree on their measure count; the shorter ones are
// padded with empty measures so the parts stay aligned, and the count each
// system ends up with is reported for the draft insertion to check against
// the measure boxes.

import { clefToken } from './omr-musicxml.ts';

/** One system's transcriptions, top staff first; null for a staff that was not transcribed. */
export type SystemTranscriptions = (string | null)[];

/**
 * The part (0-based, strictly increasing) each staff of a system goes to,
 * given the staves' clefs and the parts' clefs (`G2`, `F4`, …). The
 * placement with the most clef matches wins; a staff of unknown clef matches
 * any part; among equals the lowest placement wins. More staves than parts:
 * the extra bottom staves are dropped (index -1).
 */
export function alignStaves(staffClefs: (string | null)[], partClefs: string[]): number[] {
	const n = staffClefs.length;
	const m = partClefs.length;
	if (n >= m) return staffClefs.map((_, i) => (i < m ? i : -1));
	// best[i][j]: the most matches placing staves i.. into parts j.., and the
	// part staff i takes for it.
	const best: { score: number; part: number }[][] = Array.from({ length: n + 1 }, () =>
		Array.from({ length: m + 1 }, () => ({ score: 0, part: -1 }))
	);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			let choice = { score: -1, part: -1 };
			// Staff i may take any part p ≥ j that still leaves parts for the rest.
			for (let p = j; p <= m - (n - i); p++) {
				const match = staffClefs[i] === null || staffClefs[i] === partClefs[p] ? 1 : 0;
				const score = match + best[i + 1][p + 1].score;
				if (score >= choice.score) choice = { score, part: p };
			}
			best[i][j] = choice;
		}
	}
	const out: number[] = [];
	let j = 0;
	for (let i = 0; i < n; i++) {
		out.push(best[i][j].part);
		j = best[i][j].part + 1;
	}
	return out;
}

export interface StitchedPage {
	musicxml: string;
	/** Measures per system after padding, in system order. */
	measuresPerSystem: number[];
	/** How many parts (staves per system) the page has. */
	parts: number;
}

/** The `<measure>` elements of a single-part MusicXML document, in order. */
function measuresOf(musicxml: string): string[] {
	const part = /<part\b[^>]*>([\s\S]*?)<\/part>/.exec(musicxml)?.[1] ?? '';
	return part.match(/<measure\b[^>]*>[\s\S]*?<\/measure>|<measure\b[^>]*\/>/g) ?? [];
}

const inner = (measure: string): string =>
	/<measure\b[^>]*\/>/.test(measure) ? '' : measure.replace(/^<measure\b[^>]*>/, '').replace(/<\/measure>$/, '');

const element = (xml: string, tag: string): string | null =>
	new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>|<${tag}\\b[^>]*/>`).exec(xml)?.[0] ?? null;

/**
 * A measure's `<attributes>` with `<key>` and `<time>` filled from the donors
 * where the measure lacks them, in MusicXML's element order (divisions, key,
 * time, then the rest). A measure without attributes gets a block holding the
 * donors alone.
 */
function withSignatures(measure: string, key: string | null, time: string | null): string {
	if (!key && !time) return measure;
	const body = inner(measure);
	const attributes = element(body, 'attributes');
	const current = attributes ? attributes.replace(/^<attributes\b[^>]*>/, '').replace(/<\/attributes>$/, '') : '';
	if (element(current, 'key') && element(current, 'time')) return measure;
	const divisions = element(current, 'divisions') ?? '';
	const ownKey = element(current, 'key');
	const ownTime = element(current, 'time');
	const rest = current
		.replace(divisions, '')
		.replace(ownKey ?? '', '')
		.replace(ownTime ?? '', '');
	const rebuilt = `<attributes>${divisions}${ownKey ?? key ?? ''}${ownTime ?? time ?? ''}${rest}</attributes>`;
	const open = /^<measure\b[^>]*>/.exec(measure)?.[0]?.replace(/\/>$/, '>') ?? '<measure>';
	const newBody = attributes ? body.replace(attributes, rebuilt) : rebuilt + body;
	return `${open}${newBody}</measure>`;
}

/**
 * Stitch the systems of one page into a page-level score. With `partClefs`
 * (the score definition's staves, top to bottom) the parts are those staves
 * and a system's staves are placed by clef (alignStaves); without, the parts
 * are as many as the widest system has staves and a system fills them from
 * the top. Parts a system leaves out get empty measures.
 */
export function stitchPage(systems: SystemTranscriptions[], partClefs?: string[]): StitchedPage {
	const parts = partClefs ? partClefs.length : Math.max(0, ...systems.map((s) => s.length));
	const perPart: string[][] = Array.from({ length: parts }, () => []);
	const measuresPerSystem: number[] = [];
	for (const [s, system] of systems.entries()) {
		const placement = partClefs
			? alignStaves(system.map(clefToken), partClefs)
			: system.map((_, i) => (i < parts ? i : -1));
		const byPart: (string | null)[] = Array.from({ length: parts }, () => null);
		placement.forEach((p, i) => {
			if (p >= 0) byPart[p] = system[i];
		});
		const staffMeasures = byPart.map((xml) => (xml ? measuresOf(xml) : []));
		const count = Math.max(0, ...staffMeasures.map((m) => m.length));
		measuresPerSystem.push(count);
		// Signatures from the first staff of the system that carries them.
		const firstAttributes = staffMeasures
			.map((m) => (m[0] ? element(inner(m[0]), 'attributes') : null))
			.filter((a): a is string => a !== null);
		const key = firstAttributes.map((a) => element(a, 'key')).find((k) => k) ?? null;
		const time = firstAttributes.map((a) => element(a, 'time')).find((t) => t) ?? null;
		for (let k = 0; k < parts; k++) {
			const measures = [...(staffMeasures[k] ?? [])];
			if (measures.length) measures[0] = withSignatures(measures[0], key, time);
			while (measures.length < count) measures.push('<measure/>');
			// The system break sits on the first measure of the first part.
			if (k === 0 && s > 0 && measures.length) {
				measures[0] = measures[0]
					.replace(/^<measure\b[^>]*\/>$/, (tag) => `${tag.slice(0, -2)}></measure>`)
					.replace(/^(<measure\b[^>]*>)/, '$1<print new-system="yes"/>');
			}
			perPart[k].push(...measures);
		}
	}
	const partList = perPart
		.map((_, k) => `<score-part id="P${k + 1}"><part-name>Staff ${k + 1}</part-name></score-part>`)
		.join('');
	const partXml = perPart
		.map(
			(measures, k) =>
				`<part id="P${k + 1}">` +
				measures
					.map((m, i) => m.replace(/^<measure\b([^>]*?)(\/?)>/, (_tag, attrs: string, slash: string) => {
						const rest = attrs.replace(/\s+number="[^"]*"/, '');
						return `<measure number="${i + 1}"${rest}${slash}>`;
					}))
					.join('') +
				`</part>`
		)
		.join('');
	return {
		musicxml:
			`<?xml version="1.0" encoding="UTF-8"?>` +
			`<score-partwise version="3.1"><part-list>${partList}</part-list>${partXml}</score-partwise>`,
		measuresPerSystem,
		parts
	};
}
