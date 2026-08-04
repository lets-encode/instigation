// Joining per-page encoding into the shared score. A facsimile campaign splits
// encoding into one task per page (locator `surface-N`); every volunteer edits
// a copy of the whole `sources/score.mei`, but a page task's accepted PR must
// contribute only that page's notation, leaving the other pages as they stand
// in the base file. Pure functions: MEI text in, MEI text out. No DOM,
// filesystem or network access.
//
// A page's extent is delimited by the `<pb/>` markers written at stage C
// (mei-facsimile.ts): the page's `<pb facs="#surface-N"/>` opens it and the
// next `<pb/>` (or the end of the body) closes it. Every `<measure>` in that
// span belongs to the page. The join keeps the base file verbatim except for
// those measures, each replaced by the same-xml:id measure from the fork.
//
// A physical piece (blank score, no facsimile) has no fixed measure grid to
// match by id, so its pages are joined by replacing the whole span instead
// (splicePageSpan).

// A measure element with its xml:id captured. Measures do not nest, so a
// non-greedy match to the first </measure> is exact.
const MEASURE_RE = /<measure\b[^>]*\bxml:id="([^"]*)"[^>]*>[\s\S]*?<\/measure>/g;

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Map every `<measure>` element by its xml:id to its full element text. */
function measuresById(xml: string): Map<string, string> {
	const byId = new Map<string, string>();
	for (const match of xml.matchAll(MEASURE_RE)) byId.set(match[1], match[0]);
	return byId;
}

/** The page's span: from its `<pb>` to the next `<pb>`/end, with its offsets. */
function pageSpanAt(xml: string, surfaceId: string): { from: number; to: number } {
	const pb = new RegExp(`<pb\\b[^>]*\\bfacs="#${escapeRegex(surfaceId)}"[^>]*>`).exec(xml);
	if (!pb) throw new Error(`No page break found for ${surfaceId}.`);
	const from = pb.index + pb[0].length;
	const next = xml.indexOf('<pb', from);
	return { from, to: next === -1 ? closeOfEnclosure(xml, from) : next };
}

// A span that runs to the end of the body must not swallow the enclosing
// section/score markup: it closes at the first closing tag after the last
// measure of the page.
function closeOfEnclosure(xml: string, from: number): number {
	const close = xml.indexOf('</section>', from);
	return close === -1 ? xml.length : close;
}

/** The page's span in the base body: from its `<pb>` to the next `<pb>`/end. */
function pageSpan(base: string, surfaceId: string): string {
	const { from, to } = pageSpanAt(base, surfaceId);
	return base.slice(from, to);
}

/**
 * Splice the fork's encoding of one page into the base score. `locator` is the
 * page's `surface-N` id; only the measures inside that page's `<pb>` span are
 * taken from `forkMei`, matched by xml:id, and everything else in `baseMei` is
 * preserved. Throws if the page break is missing, the page has no measures, or
 * the fork is missing a measure the base places on the page.
 */
export function splicePage(baseMei: string, forkMei: string, locator: string): string {
	const pageIds = [...measuresById(pageSpan(baseMei, locator)).keys()];
	if (pageIds.length === 0) throw new Error(`No measures found for ${locator}.`);

	const forkMeasures = measuresById(forkMei);
	let result = baseMei;
	for (const id of pageIds) {
		const replacement = forkMeasures.get(id);
		if (replacement === undefined) throw new Error(`Fork is missing measure ${id} for ${locator}.`);
		const re = new RegExp(`<measure\\b[^>]*\\bxml:id="${escapeRegex(id)}"[^>]*>[\\s\\S]*?<\\/measure>`);
		result = result.replace(re, () => replacement);
	}
	return result;
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
	const base = pageSpanAt(baseMei, locator);
	const fork = pageSpanAt(forkMei, locator);
	return baseMei.slice(0, base.from) + forkMei.slice(fork.from, fork.to) + baseMei.slice(base.to);
}
