// Reading the staff model's MusicXML: the opening attributes of a transcribed
// staff (clef, key, time) and, from several staves, a proposed score
// definition for the setup editor. Regex over the document text, no DOM.

import type { ScoreDefModel, StaffModel } from './mei-facsimile.ts';

/** What the first `<attributes>` of a MusicXML part declares; absent parts are null. */
export interface StaffAttributes {
	clef: { sign: string; line: number; octaveChange: number } | null;
	/** `<key><fifths>`: negative for flats. */
	fifths: number | null;
	time: { beats: string; beatType: string; symbol: string } | null;
}

const text = (xml: string, tag: string): string | null =>
	new RegExp(`<${tag}\\b[^>]*>\\s*([^<]*?)\\s*</${tag}>`).exec(xml)?.[1] ?? null;

/** The first part's first `<attributes>` block, read for clef, key and time. */
export function readAttributes(musicxml: string): StaffAttributes {
	const block = /<attributes\b[^>]*>([\s\S]*?)<\/attributes>/.exec(musicxml)?.[1] ?? '';
	const clefXml = /<clef\b[^>]*>([\s\S]*?)<\/clef>/.exec(block)?.[1];
	const keyXml = /<key\b[^>]*>([\s\S]*?)<\/key>/.exec(block)?.[1];
	const timeTag = /<time\b([^>]*)>([\s\S]*?)<\/time>/.exec(block);
	const sign = clefXml ? text(clefXml, 'sign') : null;
	const fifths = keyXml ? text(keyXml, 'fifths') : null;
	const beats = timeTag ? text(timeTag[2], 'beats') : null;
	const beatType = timeTag ? text(timeTag[2], 'beat-type') : null;
	return {
		clef: sign
			? {
					sign,
					line: Number(text(clefXml!, 'line') ?? (sign === 'F' ? 4 : sign === 'C' ? 3 : 2)),
					octaveChange: Number(text(clefXml!, 'clef-octave-change') ?? 0)
				}
			: null,
		fifths: fifths !== null && /^-?\d+$/.test(fifths) ? Number(fifths) : null,
		time:
			beats && beatType
				? { beats, beatType, symbol: /\bsymbol="([^"]*)"/.exec(timeTag![1])?.[1] ?? '' }
				: null
	};
}

/** A plain treble staff, what a staff without readable attributes proposes. */
const TREBLE: StaffModel = {
	clefShape: 'G',
	clefLine: 2,
	clefDis: '',
	clefDisPlace: '',
	lines: 5,
	notationType: '',
	label: ''
};

function staffFor(attributes: StaffAttributes): StaffModel {
	const clef = attributes.clef;
	if (!clef) return { ...TREBLE };
	const shape =
		clef.sign === 'percussion' ? 'perc' : clef.sign === 'TAB' ? 'TAB' : clef.sign;
	const octaves = Math.abs(clef.octaveChange);
	return {
		...TREBLE,
		clefShape: shape,
		clefLine: clef.line,
		clefDis: octaves === 1 ? '8' : octaves === 2 ? '15' : '',
		clefDisPlace: octaves ? (clef.octaveChange < 0 ? 'below' : 'above') : ''
	};
}

/** MEI @keysig for a MusicXML fifths count: 0 → '0', 2 → '2s', -3 → '3f'. */
export const keysigFor = (fifths: number): string =>
	fifths === 0 ? '0' : `${Math.min(7, Math.abs(fifths))}${fifths > 0 ? 's' : 'f'}`;

/** A staff's clef as one token (`G2`, `F4`, `perc`), or null when unknown. */
export function clefToken(musicxml: string | null): string | null {
	const clef = musicxml ? readAttributes(musicxml).clef : null;
	if (!clef) return null;
	return clef.sign === 'percussion' ? 'perc' : clef.sign === 'TAB' ? 'TAB' : `${clef.sign}${clef.line}`;
}

/**
 * A score definition proposed from transcriptions: the clefs from one
 * system's staves, top to bottom (`clefSystem`, null for a staff that was
 * not transcribed — the system with the most staves, so every staff of the
 * definition gets its own clef); the key and the meter from the first staff
 * that carries them, searched through `signatureSources` first (the page's
 * opening system, where signatures are printed) and then the clef system,
 * since the model reads an unprinted signature as none. Groups are not
 * proposed. Missing values keep the defaults: treble clef, no accidentals,
 * 4/4.
 */
export function proposeScoreDef(
	clefSystem: (string | null)[],
	signatureSources: (string | null)[] = []
): ScoreDefModel {
	const read = clefSystem.map((xml) => (xml ? readAttributes(xml) : null));
	const staves = read.map((attributes) => (attributes ? staffFor(attributes) : { ...TREBLE }));
	const signatures = [...signatureSources.map((xml) => (xml ? readAttributes(xml) : null)), ...read];
	const fifths = signatures.find((a) => a?.fifths !== null && a?.fifths !== undefined)?.fifths ?? 0;
	const time = signatures.find((a) => a?.time)?.time ?? null;
	const symbol = time?.symbol === 'common' || time?.symbol === 'cut' ? time.symbol : '';
	return {
		staves: staves.length ? staves : [{ ...TREBLE }],
		groups: [],
		keysig: keysigFor(fifths),
		meterCount: symbol ? (symbol === 'cut' ? '2' : '4') : (time?.beats ?? '4'),
		meterUnit: symbol ? (symbol === 'cut' ? '2' : '4') : (time?.beatType ?? '4'),
		meterSym: symbol
	};
}
