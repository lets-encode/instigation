// Small per-piece previews: the first facsimile page image (thumbnail) and a
// Verovio incipit — the opening system rendered as a narrow SVG strip.
//
// Browser-only — the incipit renders through a Verovio WASM toolkit. The
// incipit toolkit is separate from the score preview's shared toolkit
// (verovio-render.ts): a toolkit holds one loaded document, so sharing it with
// a mounted score preview would invalidate that preview's page indices.

import type { VerovioToolkit } from 'verovio/esm';
import type { ForgeClient } from './forge/types.ts';
import { parseFacsimileMei } from './mei-facsimile.ts';
import { resolveFacsimileImageUrls } from './facsimile-images.ts';
import { renderPage } from './verovio-render.ts';

export interface PiecePreview {
	/** Download URL of the first facsimile page image; '' = none reachable. */
	thumb: string;
	/** Sanitised SVG of the opening system; '' = nothing rendered. */
	incipit: string;
	/** True while the score has facsimile pages but no measures yet. */
	incipitPending: boolean;
}

const EMPTY: PiecePreview = { thumb: '', incipit: '', incipitPending: false };

// One load per piece per page load; a failed load is dropped so the next
// mount retries it.
const cache = new Map<string, Promise<PiecePreview>>();

/** The cached preview of one piece, loading it on first request. */
export function piecePreview(
	f: ForgeClient,
	owner: string,
	repo: string,
	path: string
): Promise<PiecePreview> {
	const key = `${owner}/${repo}/${path}`;
	let loading = cache.get(key);
	if (!loading) {
		loading = loadPreview(f, owner, repo, path).catch(() => {
			cache.delete(key);
			return EMPTY;
		});
		cache.set(key, loading);
	}
	return loading;
}

async function loadPreview(
	f: ForgeClient,
	owner: string,
	repo: string,
	path: string
): Promise<PiecePreview> {
	const mei = await f.getRepoFile(owner, repo, path);
	if (mei == null) return EMPTY;
	const parsed = parseFacsimileMei(mei);

	let thumb = '';
	const pageIndex = parsed.pages.findIndex((page) => page.image);
	if (pageIndex >= 0) {
		const urls = await resolveFacsimileImageUrls(f, owner, repo, path, [
			parsed.pages[pageIndex].image
		]);
		thumb = urls[0] ?? '';
	}

	// A facsimile score renders only once its measures exist; a score without
	// facsimile pages renders as-is.
	if (parsed.pages.length && !parsed.hasMeasures) {
		return { thumb, incipit: '', incipitPending: true };
	}
	return { thumb, incipit: await renderIncipit(mei), incipitPending: false };
}

// ---------------------------------------------------------------------------
// Incipit rendering

// The tiny pageHeight makes Verovio put exactly one system on each page;
// adjustPageHeight then grows the SVG viewBox to that system's real extent.
const INCIPIT_OPTIONS = {
	pageWidth: 2400,
	pageHeight: 100,
	adjustPageHeight: true,
	scale: 40,
	header: 'none',
	footer: 'none',
	svgViewBox: true,
	breaks: 'auto'
};

let toolkitLoading: Promise<VerovioToolkit> | null = null;

function getIncipitToolkit(): Promise<VerovioToolkit> {
	toolkitLoading ??= loadToolkit().catch((err) => {
		toolkitLoading = null;
		throw err;
	});
	return toolkitLoading;
}

async function loadToolkit(): Promise<VerovioToolkit> {
	const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
		import('verovio/wasm'),
		import('verovio/esm')
	]);
	const tk = new VerovioToolkit(await createVerovioModule());
	tk.setOptions(INCIPIT_OPTIONS);
	return tk;
}

// The toolkit holds one document at a time, so concurrent piece loads render
// one after another.
let queue: Promise<unknown> = Promise.resolve();

function renderIncipit(mei: string): Promise<string> {
	const job = async () => {
		const tk = await getIncipitToolkit();
		if (!tk.loadData(mei) || tk.getPageCount() < 1) return '';
		return renderPage(tk, 1);
	};
	const run = queue.then(job, job);
	queue = run.catch(() => {});
	return run;
}
