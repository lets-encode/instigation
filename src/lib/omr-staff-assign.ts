// Suggesting which staff of the score definition each staff box of a system
// shows. A system may print only some of the definition's staves (an
// orchestral score leaves out the instruments that rest), so a box's position
// in its system does not give its staff. The suggestion keeps the system's
// order and places its staves on the definition's: a staff scores for a clef
// equal to the definition staff's and more for a printed label (as OCR read
// it) that abbreviates the staff's label, and each gap between neighbouring
// boxes is compared with the widest gap a reference system (one box per
// definition staff) has across the same staves, so a wide gap such as the one between
// winds and strings falls on a group boundary. Among equal placements the one
// using the earlier staves wins. Pure functions, no DOM.

import type { MeasureBox } from './mei-facsimile.ts';

/** Gap ratios within this factor of the reference (as a log difference) cost nothing. */
const GAP_TOLERANCE = 0.1;
/** Gaps are measured in multiples of the system's median gap, and floored here. */
const MIN_GAP = 0.05;
const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Labels

const ROMAN = /^(i{1,3}|iv|vi{0,3}|v)$/;

/** Letter words and roman numerals of a label. */
interface LabelParts {
	words: string[];
	numerals: string[];
}

/** The words and numerals of a label, lower case, without accents. */
function labelParts(text: string): LabelParts {
	const tokens = text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		// Hyphenated initials are one abbreviation ("K.-B." for Kontrabass).
		.replace(/\b([a-z])\.?-([a-z])\b/g, '$1$2')
		// OCR reads an l after a capital as 1 or | ("F1." for "Fl."), and the
		// letters of a roman numeral on its own as 1, l or | ("Il" for II).
		.replace(/\b([a-z])[1|]/g, '$1l')
		.replace(/(^|[^a-z0-9])[il1|]+(?=$|[^a-z0-9])/g, (m, lead: string) => lead + 'i'.repeat(m.length - lead.length))
		.replace(/(?<=[a-z]{2})[1|]+/g, (m) => ` ${'i'.repeat(m.length)}`)
		.split(/[^a-z]+/)
		.filter(Boolean);
	return {
		words: tokens.filter((t) => !ROMAN.test(t)),
		numerals: tokens.filter((t) => ROMAN.test(t))
	};
}

/**
 * Instrument names that stand for one another in printed labels: German,
 * Italian and English names of the orchestral instruments. A label word in a
 * group matches an abbreviation of any word of the group ("Br." for Viola).
 */
const SYNONYMS = [
	['flote', 'flauto', 'flute', 'piccolo'],
	['oboe', 'oboi', 'hoboe'],
	['klarinette', 'clarinetto', 'clarinet'],
	['fagott', 'fagotto', 'bassoon'],
	['horn', 'corno', 'corni'],
	['trompete', 'tromba', 'trombe', 'trumpet'],
	['posaune', 'trombone', 'tromboni'],
	['tuba'],
	['pauken', 'pauke', 'timpani'],
	['violine', 'violino', 'violini', 'violin', 'geige'],
	['viola', 'bratsche', 'viole'],
	['violoncello', 'violoncelli', 'cello'],
	['kontrabass', 'contrabasso', 'contrabassi', 'bass', 'basso', 'bassi'],
	['harfe', 'arpa', 'harp']
];
const synonymsOf = (word: string): string[] => SYNONYMS.find((group) => group.includes(word)) ?? [word];

/** Whether `abbr` abbreviates `word`: same first letter, its letters in order. */
function abbreviates(abbr: string, word: string): boolean {
	if (abbr[0] !== word[0]) return false;
	let j = 0;
	for (const c of word) if (c === abbr[j]) j++;
	return j === abbr.length;
}

/**
 * How well a reading matches a staff's label: 0 for no evidence, 2 when a
 * read word abbreviates a word of the label, one more when the roman numerals
 * agree (half for a part of them), 2 less when they disagree.
 */
function partsScore(read: LabelParts, label: string): number {
	const def = labelParts(label);
	const words = def.words.filter((w) => w.length >= 3).flatMap(synonymsOf);
	if (!read.words.some((r) => r.length >= 2 && words.some((w) => abbreviates(r, w)))) return 0;
	if (!read.numerals.length || !def.numerals.length) return 2;
	if (!read.numerals.every((n) => def.numerals.includes(n))) return 0;
	return new Set(read.numerals).size === def.numerals.length ? 3 : 2.5;
}

/**
 * A printed label as read, its words split from numerals OCR joined to them
 * ("ViolII"): a word gives up a trailing run of i/l as numerals when that
 * matches one of the score's `labels` better. On a tie the split whose word
 * ends in a consonant wins, as printed abbreviations do ("Viol.", "Fl."),
 * then the longer run. A single trailing l of a word that abbreviates a
 * label word as it is ("Viol") stays a letter.
 */
function readLabel(printed: string, labels: string[]): LabelParts {
	const read = labelParts(printed);
	const out: LabelParts = { words: [], numerals: [...read.numerals] };
	const labelWords = labels.flatMap((label) => labelParts(label).words.filter((w) => w.length >= 3).flatMap(synonymsOf));
	for (const word of read.words) {
		const run = /[il]+$/.exec(word)?.[0] ?? '';
		const tail = run.length === 1 && labelWords.some((w) => abbreviates(word, w)) ? '' : run;
		let choice = { stem: word, extra: [] as string[], rank: [-1, 0] };
		for (let k = 0; k <= tail.length && word.length - k >= 3 - (k ? 0 : 1); k++) {
			const stem = k ? word.slice(0, -k) : word;
			const extra = k ? ['i'.repeat(k)] : [];
			const candidate = { words: [stem], numerals: [...read.numerals, ...extra] };
			const rank = [
				Math.max(0, ...labels.map((label) => partsScore(candidate, label))),
				/[aeiouy]$/.test(stem) ? 0 : 1
			];
			const better = rank[0] > choice.rank[0] || (rank[0] === choice.rank[0] && rank[1] >= choice.rank[1]);
			if (better) choice = { stem, extra, rank };
		}
		out.words.push(choice.stem);
		out.numerals.push(...choice.extra);
	}
	return out;
}

/**
 * How well a printed label (as OCR read it) matches a staff's `label`, read
 * against all the score's `labels`: 0 for no evidence, 2 for an abbreviation
 * of a word of the label, 3 with the roman numerals agreeing too.
 */
export function labelScore(printed: string, label: string, labels: string[] = [label]): number {
	return partsScore(readLabel(printed, labels), label);
}

// ---------------------------------------------------------------------------
// Assignment

/**
 * The vertical gaps between neighbouring boxes, in multiples of their lower
 * median: staff spacing differs between pages, and of an even count the
 * lower middle gap is the ordinary one when a system has a single wide gap.
 */
function relativeGaps(boxes: MeasureBox[]): number[] {
	const gaps = boxes.slice(1).map((box, i) => box.uly - boxes[i].lry);
	const sorted = [...gaps].sort((a, b) => a - b);
	const median = Math.max(1, sorted[Math.floor((sorted.length - 1) / 2)] ?? 1);
	return gaps.map((g) => Math.max(MIN_GAP, g / median));
}

/** A staff box of a system with what was read of it. */
export interface PrintedStaff {
	box: MeasureBox;
	/** The recognised clef token (`G2`, `F4`, `perc`); null when not read. */
	clef: string | null;
	/** The label printed in front of the staff, as read; '' for none. */
	label: string;
}

/** A staff of the score definition: its clef token and its label. */
export interface ScoreStaff {
	clef: string;
	label: string;
}

/**
 * The staff (1-based @n) each box of a system shows, top to bottom, or 0 for
 * a box left out (a system with more boxes than the definition has staves
 * leaves out its bottom ones). `reference` is a system with one box per
 * definition staff; without one, the gaps do not count.
 */
export function suggestStaffAssignment(
	printed: PrintedStaff[],
	parts: ScoreStaff[],
	reference?: MeasureBox[]
): number[] {
	const n = printed.length;
	const m = parts.length;
	if (n >= m) return printed.map((_, i) => (i < m ? i + 1 : 0));
	const gaps = relativeGaps(printed.map((s) => s.box));
	const refGaps = reference && reference.length === m ? relativeGaps(reference) : null;
	const labels = parts.map((part) => part.label);
	const readings = printed.map((staff) => (staff.label ? readLabel(staff.label, labels) : null));
	const staffScore = (i: number, p: number) =>
		(printed[i].clef !== null && printed[i].clef === parts[p].clef ? 1 : 0) +
		(readings[i] ? partsScore(readings[i], parts[p].label) : 0);
	// The cost of boxes i and i+1 showing staves p and q > p.
	const gapCost = (i: number, p: number, q: number) => {
		if (!refGaps) return 0;
		const ref = Math.max(...refGaps.slice(p, q));
		return Math.max(0, Math.abs(Math.log(gaps[i] / ref)) - GAP_TOLERANCE);
	};
	// best[i][p]: the best score of boxes i.. with box i on staff p.
	const best: number[][] = Array.from({ length: n }, () => Array<number>(m).fill(-Infinity));
	for (let i = n - 1; i >= 0; i--) {
		for (let p = i; p <= m - (n - i); p++) {
			let rest = 0;
			if (i < n - 1) {
				rest = -Infinity;
				for (let q = p + 1; q <= m - (n - i - 1); q++) {
					rest = Math.max(rest, best[i + 1][q] - gapCost(i, p, q));
				}
			}
			best[i][p] = staffScore(i, p) + rest;
		}
	}
	const out: number[] = [];
	let prev = -1;
	for (let i = 0; i < n; i++) {
		let choice = -1;
		let score = -Infinity;
		for (let p = prev + 1; p <= m - (n - i); p++) {
			const v = best[i][p] - (i > 0 ? gapCost(i - 1, prev, p) : 0);
			if (v > score + EPSILON) {
				score = v;
				choice = p;
			}
		}
		out.push(choice + 1);
		prev = choice;
	}
	return out;
}
