// Score rendering for the previews: one Verovio toolkit per page load, and the
// sanitising every rendered page passes through before it reaches the DOM.
//
// Browser-only — Verovio is a WASM module and DOMPurify needs a document.

import DOMPurify from 'dompurify';
import type { VerovioToolkit } from 'verovio/esm';

// Verovio references every SMuFL glyph (noteheads, clefs, rests, meter
// signatures) as <use> pointing into the SVG's own <defs>. DOMPurify's svg
// profile drops <use>, which strips those glyphs while leaving the staff
// lines, stems and barlines, so the tag has to be allowed back.
const SANITIZE_SVG = {
	USE_PROFILES: { svg: true, svgFilters: true },
	ADD_TAGS: ['use']
};
// <use> is off the profile because it can reference other documents; keep it
// to same-document fragments.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	if (node.nodeName.toLowerCase() !== 'use') return;
	const href = node.getAttribute('xlink:href') ?? node.getAttribute('href');
	if (!href?.startsWith('#')) node.remove();
});

// Verovio is a ~2 MB WASM module — loaded on first preview, then reused. The
// promise is what is cached, so concurrent first calls share one load; a
// failed load is forgotten, so the next call retries it.
let toolkit: VerovioToolkit | null = null;
let loading: Promise<VerovioToolkit> | null = null;

export function getVerovio(): Promise<VerovioToolkit> {
	loading ??= loadVerovio().catch((err) => {
		loading = null;
		throw err;
	});
	return loading;
}

async function loadVerovio(): Promise<VerovioToolkit> {
	const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
		import('verovio/wasm'),
		import('verovio/esm')
	]);
	const tk = new VerovioToolkit(await createVerovioModule());
	tk.setOptions({
		footer: 'none',
		svgViewBox: true,
		// Render every movement — without this only the first <mdiv> paginates.
		mdivAll: true,
		// Write each measure's number as data-n, so a fail's measure range can
		// be highlighted in the rendered encoding.
		svgAdditionalAttribute: ['measure@n']
	});
	toolkit = tk;
	return tk;
}

// Page geometry in Verovio's units, where the notation has a fixed size: A4
// at 2100 wide. Page options are set per load — the toolkit is shared, so a
// load leaves the options of the previous one behind.
const PAGE_WIDTH = 2100;
export const A4_ASPECT = 2970 / 2100;
// Output scale in percent; it zooms the drawing, the page included, and has no
// bearing on how much fits on a page.
const SCALE = 40;

/**
 * Load a score for page-by-page rendering. Pages have the given proportions
 * (height over width; A4 by default) at a fixed height, so a rendered page
 * has the shape of the facsimile page it stands next to; with encoded breaks
 * the systems are spread over the page. One page size serves the whole score:
 * A4-sized, or grown (in Verovio's units, so the notation gets smaller on the
 * page) until the densest page's content fits, so no page runs over.
 * Returns false when Verovio cannot parse the MEI.
 */
export function loadScore(
	tk: VerovioToolkit,
	mei: string,
	{ aspect = A4_ASPECT, encodedBreaks }: { aspect?: number; encodedBreaks: boolean }
): boolean {
	let pageWidth = PAGE_WIDTH;
	let pageHeight = Math.round(PAGE_WIDTH * aspect);
	const breaks = encodedBreaks ? 'encoded' : 'auto';
	if (encodedBreaks) {
		// Only encoded breaks can overflow a page — automatic ones paginate to
		// fit. Trimmed pages first, to measure the height each one's content
		// needs; the trimmed page's viewBox is that height at the output scale.
		tk.setOptions({
			pageWidth,
			pageHeight,
			adjustPageHeight: true,
			justifyVertically: false,
			scale: SCALE,
			breaks
		});
		if (!tk.loadData(mei)) return false;
		let need = 0;
		for (let p = 1; p <= tk.getPageCount(); p++) {
			need = Math.max(need, (viewBoxHeight(tk.renderToSVG(p)) * 100) / SCALE);
		}
		if (need > pageHeight) {
			pageHeight = Math.ceil(need);
			pageWidth = Math.round(pageHeight / aspect);
		}
	}
	tk.setOptions({
		pageWidth,
		pageHeight,
		adjustPageHeight: false,
		justifyVertically: encodedBreaks,
		scale: SCALE,
		breaks
	});
	return tk.loadData(mei);
}

/**
 * Load a snippet for a single trimmed render, such as a score setup's blank
 * first system: the page is cut to the content's height.
 */
export function loadSnippet(tk: VerovioToolkit, mei: string): boolean {
	tk.setOptions({
		pageWidth: PAGE_WIDTH,
		pageHeight: Math.round(PAGE_WIDTH * A4_ASPECT),
		adjustPageHeight: true,
		justifyVertically: false,
		scale: SCALE,
		breaks: 'auto'
	});
	return tk.loadData(mei);
}

function viewBoxHeight(svg: string): number {
	const box = /viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg);
	return box ? Number(box[1]) : 0;
}

/** The loaded toolkit, or null before the first `getVerovio()` has resolved. */
export function loadedVerovio(): VerovioToolkit | null {
	return toolkit;
}

/**
 * One page as sanitised SVG. The MEI behind a render is volunteer-supplied, so
 * this is what makes the markup safe to inject.
 */
export function renderPage(tk: VerovioToolkit, page: number): string {
	// DOMPurify serialises through HTML, which writes U+00A0 as &nbsp; — an
	// entity XML does not define. Rewritten numeric so the SVG also parses as
	// XML (multimeasure-rest markers carry it).
	return DOMPurify.sanitize(tk.renderToSVG(page), SANITIZE_SVG).replaceAll('&nbsp;', '&#160;');
}
