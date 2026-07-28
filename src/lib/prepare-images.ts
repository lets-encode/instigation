// Browser-only pipeline turning what the onboarding wizard's upload step
// collects — page images, PDFs, existing encodings, and IIIF manifests — into
// the blobs and MEI to commit into a new campaign repository.
//
// It runs in two passes, because a source is usually larger than the part of it
// a campaign encodes. `prepareCandidates` lists every page the upload offers and
// gives each a small preview to choose it by; `resolvePages` then renders or
// fetches only the chosen pages at committing size. So a 300-page PDF or a whole
// digitised source is read once, cheaply, and only the pages kept cost full
// rasterisation, a full-size download, and a place in the commit.
//
// A PDF is rasterised with pdf.js; raster images are used as-is unless they
// exceed the size cap, in which case they are downscaled and re-encoded; IIIF
// canvases are fetched already downscaled via the Image API; MusicXML/MXL is
// converted to MEI by verovio. Measure detection is not part of this path — it
// runs per piece once the pieces are known.
//
// The browser-only steps (canvas, pdf.js, verovio, fetch) are injectable so the
// pure logic can be tested outside a browser. The broker's base URL is passed in
// rather than read from config, keeping this module free of SvelteKit's env.

/** A page image ready to commit: repo-relative path and its bytes. */
export interface PageImage {
	path: string;
	blob: Blob;
}

/** An uploaded encoding, converted to MEI. */
export interface EncodingSource {
	/** The uploaded file's name, for labelling the piece it becomes. */
	name: string;
	mei: string;
}

/** Where a page's committing-size bytes come from, once it is chosen. */
export type PageSource =
	| { kind: 'file'; file: File }
	| { kind: 'pdf-page'; file: File; page: number }
	| { kind: 'iiif'; canvas: IiifCanvas };

/**
 * A page the upload offers, with a small raster to show it by. Nothing but the
 * preview has been rendered or downloaded yet: a candidate that is not chosen
 * costs no more than this.
 */
export interface PageCandidate {
	/** Identity within one prepared upload; keys the page in lists. */
	id: string;
	/** Where the page comes from, e.g. "scan.pdf — page 12". */
	label: string;
	/** Small raster of the page, for choosing between them. */
	preview: Blob;
	source: PageSource;
}

export interface PreparedUpload {
	candidates: PageCandidate[];
	encodings: EncodingSource[];
}

/**
 * Progress callback. `step` names a unit of work that is starting; `detail`
 * says which part of the step already running is being worked on, so a file
 * that expands into many pages reports its way through them.
 */
export type ProgressFn = (progress: { step?: string; detail?: string }) => void;

// One shared ceiling for uploads, PDF renders and IIIF fetches, so commits stay
// a reasonable size and later detector runs stay fast. Images already within
// the cap are committed untouched.
export const MAX_IMAGE_EDGE = 2000;
// A preview only has to be recognisable as a page among others, so it is a
// fraction of the size of the image that gets committed.
export const PREVIEW_IMAGE_EDGE = 400;
const JPEG_QUALITY = 0.85;
// Render PDF pages at scale 2 of the 72dpi default page box (~150dpi).
const PDF_RENDER_SCALE = 2;
// A preview render of the same page box, at roughly a quarter of that width.
const PDF_PREVIEW_SCALE = 0.5;

const IMAGE_EXTENSIONS = /\.(jpe?g|png)$/i;
const ENCODING_EXTENSIONS = /\.(mei|musicxml|xml|mxl)$/i;

export type UploadKind = 'image' | 'pdf' | 'encoding';

/**
 * What an uploaded file is, by MIME type where the browser supplies a useful
 * one and by extension otherwise. Returns null for anything unsupported.
 */
export function classifyUpload(file: { name: string; type?: string }): UploadKind | null {
	const type = file.type ?? '';
	if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf';
	if (type === 'image/jpeg' || type === 'image/png' || IMAGE_EXTENSIONS.test(file.name)) {
		return 'image';
	}
	if (ENCODING_EXTENSIONS.test(file.name)) return 'encoding';
	return null;
}

/** The committed file extension for a raster: everything but PNG becomes JPEG. */
function imageExtension(file: { name: string; type?: string }): 'jpg' | 'png' {
	if (file.type === 'image/png') return 'png';
	if (file.type === 'image/jpeg') return 'jpg';
	return /\.png$/i.test(file.name) ? 'png' : 'jpg';
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A IIIF Image API request for a canvas, capped to `maxEdge` on its long side.
 * `!w,h` asks the server to fit the image inside those bounds, preserving the
 * aspect ratio, so the downscale happens server-side.
 */
export function iiifImageUrl(serviceId: string, maxEdge = MAX_IMAGE_EDGE): string {
	return `${serviceId.replace(/\/$/, '')}/full/!${maxEdge},${maxEdge}/0/default.jpg`;
}

/**
 * A canvas's image source. An Image API service can serve the canvas at any
 * size, so a canvas that has one is requested small for a preview and large for
 * the commit; one without is only available whole.
 */
export interface IiifCanvas {
	/** Image API service endpoint, when the canvas has one. */
	service: string | null;
	/** The canvas image's own URL, used when there is no service. */
	url: string;
}

/** A canvas's image request at the wanted size, as far as the source allows. */
export function iiifCanvasUrl(canvas: IiifCanvas, maxEdge = MAX_IMAGE_EDGE): string {
	return canvas.service ? iiifImageUrl(canvas.service, maxEdge) : canvas.url;
}

/**
 * Route a IIIF URL through the session broker's relay.
 *
 * Sources come from arbitrary institutions, so the browser cannot fetch them
 * directly: the host is unknown ahead of time (no CSP entry can cover it) and
 * many IIIF servers send no CORS headers. The relay is same-origin, so neither
 * applies. It attaches no credentials.
 */
export function iiifProxyUrl(url: string, brokerUrl: string): string {
	return `${brokerUrl.replace(/\/$/, '')}/iiif?url=${encodeURIComponent(url)}`;
}

/**
 * Canvas image sources from a IIIF Presentation manifest, in sequence order.
 * Handles both Presentation API v2 (`sequences[].canvases[].images[]`) and v3
 * (`items[].items[].items[]`).
 */
export function parseIiifManifest(manifest: unknown): IiifCanvas[] {
	const doc = manifest as Record<string, unknown> | null;
	if (!doc || typeof doc !== 'object') return [];
	const canvases: IiifCanvas[] = [];

	// v3: Manifest → Canvas[] → AnnotationPage[] → Annotation[] → body
	for (const canvas of asArray(doc.items)) {
		for (const page of asArray(record(canvas)?.items)) {
			for (const annotation of asArray(record(page)?.items)) {
				const body = record(record(annotation)?.body);
				const source = canvasSource(body);
				if (source) canvases.push(source);
			}
		}
	}
	if (canvases.length) return canvases;

	// v2: Manifest → Sequence[] → Canvas[] → Image[] → resource
	for (const sequence of asArray(doc.sequences)) {
		for (const canvas of asArray(record(sequence)?.canvases)) {
			for (const image of asArray(record(canvas)?.images)) {
				const resource = record(record(image)?.resource);
				const source = canvasSource(resource);
				if (source) canvases.push(source);
			}
		}
	}
	return canvases;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * A resource's image source: its Image API service where it has one, and its own
 * URL otherwise.
 */
function canvasSource(resource: Record<string, unknown> | null): IiifCanvas | null {
	if (!resource) return null;
	const url = stringOf(resource['@id']) ?? stringOf(resource.id);
	// `service` is a single object in some manifests and an array in others.
	const services = Array.isArray(resource.service)
		? resource.service
		: resource.service
			? [resource.service]
			: [];
	for (const entry of services) {
		const service = record(entry);
		const id = stringOf(service?.['@id']) ?? stringOf(service?.id);
		if (id) return { service: id, url: url ?? '' };
	}
	return url ? { service: null, url } : null;
}

function stringOf(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

/** Called before each page of a PDF is rasterised, with its 1-based number. */
export type PdfPageFn = (page: number, pages: number) => void;

export interface PdfRenderOptions {
	/** Scale of the page's 72dpi default box. */
	scale: number;
	/** 1-based page numbers to render, in order; all pages when omitted. */
	pages?: number[];
	/** Reports the page being rendered, and how many this pass renders. */
	onPage?: PdfPageFn;
}

export interface PrepareImagesOptions {
	/** PDF rasterisation; injectable for non-browser tests. */
	renderPdf?: (file: File, options: PdfRenderOptions) => Promise<Blob[]>;
	/** Downscale a raster to fit the cap; injectable for non-browser tests. */
	downscale?: (blob: Blob, maxEdge: number) => Promise<Blob>;
	/** MusicXML/MEI → MEI conversion; injectable for non-browser tests. */
	toMei?: (file: File) => Promise<string>;
	/** Network access, for IIIF manifests and canvases. */
	fetchFn?: typeof fetch;
	maxEdge?: number;
	/** Long edge of the previews the first pass produces. */
	previewEdge?: number;
	/** The session broker's base URL; required to fetch IIIF canvases. */
	brokerUrl?: string;
}

/** A raster blob's pixel dimensions. */
export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
	const bitmap = await createImageBitmap(blob);
	const size = { width: bitmap.width, height: bitmap.height };
	bitmap.close();
	return size;
}

async function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('Could not encode page image.'))),
			'image/jpeg',
			JPEG_QUALITY
		);
	});
}

/** Rasterise a PDF's pages to one JPEG Blob each, in the order asked for. */
async function pdfToImages(file: File, options: PdfRenderOptions): Promise<Blob[]> {
	const [pdfjs, worker] = await Promise.all([
		import('pdfjs-dist'),
		import('pdfjs-dist/build/pdf.worker.min.mjs?url')
	]);
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
	const blobs: Blob[] = [];
	try {
		const wanted =
			options.pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
		for (const n of wanted) {
			options.onPage?.(n, wanted.length);
			const page = await doc.getPage(n);
			const viewport = page.getViewport({ scale: options.scale });
			const canvas = document.createElement('canvas');
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Canvas 2D context unavailable.');
			await page.render({ canvasContext: ctx, viewport }).promise;
			blobs.push(await canvasToJpeg(canvas));
			page.cleanup();
		}
	} finally {
		await doc.destroy();
	}
	return blobs;
}

/**
 * Re-encode a raster so its long edge fits `maxEdge`. Images already within the
 * cap are returned unchanged, so an untouched upload is committed byte-for-byte.
 */
async function downscaleImage(blob: Blob, maxEdge: number): Promise<Blob> {
	const bitmap = await createImageBitmap(blob);
	const longEdge = Math.max(bitmap.width, bitmap.height);
	if (longEdge <= maxEdge) {
		bitmap.close();
		return blob;
	}
	const scale = maxEdge / longEdge;
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		bitmap.close();
		throw new Error('Canvas 2D context unavailable.');
	}
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	return canvasToJpeg(canvas);
}

/**
 * Convert an uploaded encoding to MEI. MEI files pass through as text; MusicXML
 * is converted by verovio, which takes compressed .mxl as base64.
 */
async function encodingToMei(file: File): Promise<string> {
	if (/\.mei$/i.test(file.name)) return file.text();
	const [{ default: createVerovioModule }, { VerovioToolkit }] = await Promise.all([
		import('verovio/wasm'),
		import('verovio/esm')
	]);
	const toolkit = new VerovioToolkit(await createVerovioModule());
	const compressed = /\.mxl$/i.test(file.name);
	const data = compressed ? await blobToBase64(file) : await file.text();
	if (!toolkit.loadData(data)) {
		throw new Error(`Could not read ${file.name} as MusicXML.`);
	}
	return toolkit.getMEI();
}

/** Fetch a canvas's image at `maxEdge`, through the broker's relay. */
async function fetchIiifImage(
	canvas: IiifCanvas,
	maxEdge: number,
	brokerUrl: string,
	doFetch: typeof fetch
): Promise<Blob> {
	const url = iiifCanvasUrl(canvas, maxEdge);
	const res = await doFetch(iiifProxyUrl(url, brokerUrl));
	if (!res.ok) throw new Error(`Could not fetch the IIIF image at ${url} (${res.status}).`);
	return res.blob();
}

/**
 * List the pages the upload step's inputs offer, each with a preview. Every PDF
 * page and every canvas is a candidate, in the order the inputs were given —
 * uploaded files first, then the IIIF canvases. Encodings are not pages and are
 * returned converted, as they are.
 */
export async function prepareCandidates(
	files: File[],
	iiifCanvases: IiifCanvas[] = [],
	onProgress?: ProgressFn,
	options: PrepareImagesOptions = {}
): Promise<PreparedUpload> {
	const renderPdf = options.renderPdf ?? pdfToImages;
	const downscale = options.downscale ?? downscaleImage;
	const toMei = options.toMei ?? encodingToMei;
	const doFetch = options.fetchFn ?? fetch;
	const previewEdge = options.previewEdge ?? PREVIEW_IMAGE_EDGE;

	const candidates: PageCandidate[] = [];
	const encodings: EncodingSource[] = [];
	const total = files.length + iiifCanvases.length;
	let done = 0;

	const addCandidate = async (raster: Blob, label: string, source: PageSource) => {
		candidates.push({
			id: `page-${candidates.length + 1}`,
			label,
			preview: await downscale(raster, previewEdge),
			source
		});
	};

	for (const file of files) {
		const kind = classifyUpload(file);
		if (!kind) {
			throw new Error(`Unsupported file: ${file.name}. Upload JPG, PNG, PDF, MEI or MusicXML.`);
		}
		const nth = `(${++done} of ${total})`;
		if (kind === 'pdf') {
			onProgress?.({ step: `Reading ${file.name} ${nth}` });
			const rendered = await renderPdf(file, {
				scale: PDF_PREVIEW_SCALE,
				onPage: (page, pages) => onProgress?.({ detail: `page ${page} of ${pages}` })
			});
			for (const [i, blob] of rendered.entries()) {
				await addCandidate(blob, `${file.name} — page ${i + 1}`, {
					kind: 'pdf-page',
					file,
					page: i + 1
				});
			}
		} else if (kind === 'image') {
			onProgress?.({ step: `Reading ${file.name} ${nth}` });
			await addCandidate(file, file.name, { kind: 'file', file });
		} else {
			onProgress?.({ step: `Converting ${file.name} ${nth}` });
			encodings.push({ name: file.name, mei: await toMei(file) });
		}
	}

	if (iiifCanvases.length && !options.brokerUrl) {
		throw new Error('A broker URL is required to fetch IIIF images.');
	}
	for (const [i, canvas] of iiifCanvases.entries()) {
		onProgress?.({ step: `Fetching canvas ${++done} of ${total}` });
		const preview = await fetchIiifImage(canvas, previewEdge, options.brokerUrl!, doFetch);
		await addCandidate(preview, `Canvas ${i + 1}`, { kind: 'iiif', canvas });
	}

	if (!candidates.length && !encodings.length) {
		throw new Error('No images or encodings to process.');
	}
	return { candidates, encodings };
}

/**
 * The chosen pages as committable images, in the order given: each page's bytes
 * are rendered or fetched at committing size now, capped to `maxEdge`, and
 * numbered across the sequence. Every page wanted from one PDF is rendered in a
 * single pass over that document.
 */
export async function resolvePages(
	pages: PageCandidate[],
	onProgress?: ProgressFn,
	options: PrepareImagesOptions = {}
): Promise<PageImage[]> {
	const renderPdf = options.renderPdf ?? pdfToImages;
	const downscale = options.downscale ?? downscaleImage;
	const doFetch = options.fetchFn ?? fetch;
	const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE;

	// Opening a PDF is the expensive part of rendering one page of it, so the
	// pages wanted from each document are collected and rendered together.
	const wanted = new Map<File, number[]>();
	for (const page of pages) {
		if (page.source.kind !== 'pdf-page') continue;
		const numbers = wanted.get(page.source.file) ?? [];
		numbers.push(page.source.page);
		wanted.set(page.source.file, numbers);
	}
	const rendered = new Map<File, Map<number, Blob>>();
	for (const [file, numbers] of wanted) {
		const ordered = [...new Set(numbers)].sort((a, b) => a - b);
		onProgress?.({ step: `Rendering ${ordered.length} page(s) of ${file.name}` });
		const blobs = await renderPdf(file, {
			scale: PDF_RENDER_SCALE,
			pages: ordered,
			onPage: (page, count) => onProgress?.({ detail: `page ${page} of ${count}` })
		});
		rendered.set(file, new Map(ordered.map((page, i) => [page, blobs[i]])));
	}

	const images: PageImage[] = [];
	for (const page of pages) {
		const nth = `(${images.length + 1} of ${pages.length})`;
		let raster: Blob;
		// Everything but an untouched upload is committed as JPEG.
		let extension: 'jpg' | 'png' = 'jpg';
		if (page.source.kind === 'pdf-page') {
			const blob = rendered.get(page.source.file)?.get(page.source.page);
			if (!blob) throw new Error(`Could not render ${page.label}.`);
			raster = blob;
		} else if (page.source.kind === 'file') {
			onProgress?.({ step: `Preparing ${page.label} ${nth}` });
			raster = page.source.file;
			extension = imageExtension(page.source.file);
		} else {
			if (!options.brokerUrl) {
				throw new Error('A broker URL is required to fetch IIIF images.');
			}
			onProgress?.({ step: `Fetching ${page.label} ${nth}` });
			raster = await fetchIiifImage(page.source.canvas, maxEdge, options.brokerUrl, doFetch);
		}
		const scaled = await downscale(raster, maxEdge);
		// A downscale re-encodes to JPEG, so the committed extension follows the
		// bytes rather than the original file.
		const finalExtension = scaled === raster ? extension : 'jpg';
		images.push({
			path: `sources/img/${pad2(images.length + 1)}.${finalExtension}`,
			blob: scaled
		});
	}
	return images;
}

/**
 * The canvases of a IIIF manifest, from its URL: fetch the manifest and read
 * each canvas's image source out of it.
 */
export async function fetchIiifCanvases(
	manifestUrl: string,
	brokerUrl: string,
	options: { fetchFn?: typeof fetch } = {}
): Promise<IiifCanvas[]> {
	const doFetch = options.fetchFn ?? fetch;
	let res: Response;
	try {
		res = await doFetch(iiifProxyUrl(manifestUrl, brokerUrl), {
			headers: { accept: 'application/json' }
		});
	} catch {
		// fetch() rejects with an opaque TypeError on network and CORS failures.
		throw new Error(`Could not reach the IIIF manifest at ${manifestUrl}.`);
	}
	if (!res.ok) throw new Error(`The IIIF manifest returned ${res.status}.`);
	let manifest: unknown;
	try {
		manifest = await res.json();
	} catch {
		throw new Error('The IIIF manifest was not valid JSON.');
	}
	const canvases = parseIiifManifest(manifest);
	if (!canvases.length) throw new Error('No canvas images were found in that IIIF manifest.');
	return canvases;
}

/** Base64-encode a Blob's bytes (no data: prefix) for committing via the forge. */
export async function blobToBase64(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}
