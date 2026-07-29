// The pieces a campaign is divided into: the distinct works within one physical
// source. A facsimile piece is defined by the regions of the page images it
// covers; an encoded piece comes from an uploaded MEI or MusicXML and has no
// regions. Each piece becomes one MEI and one group of tasks.
//
// Pure data and helpers — no DOM, forge or network access.

import { emptySourceMetadata, type SourceMetadata } from './source-metadata.ts';

/** A rectangle on one page image, in that image's own pixel coordinates. */
export interface PieceZone {
	/** Index of the page the region sits on, 0-based. */
	surface: number;
	ulx: number;
	uly: number;
	lrx: number;
	lry: number;
}

/**
 * How a piece's notation reaches the campaign: regions of the facsimile that
 * volunteers encode, or an encoding the organiser already had.
 */
export type PieceKind = 'facsimile' | 'encoded';

export interface Piece {
	/** Stable within a campaign; also the directory its MEI is written to. */
	id: string;
	kind: PieceKind;
	/** Regions this piece covers. Always empty for an encoded piece. */
	zones: PieceZone[];
	meta: SourceMetadata;
	/** For an encoded piece, the uploaded file it came from. */
	encodingName?: string;
}

/** How many distinct colours the editor cycles through for piece regions. */
export const PIECE_COLOURS = 8;

/**
 * The CSS custom property colouring a piece's regions. Colours repeat once
 * there are more pieces than distinct hues, so the index is what identifies a
 * piece to the eye, not the colour alone.
 */
export function pieceColour(index: number): string {
	return `var(--zone-${(index % PIECE_COLOURS) + 1})`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** An id not already taken by `pieces`, numbered from the count upwards. */
export function nextPieceId(pieces: Piece[]): string {
	const taken = new Set(pieces.map((piece) => piece.id));
	let n = pieces.length + 1;
	while (taken.has(`piece-${pad2(n)}`)) n++;
	return `piece-${pad2(n)}`;
}

export function createPiece(pieces: Piece[], kind: PieceKind = 'facsimile'): Piece {
	return { id: nextPieceId(pieces), kind, zones: [], meta: emptySourceMetadata() };
}

/**
 * A deep copy of another piece's metadata, for the "copy from previous piece"
 * control — pieces in one source usually share composer and publication data.
 */
export function copyMetadata(meta: SourceMetadata): SourceMetadata {
	return {
		...meta,
		contributors: meta.contributors.map((person) => ({ ...person }))
	};
}

/** The pages a piece covers, ascending and without repeats. */
export function pagesCovered(piece: Piece): number[] {
	return [...new Set(piece.zones.map((zone) => zone.surface))].sort((a, b) => a - b);
}

/**
 * Ascending numbers without repeats, written as ranges: [1, 2, 3, 7, 8] becomes
 * "1–3, 7–8". A run of one number stays a single number.
 */
export function formatRanges(numbers: number[]): string {
	const runs: Array<[number, number]> = [];
	for (const n of numbers) {
		const last = runs.at(-1);
		if (last && n === last[1] + 1) last[1] = n;
		else runs.push([n, n]);
	}
	return runs.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(', ');
}

/** Whether two regions share any area of the same page. */
export function zonesOverlap(a: PieceZone, b: PieceZone): boolean {
	return (
		a.surface === b.surface && a.ulx < b.lrx && b.ulx < a.lrx && a.uly < b.lry && b.uly < a.lry
	);
}

/**
 * The first piece other than `index` holding a region that overlaps `zone`, or
 * -1 when none does. Regions of different pieces must not overlap: a measure
 * inside two of them could belong to either.
 */
export function overlappingPiece(pieces: Piece[], index: number, zone: PieceZone): number {
	return pieces.findIndex(
		(piece, p) => p !== index && piece.zones.some((other) => zonesOverlap(other, zone))
	);
}

/**
 * Which piece a measure box belongs to: the first piece with a region on that
 * page containing the box's centre. Returns -1 when no region covers it, so the
 * caller can drop boxes that fall outside every piece.
 *
 * Centre containment (rather than full overlap) keeps a measure whose detected
 * box bleeds slightly past a hand-drawn region.
 */
export function pieceForBox(
	pieces: Piece[],
	surface: number,
	box: { ulx: number; uly: number; lrx: number; lry: number }
): number {
	const cx = (box.ulx + box.lrx) / 2;
	const cy = (box.uly + box.lry) / 2;
	return pieces.findIndex((piece) =>
		piece.zones.some(
			(zone) =>
				zone.surface === surface &&
				cx >= zone.ulx &&
				cx <= zone.lrx &&
				cy >= zone.uly &&
				cy <= zone.lry
		)
	);
}

/** A detected page: the committed image, its size, and the boxes found on it. */
export interface DetectedPage {
	/** The MEI graphic target, relative to the piece's score file. */
	image: string;
	width: number;
	height: number;
	boxes: Array<{ ulx: number; uly: number; lrx: number; lry: number }>;
}

/** One piece's share of the source: the pages it covers and the boxes on them. */
export interface PiecePages {
	pages: Array<DetectedPage & { measures: DetectedPage['boxes'] }>;
	/**
	 * 1-based indices into `pages` that carry at least one measure — the tasks
	 * this piece is split into.
	 *
	 * These are the piece's OWN surface numbers, not the source's page numbers:
	 * a piece MEI numbers its surfaces from 1, so a task locator addressing the
	 * source's page 3 would miss. Callers pass these to buildTaskCsv.
	 */
	measuredSurfaces: number[];
}

/**
 * Split detected pages between the pieces: each piece keeps the pages it covers
 * and, on them, only the boxes its own regions contain. Boxes covered by no
 * piece are dropped.
 *
 * A piece keeps every page it covers, even one where nothing was detected, so
 * its surface numbering stays continuous and stable.
 */
export function partitionPages(pieces: Piece[], detected: DetectedPage[]): PiecePages[] {
	// Which piece each box belongs to, resolved once per box.
	const owners = detected.map((page, surface) =>
		page.boxes.map((box) => pieceForBox(pieces, surface, box))
	);
	return pieces.map((piece, p) => {
		if (piece.kind !== 'facsimile') return { pages: [], measuredSurfaces: [] };
		const covered = pagesCovered(piece);
		const pages = covered
			.filter((surface) => detected[surface])
			.map((surface) => {
				const page = detected[surface];
				const measures = page.boxes.filter((_box, b) => owners[surface][b] === p);
				return { ...page, boxes: measures, measures };
			});
		const measuredSurfaces = pages.flatMap((page, i) => (page.measures.length ? [i + 1] : []));
		return { pages, measuredSurfaces };
	});
}

/**
 * The pieces a fresh campaign starts with: one per uploaded encoding, plus a
 * single facsimile piece covering the pages when there are any. An organiser
 * with one work per source then has nothing to add.
 */
export function initialPieces(encodingNames: string[], hasImages: boolean): Piece[] {
	const pieces: Piece[] = [];
	for (const name of encodingNames) {
		const piece = createPiece(pieces, 'encoded');
		piece.encodingName = name;
		// The file name is the only title known before the organiser edits it.
		piece.meta.title = name.replace(/\.[^.]+$/, '');
		pieces.push(piece);
	}
	if (hasImages) pieces.push(createPiece(pieces, 'facsimile'));
	return pieces;
}
