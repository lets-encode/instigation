// Stitching the staff model's per-staff MusicXML into one page-level MusicXML
// document: one part per staff of the score definition, the systems following
// one another with a system break at each start. Each system places its
// staves on the parts given for it (the score setup's staff assignment), and
// the parts a system leaves out get empty measures. Each placed staff is put
// into its part's clef (toClef): the score definition's clef is trusted over
// the one the staff model read, which it misreads at times, and a later
// system then opens without a clef change. Every part opens with an
// <attributes> block holding at least its clef: verovio drops a part whose
// first measure has none and numbers the remaining staves consecutively,
// which would shift every staff below it. Regex over the document text, no
// DOM.
//
// The staff model transcribes one staff at a time and reads an unprinted key
// or time signature as none, so within a system the key and the time of the
// first staff that carries them are copied to the staves that do not. Staves
// of one system may disagree on their measure count; the shorter ones are
// padded with empty measures so the parts stay aligned, and the count each
// system ends up with is reported for the draft insertion to check against
// the measure boxes.

import { toClef } from './omr-musicxml.ts';

/** One system's transcriptions, top staff first; null for a staff that was not transcribed. */
export type SystemTranscriptions = (string | null)[];

export interface StitchedPage {
	musicxml: string;
	/** Measures per system after padding, in system order. */
	measuresPerSystem: number[];
	/** How many parts (staves per system) the page has. */
	parts: number;
}

/** A MusicXML <clef> for a clef token (`G2`, `F4`, `perc`, `TAB`). */
function clefXml(token: string): string {
	if (token === 'perc') return '<clef><sign>percussion</sign></clef>';
	if (token === 'TAB') return '<clef><sign>TAB</sign></clef>';
	const m = /^([A-Z])(\d)$/.exec(token);
	return m ? `<clef><sign>${m[1]}</sign><line>${m[2]}</line></clef>` : '<clef><sign>G</sign><line>2</line></clef>';
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
 * Stitch the systems of one page into a page-level score with one part per
 * entry of `partClefs` (the score definition's staves, top to bottom, as clef
 * tokens). `placements[s][i]` is the part (0-based) staff i of system s goes
 * to; -1, or a part beyond the definition, leaves the staff out.
 */
export function stitchPage(
	systems: SystemTranscriptions[],
	partClefs: string[],
	placements: number[][]
): StitchedPage {
	const parts = partClefs.length;
	const perPart: string[][] = Array.from({ length: parts }, () => []);
	const measuresPerSystem: number[] = [];
	for (const [s, system] of systems.entries()) {
		const byPart: (string | null)[] = Array.from({ length: parts }, () => null);
		(placements[s] ?? []).forEach((p, i) => {
			const xml = system[i] ?? null;
			if (p >= 0 && p < parts) byPart[p] = xml && toClef(xml, partClefs[p]);
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
			// The part's clef carries on from the system before.
			if (s > 0 && measures.length) measures[0] = measures[0].replace(/<clef\b[^>]*>[\s\S]*?<\/clef>/, '');
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
	perPart.forEach((measures, k) => {
		if (!measures.length || element(inner(measures[0]), 'attributes')) return;
		const open = /^<measure\b[^>]*?\/?>/.exec(measures[0])![0].replace(/\/>$/, '>');
		measures[0] = `${open}<attributes><divisions>1</divisions>${clefXml(partClefs[k])}</attributes>${inner(measures[0])}</measure>`;
	});
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
