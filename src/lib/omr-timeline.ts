// A piece's recognised staves read through in order, from its score and its
// recognition record: each page's systems with the record's entry for every
// staff box, the score staff each box is placed on (solved system after
// system through the piece, each system placed with the clefs in force and
// the staves the system before it showed, and the volunteers' placements
// from the record kept), and the transcriptions with the recorded clef
// corrections applied. From these the clef per staff,
// the key and the meter in force at any page start are computed by stitching
// the pages before it, so a page draft continues where the piece stands. Pure
// functions, no DOM.

import type { MeasureBox, ParsedFacsimile } from './mei-facsimile.ts';
import { pageSystems } from './omr-layout.ts';
import { clefToken, correctClef, fifthsFor, staffClefToken, type ClefCorrectionState } from './omr-musicxml.ts';
import type { OmrRecord, OmrStaffEntry } from './omr-record.ts';
import { suggestStaffAssignment, type ScoreStaff } from './omr-staff-assign.ts';
import { clefTokenOf, stitchPage, type PageSignatures } from './omr-stitch.ts';

export interface PageStaves {
	/** 1-based. */
	page: number;
	systems: MeasureBox[][];
	/** Staff boxes on no system. */
	unplaced: number;
	/** The staff zone id of each box. */
	zones: string[][];
	/** The record's entry for each box; null where the record does not describe the box. */
	entries: (OmrStaffEntry | null)[][];
	/** The score staff (1-based) each box shows; 0 for none. */
	assigned: number[][];
	/** Each box's transcription with the clef corrections applied; null for none. */
	transcriptions: (string | null)[][];
}

const sameBox = (a: MeasureBox, b: MeasureBox): boolean =>
	a.ulx === b.ulx && a.uly === b.uly && a.lrx === b.lrx && a.lry === b.lry;

/** The score's staves for the staff assignment: clef token without octave and label. */
export const scoreStaves = (parsed: Pick<ParsedFacsimile, 'scoreDef'>): ScoreStaff[] =>
	parsed.scoreDef.staves.map((s) => ({
		clef: s.clefShape === 'perc' || s.clefShape === 'TAB' ? s.clefShape : `${s.clefShape}${s.clefLine}`,
		label: s.label
	}));

/** A clef token without its octave, as the staff assignment compares clefs. */
const plainClef = (token: string | null): string | null => token?.replace(/[+-]\d$/, '') ?? null;

/**
 * Every page's staves, in page order. `parts` are the score staves the boxes
 * are placed on (the score's, unless a proposal is being made). The clef
 * corrections apply from the piece's start: to every staff placed on a
 * corrected score staff, system after system, until a clef read as anything
 * else than the misread one.
 */
export function pieceStaves(
	parsed: Pick<ParsedFacsimile, 'pages'>,
	record: OmrRecord,
	parts: ScoreStaff[]
): PageStaves[] {
	const reference = parsed.pages
		.flatMap((p) => pageSystems(p).systems)
		.find((system) => system.length === parts.length);
	const correcting = new Map(record.clefs.map((c) => [c.staff, 'misread' as ClefCorrectionState]));
	const fixed = new Map(record.assignments.map((a) => [a.zone, a.staff]));
	const clefs: (string | null)[] = parts.map((part) => part.clef);
	let previous: number[] = [];
	return parsed.pages.map((pg, p) => {
		const page = p + 1;
		const staves = pg.staves ?? [];
		const recorded = record.pages.find((r) => r.n === page)?.staves ?? [];
		const { systems, unplaced } = pageSystems(pg);
		const zones = systems.map((system) => system.map((box) => `staff-zone-${page}-${staves.indexOf(box) + 1}`));
		const entries = systems.map((system, s) =>
			system.map((box, i) => {
				const entry = recorded.find((e) => e.zone === zones[s][i]);
				return entry && sameBox(entry.box, box) ? entry : null;
			})
		);
		const assigned: number[][] = [];
		const transcriptions: (string | null)[][] = [];
		systems.forEach((system, s) => {
			const placed = suggestStaffAssignment(
				system.map((box, i) => ({
					box,
					clef: clefToken(entries[s][i]?.musicxml ?? null),
					label: entries[s][i]?.label ?? ''
				})),
				parts,
				reference,
				{
					// A staff still under a correction is read in the misread clef.
					clefs: clefs.map((clef, k) => {
						const correction = record.clefs.find((c) => c.staff === k + 1);
						return correction && correcting.get(k + 1) === 'misread' ? plainClef(correction.read) : clef;
					}),
					previous,
					fixed: zones[s].map((zone) => fixed.get(zone))
				}
			);
			assigned.push(placed);
			transcriptions.push(
				entries[s].map((entry, i) => {
					let xml = entry?.musicxml ?? null;
					const correction = record.clefs.find((c) => c.staff === placed[i]);
					if (xml && correction) {
						const result = correctClef(xml, correction.read, correction.corrected, correcting.get(correction.staff)!);
						xml = result.musicxml;
						correcting.set(correction.staff, result.state);
					}
					// The last clef the staff holds is in force on its score staff.
					const last = xml?.match(/<clef\b[^>]*>[\s\S]*?<\/clef>/g)?.pop();
					if (last && placed[i] > 0) clefs[placed[i] - 1] = plainClef(clefTokenOf(last));
					return xml;
				})
			);
			if (system.length) previous = placed.filter((n) => n > 0);
		});
		return { page, systems, unplaced, zones, entries, assigned, transcriptions };
	});
}

/** A page's placements for stitchPage: the 0-based part of each box, -1 for none. */
export const placementsOf = (staves: PageStaves): number[][] =>
	staves.assigned.map((system) => system.map((n) => n - 1));

/**
 * The clef per score staff, the key and the meter in force at the start of
 * `page` (1-based): the score definition's, carried through the pages before
 * it as the stitching reads them.
 */
export function pageStart(
	parsed: Pick<ParsedFacsimile, 'scoreDef'>,
	pages: PageStaves[],
	page: number
): { clefs: string[] } & PageSignatures {
	const { keysig, meterCount, meterUnit, meterSym } = parsed.scoreDef;
	let state: { clefs: string[] } & PageSignatures = {
		clefs: parsed.scoreDef.staves.map(staffClefToken),
		fifths: fifthsFor(keysig),
		time: {
			beats: meterCount,
			beatType: meterUnit,
			symbol: meterSym === 'common' || meterSym === 'cut' ? meterSym : ''
		}
	};
	for (const staves of pages.slice(0, page - 1)) {
		state = stitchPage(staves.transcriptions, state.clefs, placementsOf(staves), state).end;
	}
	return state;
}

/**
 * The clef each score staff opens with in the recognition: the first clef of
 * the first box placed on it, in page and system order, as the model read it
 * (no corrections applied); null for a staff no transcribed box shows.
 */
export function openingClefs(pages: PageStaves[], staffCount: number): (string | null)[] {
	const clefs: (string | null)[] = Array.from({ length: staffCount }, () => null);
	for (const staves of pages) {
		staves.entries.forEach((system, s) =>
			system.forEach((entry, i) => {
				const n = staves.assigned[s][i];
				const clef = entry?.musicxml ? /<clef\b[^>]*>[\s\S]*?<\/clef>/.exec(entry.musicxml)?.[0] : undefined;
				if (n > 0 && n <= staffCount && clefs[n - 1] === null && clef) clefs[n - 1] = clefTokenOf(clef);
			})
		);
	}
	return clefs;
}
