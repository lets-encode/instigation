// Joining per-page encoding into the shared score. A facsimile campaign splits
// encoding into one task per page (locator `surface-N`); every volunteer edits
// a copy of the whole `sources/score.mei`, but a page task's accepted PR must
// contribute only that page's notation, leaving the other pages as they stand
// in the base file. Pure functions: MEI text in, MEI text out. No DOM,
// filesystem or network access.
//
// A page's extent is delimited by the `<pb/>` markers written at stage C
// (mei-facsimile.ts): the page's `<pb facs="#surface-N"/>` opens it and the
// next page's `<pb/>` (or the end of the enclosing element, on the last page)
// closes it. The join keeps the base file verbatim outside that span and takes
// the fork's span content wholesale, so everything the volunteer wrote inside
// their page — measures, a mid-piece <scoreDef>, added or removed measures —
// lands in the base. The base's own `<pb/>` markers stay authoritative: which
// surface follows the page comes from the base's page order, both spans are
// delimited by the same facs-matched `<pb>` elements, and the result is
// checked afterwards (assertSpliceIntegrity) so a fork that smuggles in a
// page break or a duplicate measure is rejected rather than merged.

import { escapeRegex } from './mei-xml.ts';

/** The first facs-matched `<pb>` for `surfaceId` at or after `from`. */
function pbTagAt(xml: string, surfaceId: string, from = 0): RegExpExecArray | null {
	const pb = new RegExp(`<pb\\b[^>]*\\bfacs="#${escapeRegex(surfaceId)}"[^>]*>`, 'g');
	pb.lastIndex = from;
	return pb.exec(xml);
}

/**
 * The page's span with its offsets: from `surfaceId`'s `<pb>` to
 * `nextSurfaceId`'s, or — for the last page (`nextSurfaceId` null) — to the
 * close of the enclosing element. Ending at the next surface's own marker
 * rather than at just any `<pb>` keeps a stray page break inside the span,
 * where the integrity checks see it, instead of silently truncating there.
 */
function pageSpanAt(
	xml: string,
	surfaceId: string,
	nextSurfaceId: string | null
): { from: number; to: number } {
	const pb = pbTagAt(xml, surfaceId);
	if (!pb) throw new Error(`No page break found for ${surfaceId}.`);
	const from = pb.index + pb[0].length;
	if (nextSurfaceId === null) return { from, to: closeOfEnclosure(xml, from) };
	const next = pbTagAt(xml, nextSurfaceId, from);
	if (!next) throw new Error(`No page break found for ${nextSurfaceId}.`);
	return { from, to: next.index };
}

// A span that runs to the end of the body must not swallow the enclosing
// section/score markup: it closes at the matching close of the element
// enclosing it. <section>/<mdiv> elements opened inside the span are tracked
// by depth, so a nested section's close does not end the span early.
function closeOfEnclosure(xml: string, from: number): number {
	const tags = /<(\/?)(section|mdiv)\b[^>]*?(\/?)>/g;
	tags.lastIndex = from;
	let depth = 0;
	for (let match = tags.exec(xml); match; match = tags.exec(xml)) {
		if (match[3]) continue; // self-closing: opens nothing
		if (!match[1]) depth++;
		else if (depth === 0) return match.index;
		else depth--;
	}
	return xml.length;
}

/** Every `<pb>` facs target ("surface-N") in `xml`, in document order. */
function pbSurfaces(xml: string): string[] {
	return [...xml.matchAll(/<pb\b[^>]*\bfacs="#([^"]*)"[^>]*>/g)].map((match) => match[1]);
}

/**
 * Assert the structural invariants a page splice must keep: the result carries
 * exactly the base's `<pb>` markers (one per surface, none smuggled in or
 * lost), and no measure xml:id appears twice document-wide. Throws a
 * descriptive Error on the first violation; the checks are what turn a fork
 * that would silently corrupt the score into a loud rejection.
 */
export function assertSpliceIntegrity(baseMei: string, splicedMei: string, locator: string): void {
	const baseSurfaces = new Set(pbSurfaces(baseMei));
	const counts = new Map<string, number>();
	for (const surface of pbSurfaces(splicedMei)) {
		counts.set(surface, (counts.get(surface) ?? 0) + 1);
	}
	for (const [surface, count] of counts) {
		if (!baseSurfaces.has(surface)) {
			throw new Error(
				`Splicing ${locator} introduced a page break for ${surface} the base score does not have.`
			);
		}
		if (count > 1) {
			throw new Error(`${count} page breaks for ${surface} after splicing ${locator}.`);
		}
	}
	for (const surface of baseSurfaces) {
		if (!counts.has(surface)) {
			throw new Error(`The page break for ${surface} is missing after splicing ${locator}.`);
		}
	}

	const measureIds = new Set<string>();
	for (const match of splicedMei.matchAll(/<measure\b[^>]*\bxml:id="([^"]*)"/g)) {
		if (measureIds.has(match[1])) {
			throw new Error(`Duplicate measure xml:id "${match[1]}" after splicing ${locator}.`);
		}
		measureIds.add(match[1]);
	}
}

/** Replace the base's page span with the fork's, both delimited by `locator`'s `<pb>`. */
function spliceSpan(baseMei: string, forkMei: string, locator: string): string {
	// Which surface follows the page is the base's to say.
	const surfaces = pbSurfaces(baseMei);
	const at = surfaces.indexOf(locator);
	const nextSurface = at === -1 ? null : (surfaces[at + 1] ?? null);
	const base = pageSpanAt(baseMei, locator, nextSurface);
	const fork = pageSpanAt(forkMei, locator, nextSurface);
	const spliced =
		baseMei.slice(0, base.from) + forkMei.slice(fork.from, fork.to) + baseMei.slice(base.to);
	assertSpliceIntegrity(baseMei, spliced, locator);
	return spliced;
}

/**
 * Splice the fork's encoding of one page into the base score. `locator` is the
 * page's `surface-N` id; the base's span for that page is replaced by the
 * fork's span content wholesale, and everything outside it is preserved from
 * the base. Throws if either side is missing the page break or the result
 * fails the integrity checks (assertSpliceIntegrity).
 */
export function splicePage(baseMei: string, forkMei: string, locator: string): string {
	return spliceSpan(baseMei, forkMei, locator);
}

/**
 * Splice the fork's encoding of one page into the base score by replacing the
 * page's whole `<pb>` span with the fork's. Used for physical pieces, whose
 * pages hold no fixed measure grid — the encoder transcribes from the source,
 * so measures are theirs to add and number and the page's content is taken
 * wholesale. Both files must carry the page's `<pb facs="#surface-N"/>`
 * marker; everything outside the span is kept from the base verbatim, so
 * per-page tasks still cannot touch each other's pages.
 */
export function splicePageSpan(baseMei: string, forkMei: string, locator: string): string {
	return spliceSpan(baseMei, forkMei, locator);
}
