// Stitching the staff model's per-staff MusicXML into one page-level MusicXML
// document: one part per staff of the score definition, the systems following
// one another with a system break at each start. Each system places its
// staves on the parts given for it (the score setup's staff assignment), and
// the parts a system leaves out get empty measures. Regex over the document
// text, no DOM.
//
// Clefs: every clef the staff model read is kept. Each part carries the clef
// in force from the page start (the caller's clef per part) through the
// systems; a system's opening clef equal to it is the repeated system clef
// and is dropped, a different one is a change and is kept, and a staff
// without a clef continues in the clef in force. A part a system leaves out
// keeps its clef. The page opens at its first system with measures. Where
// that system's opening clef differs from the clef in force at the page
// start, the stitched part opens in the recognised clef
// and `opening.clefs` names it, since verovio writes a part's first clef into
// its staff definition, which the draft does not take over. Every part opens
// with an <attributes> block holding at least its clef: verovio drops a part
// whose first measure has none and numbers the remaining staves
// consecutively, which would shift every staff below it.
//
// Key and meter: the staff model reads an unprinted signature as none and
// misreads printed ones at times, reading a signature on a single staff where
// none is printed. A system changes the key or the meter only when more than
// half of its transcribed staves read the same value, different from the
// value in force, and no staff reads another. Otherwise the value in force
// stays; a staff without a signature never changes it. Every part's first
// measure of the page holds the key and meter in force after the opening
// system; later systems hold them only where they change. A change in the
// opening system is reported in `opening` for the same reason as its clefs.
//
// Staves of one system may disagree on their measure count; the shorter ones
// are padded with empty measures so the parts stay aligned, and the count
// each system ends up with is reported for the draft insertion to check
// against the measure boxes.

/** One system's transcriptions, top staff first; null for a staff that was not transcribed. */
export type SystemTranscriptions = (string | null)[];

/** A MusicXML time signature: `symbol` is 'common', 'cut' or ''. */
export interface Meter {
	beats: string;
	beatType: string;
	symbol: string;
}

/** Key (fifths, negative for flats) and meter in force at the page start. */
export interface PageSignatures {
	fifths: number;
	time: Meter | null;
}

/** What the page's opening system (its first with measures) changes against the page start. */
export interface PageOpening {
	/** Per part: the clef token the opening system reads where it differs from the clef in force, else null. */
	clefs: (string | null)[];
	/** The new key, or null when the key in force stays. */
	fifths: number | null;
	/** The new meter, or null when the meter in force stays. */
	time: Meter | null;
}

export interface StitchedPage {
	musicxml: string;
	/** Measures per system after padding, in system order. */
	measuresPerSystem: number[];
	/** How many parts (staves per system) the page has. */
	parts: number;
	opening: PageOpening;
	/** The clef per part, key and meter in force at the end of the page: the next page's start. */
	end: { clefs: string[] } & PageSignatures;
}

const DEFAULT_LINE: Record<string, number> = { G: 2, F: 4, C: 3 };

/**
 * A MusicXML <clef> for a clef token: `G2`, `F4`, `C3`, with an octave change
 * as a signed suffix (`G2-1` for a treble clef an octave down), `perc`, `TAB`.
 */
export function clefXml(token: string): string {
	if (token === 'perc') return '<clef><sign>percussion</sign></clef>';
	if (token === 'TAB') return '<clef><sign>TAB</sign></clef>';
	const m = /^([A-Z])(\d)([+-]\d)?$/.exec(token);
	if (!m) return '<clef><sign>G</sign><line>2</line></clef>';
	const octave = m[3] ? `<clef-octave-change>${Number(m[3])}</clef-octave-change>` : '';
	return `<clef><sign>${m[1]}</sign><line>${m[2]}</line>${octave}</clef>`;
}

/** The token of a MusicXML <clef> element; see `clefXml`. */
export function clefTokenOf(clef: string): string | null {
	const sign = /<sign>\s*([^<]*?)\s*<\/sign>/.exec(clef)?.[1];
	if (!sign) return null;
	if (sign === 'percussion') return 'perc';
	if (sign === 'TAB') return 'TAB';
	const line = /<line>\s*(\d+)\s*<\/line>/.exec(clef)?.[1] ?? DEFAULT_LINE[sign] ?? 2;
	const octave = Number(/<clef-octave-change>\s*(-?\d+)\s*<\/clef-octave-change>/.exec(clef)?.[1] ?? 0);
	return `${sign}${line}${octave ? (octave > 0 ? `+${octave}` : `${octave}`) : ''}`;
}

const keyXml = (fifths: number): string => `<key><fifths>${fifths}</fifths></key>`;

const timeXml = (time: Meter): string =>
	`<time${time.symbol ? ` symbol="${time.symbol}"` : ''}><beats>${time.beats}</beats><beat-type>${time.beatType}</beat-type></time>`;

function fifthsOf(key: string): number | null {
	const fifths = /<fifths>\s*(-?\d+)\s*<\/fifths>/.exec(key)?.[1];
	return fifths === undefined ? null : Number(fifths);
}

function meterOf(time: string): Meter | null {
	const beats = /<beats>\s*([^<]*?)\s*<\/beats>/.exec(time)?.[1];
	const beatType = /<beat-type>\s*([^<]*?)\s*<\/beat-type>/.exec(time)?.[1];
	if (!beats || !beatType) return null;
	const symbol = /\bsymbol="(common|cut)"/.exec(time)?.[1] ?? '';
	return { beats, beatType, symbol };
}

// Common and cut time are 4/4 and 2/2 with a symbol; the staff model writes
// the numbers without it, so the symbol does not make a meter another one.
const sameMeter = (a: Meter | null, b: Meter | null): boolean =>
	!!a && !!b && a.beats === b.beats && a.beatType === b.beatType;

/** The `<measure>` elements of a single-part MusicXML document, in order. */
function measuresOf(musicxml: string): string[] {
	const part = /<part\b[^>]*>([\s\S]*?)<\/part>/.exec(musicxml)?.[1] ?? '';
	return part.match(/<measure\b[^>]*>[\s\S]*?<\/measure>|<measure\b[^>]*\/>/g) ?? [];
}

const inner = (measure: string): string =>
	/<measure\b[^>]*\/>/.test(measure) ? '' : measure.replace(/^<measure\b[^>]*>/, '').replace(/<\/measure>$/, '');

const element = (xml: string, tag: string): string | null =>
	new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>|<${tag}\\b[^>]*/>`).exec(xml)?.[0] ?? null;

/** The first `<attributes>` of a measure, when it comes before the measure's first note. */
function openingAttributes(measure: string): string | null {
	const body = inner(measure);
	const attributes = element(body, 'attributes');
	if (!attributes) return null;
	const note = body.search(/<note\b/);
	return note < 0 || body.indexOf(attributes) < note ? attributes : null;
}

/** Per element: undefined leaves it, null removes it, a string sets it. */
interface AttributeEdits {
	key?: string | null;
	time?: string | null;
	clef?: string | null;
}

/**
 * A measure with its opening `<attributes>` edited, in MusicXML's element
 * order (divisions, key, time, the rest, clef last). A measure without
 * opening attributes gets a block when an edit sets something, with
 * divisions 1 when `divisions` is set. A block left empty is removed.
 */
function editAttributes(measure: string, edits: AttributeEdits, divisions = false): string {
	const attributes = openingAttributes(measure);
	if (!attributes && !edits.key && !edits.time && !edits.clef) return measure;
	const current = attributes ? attributes.replace(/^<attributes\b[^>]*>/, '').replace(/<\/attributes>$/, '') : '';
	const pick = (tag: 'key' | 'time' | 'clef') => {
		const edit = edits[tag];
		return edit === undefined ? (element(current, tag) ?? '') : (edit ?? '');
	};
	const ownDivisions = element(current, 'divisions') ?? (divisions ? '<divisions>1</divisions>' : '');
	const rest = ['divisions', 'key', 'time', 'clef'].reduce(
		(xml, tag) => xml.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>|<${tag}\\b[^>]*/>`, 'g'), ''),
		current
	);
	const content = `${ownDivisions}${pick('key')}${pick('time')}${rest}${pick('clef')}`;
	const rebuilt = content ? `<attributes>${content}</attributes>` : '';
	const body = inner(measure);
	const open = /^<measure\b[^>]*>/.exec(measure)![0].replace(/\/>$/, '>');
	const newBody = attributes ? body.replace(attributes, rebuilt) : rebuilt + body;
	return newBody ? `${open}${newBody}</measure>` : `${open.slice(0, -1)}/>`;
}

/**
 * Stitch the systems of one page into a page-level score with one part per
 * entry of `partClefs` (the clef in force on each staff of the score
 * definition at the page start, top to bottom, as clef tokens).
 * `placements[s][i]` is the part (0-based) staff i of system s goes to; -1,
 * or a part beyond the definition, leaves the staff out. `start` is the key
 * and meter in force at the page start.
 */
export function stitchPage(
	systems: SystemTranscriptions[],
	partClefs: string[],
	placements: number[][],
	start: PageSignatures = { fifths: 0, time: null }
): StitchedPage {
	const parts = partClefs.length;
	const perPart: string[][] = Array.from({ length: parts }, () => []);
	const measuresPerSystem: number[] = [];
	const clefs = [...partClefs];
	let fifths = start.fifths;
	let time = start.time;
	const opening: PageOpening = { clefs: Array.from({ length: parts }, () => null), fifths: null, time: null };
	// The page opens at the first system with measures: its measures hold each
	// part's opening attributes, and its changes are the page's opening.
	let opened = false;
	for (const [s, system] of systems.entries()) {
		const byPart: (string | null)[] = Array.from({ length: parts }, () => null);
		(placements[s] ?? []).forEach((p, i) => {
			if (p >= 0 && p < parts) byPart[p] = system[i] ?? null;
		});
		const staffMeasures = byPart.map((xml) => (xml ? measuresOf(xml) : []));
		const count = Math.max(0, ...staffMeasures.map((m) => m.length));
		measuresPerSystem.push(count);
		const opens: boolean = !opened && count > 0;
		opened ||= opens;

		// Key and meter change only on a majority of the transcribed staves, none reading another.
		const transcribed = byPart.filter((xml) => xml !== null).length;
		const firsts = staffMeasures
			.map((m) => (m[0] ? openingAttributes(m[0]) : null))
			.filter((a): a is string => a !== null);
		const keys = firsts.map((a) => element(a, 'key')).filter((k): k is string => !!k).map(fifthsOf);
		const newFifths =
			keys.length * 2 > transcribed && keys.every((k) => k !== null && k === keys[0]) && keys[0] !== fifths
				? keys[0]
				: null;
		const times = firsts.map((a) => element(a, 'time')).filter((t): t is string => !!t).map(meterOf);
		const newTime =
			times.length * 2 > transcribed && times.every((t) => sameMeter(t, times[0])) && !sameMeter(times[0], time)
				? times[0]
				: null;
		if (newFifths !== null) fifths = newFifths;
		if (newTime) time = newTime;
		if (opens) {
			opening.fifths = newFifths;
			opening.time = newTime;
		}
		const signatures: AttributeEdits =
			opens
				? { key: keyXml(fifths), time: time ? timeXml(time) : null }
				: { key: newFifths !== null ? keyXml(fifths) : null, time: newTime ? timeXml(newTime) : null };

		for (let k = 0; k < parts; k++) {
			const measures = [...(staffMeasures[k] ?? [])];
			const inForce = clefs[k];
			const read = measures[0] ? element(openingAttributes(measures[0]) ?? '', 'clef') : null;
			const token = read ? clefTokenOf(read) : null;
			let clef: string | null | undefined;
			if (opens) {
				if (token && token !== inForce) opening.clefs[k] = token;
				clef = token ? read : clefXml(inForce);
			} else {
				clef = token === inForce ? null : undefined;
			}
			// Every clef the staff holds, in order, leaves the last one in force.
			for (const c of measures.join('').match(/<clef\b[^>]*>[\s\S]*?<\/clef>/g) ?? []) {
				clefs[k] = clefTokenOf(c) ?? clefs[k];
			}
			while (measures.length < count) measures.push('<measure/>');
			if (measures.length) measures[0] = editAttributes(measures[0], { ...signatures, clef }, opens);
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
		parts,
		opening,
		end: { clefs, fifths, time }
	};
}
