// Browser-only pipeline behind the "page images / PDF" campaign source: turn
// uploaded files into the FacsimilePage[] that mei-facsimile.ts renders, plus
// the image blobs to commit alongside the score.
//
// A PDF is rasterised to one JPEG per page (pdf.js); image files are used as-is.
// Each page is POSTed to the edirom measure-detector's /measures endpoint, whose
// normalized (0..1) bounding boxes are scaled to the page's real pixel size and
// sorted into reading order. Everything runs client-side — no backend.

import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { measureDetectorUrl } from './forge/config.ts';
import { sortReadingOrder, type FacsimilePage, type MeasureBox } from './mei-facsimile.ts';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

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
async function detectMeasures(blob: Blob, filename: string): Promise<MeasureBox[] | null> {
	const form = new FormData();
	form.append('file', blob, filename);
	form.append('expand', 'false');
	form.append('trim', 'false');
	form.append('auto', 'false');
	form.append('debug', 'false');

	let res: Response;
	try {
		res = await fetch(`${measureDetectorUrl.replace(/\/$/, '')}/measures`, {
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
		throw new Error(`Could not reach the measure detector at ${measureDetectorUrl}.`);
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
	if (data.measures !== undefined && !Array.isArray(data.measures)) {
		throw new Error(`The measure detector returned an unexpected response shape for ${filename}.`);
	}
	const boxes = (data.measures ?? [])
		.map((m) => m?.bbox)
		.filter((b): b is NonNullable<typeof b> => Boolean(b))
		.map((b) => ({ ulx: b.x1, uly: b.y1, lrx: b.x2, lry: b.y2 }));
	const invalid = boxes.filter(
		(b) => ![b.ulx, b.uly, b.lrx, b.lry].every((v) => typeof v === 'number' && Number.isFinite(v))
	);
	if (invalid.length) {
		throw new Error(`The measure detector returned malformed coordinates for ${filename}.`);
	}
	return boxes;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Turn uploaded files into pages + image blobs. A single PDF expands to its
 * pages; otherwise each image file is a page, in the given order. Every page is
 * detected sequentially (gentle on the shared detector service), its normalized
 * boxes scaled to the page's real pixel size and sorted into reading order.
 */
export async function prepareFacsimile(files: File[], onProgress?: ProgressFn): Promise<PreparedFacsimile> {
	// Build the ordered list of (filename, blob) page images.
	const pageBlobs: Array<{ name: string; blob: Blob }> = [];
	if (files.length === 1 && isPdf(files[0])) {
		const rendered = await pdfToImages(files[0]);
		rendered.forEach((blob, i) => pageBlobs.push({ name: `${pad2(i + 1)}.jpg`, blob }));
	} else {
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			if (isPdf(f)) throw new Error('Upload a single PDF, or one or more image files — not a mix.');
			const ext = (/\.(jpe?g|png)$/i.exec(f.name)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
			pageBlobs.push({ name: `${pad2(i + 1)}.${ext}`, blob: f });
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
		const normalized = await detectMeasures(blob, name);
		if (normalized === null) {
			skipped.push(name);
			continue;
		}
		const { width, height } = await imageSize(blob);
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
