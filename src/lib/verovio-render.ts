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
		pageWidth: 2100,
		pageHeight: 2970,
		adjustPageHeight: true,
		scale: 40,
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
