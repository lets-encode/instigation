import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startDetection } from '../measure-detection.ts';
import type { PageImage } from '../prepare-images.ts';

const options = {
	getImageSize: async () => ({ width: 1000, height: 2000 }),
	downscale: async (blob: Blob) => blob
};

const page = (path: string, content: string): PageImage => ({
	path,
	blob: new Blob([content], { type: 'image/jpeg' })
});

/** Run macrotask turns until `done` holds or the turns run out. */
async function settleUntil(done: () => boolean): Promise<void> {
	for (let i = 0; i < 50 && !done(); i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

test('the detector copy is downscaled and results are scaled to the full page', async (t) => {
	const uploads: string[] = [];
	t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
		uploads.push(await ((init?.body as FormData).get('file') as File).text());
		return Response.json({
			measures: [
				{ bbox: { x1: 0.1, y1: 0.5, x2: 0.4, y2: 0.7 } },
				{ bbox: { x1: 0.2, y1: 0.1, x2: 0.5, y2: 0.3 } }
			]
		});
	});
	const downscaled: number[] = [];
	const session = startDetection([page('sources/img/01.jpg', 'full-size-bytes')], 'https://d.example', {
		...options,
		downscale: async (_blob: Blob, maxEdge: number) => {
			downscaled.push(maxEdge);
			return new Blob(['small-copy'], { type: 'image/jpeg' });
		}
	});

	const result = await session.page(0);
	assert.deepEqual(downscaled, [1200]);
	assert.deepEqual(uploads, ['small-copy']);
	assert.equal(result.width, 1000);
	assert.equal(result.height, 2000);
	// Pixel coordinates of the ORIGINAL size, sorted into reading order.
	assert.deepEqual(result.boxes, [
		{ ulx: 200, uly: 200, lrx: 500, lry: 600 },
		{ ulx: 100, uly: 1000, lrx: 400, lry: 1400 }
	]);
	session.cancel();
});

test('identical page content is sent to the detector once', async (t) => {
	const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ measures: [] }));
	const session = startDetection(
		[page('sources/img/01.jpg', 'twin-bytes'), page('sources/img/02.jpg', 'twin-bytes')],
		'https://d.example',
		options
	);

	const [first, second] = await Promise.all([session.page(0), session.page(1)]);
	assert.equal(fetchMock.mock.callCount(), 1);
	assert.deepEqual(first, second);
	session.cancel();
});

test('at most two requests are in flight at once', async (t) => {
	const gates: Array<() => void> = [];
	let launched = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		launched++;
		await new Promise<void>((resolve) => gates.push(resolve));
		return Response.json({ measures: [] });
	});
	const images = ['a', 'b', 'c', 'd'].map((content, i) => page(`sources/img/0${i + 1}.jpg`, `flight-${content}`));
	const session = startDetection(images, 'https://d.example', options);

	await settleUntil(() => launched >= 2);
	assert.equal(launched, 2);
	gates.shift()!();
	await settleUntil(() => launched >= 3);
	assert.equal(launched, 3);
	// Drain: release gates as they appear until every page has settled.
	let done = false;
	const all = Promise.all(images.map((_, i) => session.page(i))).then(() => (done = true));
	for (let i = 0; i < 200 && !done; i++) {
		gates.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	await all;
	assert.equal(launched, 4);
	session.cancel();
});

test('cancel stops pages that have not started; in-flight ones finish', async (t) => {
	const gates: Array<() => void> = [];
	const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
		await new Promise<void>((resolve) => gates.push(resolve));
		return Response.json({ measures: [] });
	});
	const images = ['a', 'b', 'c'].map((content, i) => page(`sources/img/0${i + 1}.jpg`, `cancel-${content}`));
	const session = startDetection(images, 'https://d.example', options);

	await settleUntil(() => gates.length >= 2);
	session.cancel();
	gates.shift()!();
	gates.shift()!();
	await Promise.all([session.page(0), session.page(1)]);
	await settleUntil(() => false);
	assert.equal(fetchMock.mock.callCount(), 2);
});

test('a failed page is retried when awaited again, a successful one is not', async (t) => {
	let call = 0;
	const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
		if (call++ === 0) throw new TypeError('network down');
		return Response.json({ measures: [] });
	});
	const images = [page('sources/img/01.jpg', 'flaky-bytes')];
	const session = startDetection(images, 'https://d.example', options);

	await assert.rejects(session.page(0), /Could not reach the measure detector/);
	const result = await session.page(0);
	assert.deepEqual(result.boxes, []);
	assert.equal(fetchMock.mock.callCount(), 2);

	// A new session over the same content — as after going back and returning —
	// serves the page from the cache without contacting the detector.
	const again = startDetection(images, 'https://d.example', options);
	assert.deepEqual(await again.page(0), result);
	assert.equal(fetchMock.mock.callCount(), 2);
	session.cancel();
	again.cancel();
});
