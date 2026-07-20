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

/** The page's span in the base body: from its `<pb>` to the next `<pb>`/end. */
function pageSpan(base: string, surfaceId: string): string {
	const pb = new RegExp(`<pb\\b[^>]*\\bfacs="#${escapeRegex(surfaceId)}"[^>]*>`).exec(base);
	if (!pb) throw new Error(`No page break found for ${surfaceId}.`);
	const from = pb.index + pb[0].length;
	const next = base.indexOf('<pb', from);
	return base.slice(from, next === -1 ? base.length : next);
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
