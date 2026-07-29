import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectMeasures } from '../facsimile-detect.ts';

const blob = new Blob(['jpeg'], { type: 'image/jpeg' });

test('posts the page with all extras off and returns the raw normalized boxes', async (t) => {
	let seen: { url: string; filename: string; flags: string[] } | undefined;
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const form = init?.body as FormData;
		seen = {
			url: String(input),
			filename: (form.get('file') as File).name,
			flags: ['expand', 'trim', 'auto', 'debug'].map((key) => `${key}=${form.get(key)}`)
		};
		return Response.json({
			measures: [
				{ bbox: { x1: 0.1, y1: 0.5, x2: 0.4, y2: 0.7 } },
				{ bbox: { x1: 0.2, y1: 0.1, x2: 0.5, y2: 0.3 } }
			]
		});
	});

	const boxes = await detectMeasures(blob, 'page.jpg', 'https://detector.example/');
	assert.deepEqual(seen, {
		url: 'https://detector.example/measures',
		filename: 'page.jpg',
		flags: ['expand=false', 'trim=false', 'auto=false', 'debug=false']
	});
	// In the detector's own order and scale — sorting and scaling are the caller's.
	assert.deepEqual(boxes, [
		{ ulx: 0.1, uly: 0.5, lrx: 0.4, lry: 0.7 },
		{ ulx: 0.2, uly: 0.1, lrx: 0.5, lry: 0.3 }
	]);
});

test('a response without measures is an empty page', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json({}));
	assert.deepEqual(await detectMeasures(blob, 'page.jpg', 'https://detector.example'), []);
});

test('an HTTP 500 returns null so the caller can skip just that page', async (t) => {
	t.mock.method(globalThis, 'fetch', async () =>
		Response.json({ message: 'detector failed' }, { status: 500 })
	);
	assert.equal(await detectMeasures(blob, 'page.jpg', 'https://detector.example'), null);
});

test('any other failing status is an error naming it', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response('busy', { status: 503 }));
	await assert.rejects(detectMeasures(blob, 'page.jpg', 'https://detector.example'), /returned 503/);
});

test('a non-JSON response is rejected', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => new Response('<html>oops</html>'));
	await assert.rejects(
		detectMeasures(blob, 'page.jpg', 'https://detector.example'),
		/invalid response/
	);
});

test('malformed or non-normalized detector boxes are rejected', async (t) => {
	const responses: unknown[] = [
		{ measures: 'nope' },
		{ measures: [{}] },
		{ measures: [{ bbox: { x1: -0.1, y1: 0, x2: 0.5, y2: 0.5 } }] },
		{ measures: [{ bbox: { x1: 0.8, y1: 0.1, x2: 0.2, y2: 0.5 } }] }
	];
	let call = 0;
	t.mock.method(globalThis, 'fetch', async () => Response.json(responses[call++]));

	await assert.rejects(
		detectMeasures(blob, 'page.jpg', 'https://detector.example'),
		/unexpected response shape/
	);
	await assert.rejects(
		detectMeasures(blob, 'page.jpg', 'https://detector.example'),
		/unexpected response shape/
	);
	await assert.rejects(
		detectMeasures(blob, 'page.jpg', 'https://detector.example'),
		/malformed coordinates/
	);
	await assert.rejects(
		detectMeasures(blob, 'page.jpg', 'https://detector.example'),
		/malformed coordinates/
	);
});

test('an unreachable detector is reported as such', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => {
		throw new TypeError('fetch failed');
	});
	await assert.rejects(
		detectMeasures(blob, 'page.jpg', 'https://detector.example'),
		/Could not reach the measure detector/
	);
});
