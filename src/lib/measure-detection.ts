// Measure detection for the campaign wizard, run in the background: detection
// starts as soon as the page images are final, so the results are usually
// ready by the time the pieces are described. Results are cached for the
// session by image content, so re-entering the step, restoring a draft or
// retrying a failed finish never re-detects an unchanged page — and at most
// DETECTOR_CONCURRENCY requests are in flight at once, however many callers
// are asking.

import { detectMeasures } from './facsimile-detect.ts';
import { sortReadingOrder, type MeasureBox } from './mei-facsimile.ts';
import { downscaleImage, imageSize, type PageImage } from './prepare-images.ts';

/** How many detector requests may be in flight at once — it is a shared service. */
const DETECTOR_CONCURRENCY = 2;
// The long edge of the copy sent to the detector. Its coordinates come back
// normalized (0..1) and are scaled to the committed image's real pixel size,
// so a smaller upload changes only the transfer, not the result's geometry.
const DETECTOR_IMAGE_EDGE = 1200;

/** One page's detected measures, in pixels at the committed image's size. */
export interface PageMeasures {
	width: number;
	height: number;
	boxes: MeasureBox[];
	/**
	 * How long detecting this page took, from when its request left the queue
	 * to its result. A cached result keeps the time its detection took.
	 */
	tookMs: number;
}

export interface DetectionOptions {
	/** Browser image decoding; injectable for non-browser tests. */
	getImageSize?: (blob: Blob) => Promise<{ width: number; height: number }>;
	/** Browser re-encoding of the detector copy; injectable for non-browser tests. */
	downscale?: (blob: Blob, maxEdge: number) => Promise<Blob>;
}

// ---------------------------------------------------------------------------
// The in-flight cap, shared by every caller in the page.

let inFlight = 0;
const turnstile: Array<() => void> = [];

async function acquire(): Promise<void> {
	while (inFlight >= DETECTOR_CONCURRENCY) {
		await new Promise<void>((resolve) => turnstile.push(resolve));
	}
	inFlight++;
}

function release(): void {
	inFlight--;
	turnstile.shift()?.();
}

// ---------------------------------------------------------------------------
// Per-page detection, cached by what the detector would see.

const cache = new Map<string, Promise<PageMeasures>>();

async function contentKey(blob: Blob, detectorUrl: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
	const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
	return `${detectorUrl}|${hex}`;
}

/**
 * Detect one page's measures and return them in pixels, sorted into reading
 * order. Successes — including pages the detector itself failed on, which come
 * back with no boxes — are cached by the image's content, so the same bytes
 * are never sent twice; a failed attempt is forgotten, so awaiting the page
 * again retries it.
 */
async function detectPageMeasures(
	blob: Blob,
	name: string,
	detectorUrl: string,
	options: DetectionOptions = {}
): Promise<PageMeasures> {
	const key = await contentKey(blob, detectorUrl);
	const cached = cache.get(key);
	if (cached) return cached;
	const job = (async (): Promise<PageMeasures> => {
		const getImageSize = options.getImageSize ?? imageSize;
		const downscale = options.downscale ?? downscaleImage;
		await acquire();
		try {
			const startedAt = performance.now();
			const [size, copy] = await Promise.all([
				getImageSize(blob),
				downscale(blob, DETECTOR_IMAGE_EDGE)
			]);
			const normalized = await detectMeasures(copy, name, detectorUrl);
			const boxes = sortReadingOrder(normalized ?? []).map((b) => ({
				ulx: b.ulx * size.width,
				uly: b.uly * size.height,
				lrx: b.lrx * size.width,
				lry: b.lry * size.height
			}));
			return {
				width: size.width,
				height: size.height,
				boxes,
				tookMs: performance.now() - startedAt
			};
		} finally {
			release();
		}
	})();
	cache.set(key, job);
	job.catch(() => cache.delete(key));
	return job;
}

// ---------------------------------------------------------------------------
// The background pass over a step's pages.

export interface DetectionSession {
	/** The page's measures; joins work already under way rather than restarting it. */
	page(index: number): Promise<PageMeasures>;
	/** Stop starting new pages. Requests already in flight complete into the cache. */
	cancel(): void;
}

/**
 * Start detecting every page in the background, DETECTOR_CONCURRENCY at a
 * time. A page that failed is retried only when it is next awaited, never by
 * the background pass itself, so an unreachable detector costs one attempt
 * per page rather than a retry loop.
 */
export function startDetection(
	images: PageImage[],
	detectorUrl: string,
	options: DetectionOptions = {}
): DetectionSession {
	let cancelled = false;
	const started: Array<Promise<PageMeasures> | undefined> = new Array(images.length);
	const ensure = (index: number): Promise<PageMeasures> => {
		const existing = started[index];
		if (existing) return existing;
		const image = images[index];
		const name = image.path.split('/').pop() ?? `${index + 1}.jpg`;
		const job = detectPageMeasures(image.blob, name, detectorUrl, options);
		started[index] = job;
		job.catch(() => (started[index] = undefined));
		return job;
	};
	let next = 0;
	const worker = async (): Promise<void> => {
		while (!cancelled && next < images.length) {
			// A background failure is only noted; it surfaces when the page is awaited.
			await ensure(next++).catch(() => {});
		}
	};
	for (let i = 0; i < DETECTOR_CONCURRENCY; i++) void worker();
	return {
		page: ensure,
		cancel: () => {
			cancelled = true;
		}
	};
}
