// Browser-only pipeline behind the "page images / PDF" campaign source: turn
// uploaded files into the FacsimilePage[] that mei-facsimile.ts renders, plus
// the image blobs to commit alongside the score.
//
// A PDF is rasterised to one JPEG per page (pdf.js); image files are used as-is.
// Each page is POSTed to the edirom measure-detector's /measures endpoint, whose
// normalized (0..1) bounding boxes are scaled to the page's real pixel size and
// sorted into reading order. Everything runs client-side — no backend.

import { sortReadingOrder, type FacsimilePage, type MeasureBox } from './mei-facsimile.ts';

/** The detector's response shape (only the fields we read). */
interface DetectorResponse {
	measures?: Array<{ bbox?: { x1: number; y1: number; x2: number; y2: number } }>;
}

/** A page image ready to commit: repo-relative path and its bytes. */
export interface PageImage {
	path: string;
	blob: Blob;
}

export interface PreparedFacsimile {
	pages: FacsimilePage[];
	images: PageImage[];
	/** Filenames the detector failed on (HTTP 500) and were left out. */
	skipped: string[];
}

/** Progress callback: which page (1-based) of how many, and what's happening. */
export type ProgressFn = (done: number, total: number, note: string) => void;

// Render each PDF page to a JPEG at ~150dpi-equivalent (scale 2 of the 72dpi
// default page box). Higher scale = sharper facsimile but larger commits.
const PDF_RENDER_SCALE = 2;
const JPEG_QUALITY = 0.85;

// Per-page ceiling on a detector request, so a hung service fails the upload
// instead of leaving the progress overlay spinning indefinitely.
const DETECTOR_TIMEOUT_MS = 60_000;
const DEFAULT_DETECTOR_URL = 'https://measure-detector.edirom.de';

export interface PrepareFacsimileOptions {
	detectorUrl?: string;
	/** Browser image decoding; injectable for non-browser integration tests. */
	getImageSize?: (blob: Blob) => Promise<{ width: number; height: number }>;
	/** PDF rasterisation; injectable for non-browser integration tests. */
	renderPdf?: (file: File) => Promise<Blob[]>;
}

function isPdf(file: File): boolean {
	return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
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

/** A raster blob's pixel dimensions. */
async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
	const bitmap = await createImageBitmap(blob);
	const size = { width: bitmap.width, height: bitmap.height };
	bitmap.close();
	return size;
}

/**
 * POST an image to the measure detector and return its measure boxes as
 * normalized (0..1) coordinates. `expand/trim/auto/debug` are all off — we want
 * the raw detected boxes, one per measure. Throws a descriptive Error on any
 * transport or response-shape failure so the caller never proceeds on missing
 * or malformed detection data. Returns null when the detector fails on this
 * specific page (HTTP 500), signalling the caller to skip just that page.
 */
async function detectMeasures(blob: Blob, filename: string, detectorUrl: string): Promise<MeasureBox[] | null> {
	const form = new FormData();
	form.append('file', blob, filename);
	form.append('expand', 'false');
	form.append('trim', 'false');
	form.append('auto', 'false');
	form.append('debug', 'false');

	let res: Response;
	try {
		res = await fetch(`${detectorUrl.replace(/\/$/, '')}/measures`, {
			method: 'POST',
			headers: { accept: 'application/json' },
			body: form,
			signal: AbortSignal.timeout(DETECTOR_TIMEOUT_MS)
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === 'TimeoutError') {
			throw new Error(`The measure detector did not respond within ${DETECTOR_TIMEOUT_MS / 1000}s for ${filename}.`);
		}
		// fetch() rejects with an opaque TypeError on network and CORS failures.
		throw new Error(`Could not reach the measure detector at ${detectorUrl}.`);
	}
	if (res.status === 500) {
		return null; // detector broke on this page; caller skips it
	}
	if (!res.ok) {
		throw new Error(`Measure detector returned ${res.status} for ${filename}.`);
	}
	let data: DetectorResponse;
	try {
		data = await res.json();
	} catch {
		throw new Error(`The measure detector returned an invalid response for ${filename}.`);
	}
	if (!data || typeof data !== 'object' || (data.measures !== undefined && !Array.isArray(data.measures))) {
		throw new Error(`The measure detector returned an unexpected response shape for ${filename}.`);
	}
	if ((data.measures ?? []).some((measure) => !measure?.bbox || typeof measure.bbox !== 'object')) {
		throw new Error(`The measure detector returned an unexpected response shape for ${filename}.`);
	}
	const boxes = (data.measures ?? []).map(({ bbox }) => ({
		ulx: bbox!.x1,
		uly: bbox!.y1,
		lrx: bbox!.x2,
		lry: bbox!.y2
	}));
	const invalid = boxes.filter(
		(b) =>
			![b.ulx, b.uly, b.lrx, b.lry].every(
				(value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
			) ||
			b.ulx >= b.lrx ||
			b.uly >= b.lry
	);
	if (invalid.length) {
		throw new Error(`The measure detector returned malformed coordinates for ${filename}.`);
	}
	return boxes;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Turn uploaded files into pages + image blobs. Each PDF expands to one page
 * per document page; each image file is a page. Pages from all files are
 * concatenated in the given file order into one compound sequence. Every page
 * is detected sequentially (gentle on the shared detector service), its
 * normalized boxes scaled to the page's real pixel size and sorted into
 * reading order.
 */
export async function prepareFacsimile(
	files: File[],
	onProgress?: ProgressFn,
	options: PrepareFacsimileOptions = {}
): Promise<PreparedFacsimile> {
	const detectorUrl = options.detectorUrl ?? DEFAULT_DETECTOR_URL;
	const getImageSize = options.getImageSize ?? imageSize;
	const renderPdf = options.renderPdf ?? pdfToImages;
	// Build the ordered list of (filename, blob) page images.
	const pageBlobs: Array<{ name: string; blob: Blob }> = [];
	for (const f of files) {
		if (isPdf(f)) {
			onProgress?.(0, files.length, `Rendering ${f.name}…`);
			for (const blob of await renderPdf(f)) {
				pageBlobs.push({ name: `${pad2(pageBlobs.length + 1)}.jpg`, blob });
			}
		} else {
			const mimeExt = f.type === 'image/jpeg' ? 'jpg' : f.type === 'image/png' ? 'png' : null;
			const nameExt = /\.(jpe?g|png)$/i.exec(f.name)?.[1]?.toLowerCase().replace('jpeg', 'jpg') ?? null;
			const ext = mimeExt ?? (!f.type ? nameExt : null);
			if (!ext) throw new Error(`Unsupported page image: ${f.name}. Upload JPG or PNG files.`);
			pageBlobs.push({ name: `${pad2(pageBlobs.length + 1)}.${ext}`, blob: f });
		}
	}
	if (!pageBlobs.length) throw new Error('No pages to process.');

	const total = pageBlobs.length;
	const pages: FacsimilePage[] = [];
	const images: PageImage[] = [];
	const skipped: string[] = [];

	for (let i = 0; i < pageBlobs.length; i++) {
		const { name, blob } = pageBlobs[i];
		onProgress?.(i, total, `Detecting measures on page ${i + 1} of ${total}…`);
		const normalized = await detectMeasures(blob, name, detectorUrl);
		if (normalized === null) {
			skipped.push(name);
			continue;
		}
		const { width, height } = await getImageSize(blob);
		const measures = sortReadingOrder(normalized).map((b) => ({
			ulx: b.ulx * width,
			uly: b.uly * height,
			lrx: b.lrx * width,
			lry: b.lry * height
		}));
		// graphic @target is resolved relative to the score file (sources/score.mei),
		// per the MEI spec, so it carries only the img/ subpath; the same image is
		// committed at its full repo path.
		pages.push({ image: `img/${name}`, width, height, measures });
		images.push({ path: `sources/img/${name}`, blob });
	}
	if (!pages.length) {
		throw new Error('The measure detector could not process any of the uploaded pages.');
	}
	onProgress?.(total, total, 'Building the score…');
	return { pages, images, skipped };
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
