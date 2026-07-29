// The measure-detector transport: POST one page image to the edirom
// measure-detector's /measures endpoint and return the normalized (0..1)
// bounding boxes it found. Pacing, caching and downscaling of what is sent
// here live in measure-detection.ts.

import type { MeasureBox } from './mei-facsimile.ts';

/** The detector's response shape (only the fields we read). */
interface DetectorResponse {
	measures?: Array<{ bbox?: { x1: number; y1: number; x2: number; y2: number } }>;
}

// Per-page ceiling on a detector request, so a hung service fails the upload
// instead of leaving the progress overlay spinning indefinitely.
const DETECTOR_TIMEOUT_MS = 60_000;

/**
 * POST an image to the measure detector and return its measure boxes as
 * normalized (0..1) coordinates. `expand/trim/auto/debug` are all off — we want
 * the raw detected boxes, one per measure. Throws a descriptive Error on any
 * transport or response-shape failure so the caller never proceeds on missing
 * or malformed detection data. Returns null when the detector fails on this
 * specific page (HTTP 500), signalling the caller to skip just that page.
 */
export async function detectMeasures(blob: Blob, filename: string, detectorUrl: string): Promise<MeasureBox[] | null> {
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
