// Browser-only pipeline turning what the onboarding wizard's upload step
// collects — page images, PDFs, existing encodings, and IIIF manifests — into
// the blobs and MEI to commit into a new campaign repository.
//
// A PDF is rasterised to one JPEG per page (pdf.js); raster images are used
// as-is unless they exceed the size cap, in which case they are downscaled and
// re-encoded; IIIF canvases are fetched already downscaled via the Image API;
// MusicXML/MXL is converted to MEI by verovio. Measure detection is not part of
// this path — it runs per piece once the pieces are known.
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

export interface PreparedUpload {
	images: PageImage[];
	encodings: EncodingSource[];
}

/** Progress callback: how many units are done of how many, and what's happening. */
export type ProgressFn = (done: number, total: number, note: string) => void;

// One shared ceiling for uploads, PDF renders and IIIF fetches, so commits stay
// a reasonable size and later detector runs stay fast. Images already within
// the cap are committed untouched.
export const MAX_IMAGE_EDGE = 2000;
const JPEG_QUALITY = 0.85;
// Render PDF pages at scale 2 of the 72dpi default page box (~150dpi).
const PDF_RENDER_SCALE = 2;

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
 * (`items[].items[].items[]`). Prefers a canvas's Image API service — which can
 * serve a downscaled derivative — and falls back to the plain image URL.
 */
export function parseIiifManifest(manifest: unknown): string[] {
	const doc = manifest as Record<string, unknown> | null;
	if (!doc || typeof doc !== 'object') return [];
	const urls: string[] = [];

	// v3: Manifest → Canvas[] → AnnotationPage[] → Annotation[] → body
	for (const canvas of asArray(doc.items)) {
		for (const page of asArray(record(canvas)?.items)) {
			for (const annotation of asArray(record(page)?.items)) {
				const body = record(record(annotation)?.body);
				const url = serviceOrId(body);
				if (url) urls.push(url);
			}
		}
	}
	if (urls.length) return urls;

	// v2: Manifest → Sequence[] → Canvas[] → Image[] → resource
	for (const sequence of asArray(doc.sequences)) {
		for (const canvas of asArray(record(sequence)?.canvases)) {
			for (const image of asArray(record(canvas)?.images)) {
				const resource = record(record(image)?.resource);
				const url = serviceOrId(resource);
				if (url) urls.push(url);
			}
		}
	}
	return urls;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/**
 * A resource's Image API request URL: its service endpoint turned into an Image
 * API request when it has one, otherwise the resource's own URL unchanged.
 */
function serviceOrId(resource: Record<string, unknown> | null): string | null {
	if (!resource) return null;
	// `service` is a single object in some manifests and an array in others.
	const services = Array.isArray(resource.service)
		? resource.service
		: resource.service
			? [resource.service]
			: [];
	for (const entry of services) {
		const service = record(entry);
		const id = stringOf(service?.['@id']) ?? stringOf(service?.id);
		if (id) return iiifImageUrl(id);
	}
	return stringOf(resource['@id']) ?? stringOf(resource.id);
}

function stringOf(value: unknown): string | null {
	return typeof value === 'string' && value ? value : null;
}

export interface PrepareImagesOptions {
	/** PDF rasterisation; injectable for non-browser tests. */
	renderPdf?: (file: File) => Promise<Blob[]>;
	/** Downscale a raster to fit the cap; injectable for non-browser tests. */
	downscale?: (blob: Blob, maxEdge: number) => Promise<Blob>;
	/** MusicXML/MEI → MEI conversion; injectable for non-browser tests. */
	toMei?: (file: File) => Promise<string>;
	/** Network access, for IIIF manifests and canvases. */
	fetchFn?: typeof fetch;
	maxEdge?: number;
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

/** Rasterise a PDF to one JPEG Blob per page, in page order. */
async function pdfToImages(file: File): Promise<Blob[]> {
	const [pdfjs, worker] = await Promise.all([
		import('pdfjs-dist'),
		import('pdfjs-dist/build/pdf.worker.min.mjs?url')
	]);
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
	const blobs: Blob[] = [];
	try {
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const viewport = page.getViewport({ scale: PDF_RENDER_SCALE });
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

/**
 * Turn the upload step's inputs into committable images and encodings. Each PDF
 * expands to one page per document page and each image file is a page; pages
 * from all files are concatenated in the given order, then the IIIF canvases
 * follow. Page images are numbered across the whole sequence.
 */
export async function prepareImages(
	files: File[],
	iiifCanvasUrls: string[] = [],
	onProgress?: ProgressFn,
	options: PrepareImagesOptions = {}
): Promise<PreparedUpload> {
	const renderPdf = options.renderPdf ?? pdfToImages;
	const downscale = options.downscale ?? downscaleImage;
	const toMei = options.toMei ?? encodingToMei;
	const doFetch = options.fetchFn ?? fetch;
	const maxEdge = options.maxEdge ?? MAX_IMAGE_EDGE;

	const images: PageImage[] = [];
	const encodings: EncodingSource[] = [];
	const total = files.length + iiifCanvasUrls.length;
	let done = 0;

	const addImage = async (blob: Blob, ext: 'jpg' | 'png') => {
		const scaled = await downscale(blob, maxEdge);
		// A downscale re-encodes to JPEG, so the committed extension follows the
		// bytes rather than the original file.
		const finalExt = scaled === blob ? ext : 'jpg';
		images.push({ path: `sources/img/${pad2(images.length + 1)}.${finalExt}`, blob: scaled });
	};

	for (const file of files) {
		const kind = classifyUpload(file);
		if (!kind) {
			throw new Error(`Unsupported file: ${file.name}. Upload JPG, PNG, PDF, MEI or MusicXML.`);
		}
		if (kind === 'pdf') {
			onProgress?.(done, total, `Rendering ${file.name}…`);
			for (const blob of await renderPdf(file)) await addImage(blob, 'jpg');
		} else if (kind === 'image') {
			onProgress?.(done, total, `Preparing ${file.name}…`);
			await addImage(file, imageExtension(file));
		} else {
			onProgress?.(done, total, `Converting ${file.name}…`);
			encodings.push({ name: file.name, mei: await toMei(file) });
		}
		onProgress?.(++done, total, '');
	}

	if (iiifCanvasUrls.length && !options.brokerUrl) {
		throw new Error('A broker URL is required to fetch IIIF images.');
	}
	for (const url of iiifCanvasUrls) {
		onProgress?.(done, total, `Fetching image ${done + 1} of ${total}…`);
		const res = await doFetch(iiifProxyUrl(url, options.brokerUrl!));
		if (!res.ok) throw new Error(`Could not fetch the IIIF image at ${url} (${res.status}).`);
		// The Image API already applied the cap, so this only re-encodes if the
		// server returned something larger than asked for.
		await addImage(await res.blob(), 'jpg');
		onProgress?.(++done, total, '');
	}

	if (!images.length && !encodings.length) {
		throw new Error('No images or encodings to process.');
	}
	return { images, encodings };
}

/**
 * Canvas image URLs from a IIIF manifest URL: fetch the manifest and turn each
 * canvas into a capped Image API request.
 */
export async function fetchIiifCanvasUrls(
	manifestUrl: string,
	brokerUrl: string,
	options: { fetchFn?: typeof fetch } = {}
): Promise<string[]> {
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
	const urls = parseIiifManifest(manifest);
	if (!urls.length) throw new Error('No canvas images were found in that IIIF manifest.');
	return urls;
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
