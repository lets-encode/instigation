import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blobToBase64, prepareFacsimile } from '../facsimile-detect.ts';

const imageSize = async () => ({ width: 1000, height: 2000 });

test('image uploads are detected sequentially, scaled, sorted and assigned stable paths', async (t) => {
	const requests: Array<{ url: string; filename: string }> = [];
	let call = 0;
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const form = init?.body as FormData;
		requests.push({ url: String(input), filename: (form.get('file') as File).name });
		call++;
		return Response.json({
			measures:
				call === 1
					? [
							{ bbox: { x1: 0.1, y1: 0.5, x2: 0.4, y2: 0.7 } },
							{ bbox: { x1: 0.2, y1: 0.1, x2: 0.5, y2: 0.3 } }
						]
					: []
		});
	});
	const progress: Array<[number, number, string]> = [];

	const result = await prepareFacsimile(
		[
			new File(['jpeg'], 'scan.jpeg', { type: 'image/jpeg' }),
			new File(['png'], 'page.png', { type: 'image/png' })
		],
		(done, total, note) => progress.push([done, total, note]),
		{ detectorUrl: 'https://detector.example/', getImageSize: imageSize }
	);

	assert.deepEqual(requests, [
		{ url: 'https://detector.example/measures', filename: '01.jpg' },
		{ url: 'https://detector.example/measures', filename: '02.png' }
	]);
	assert.deepEqual(result.pages.map((page) => page.image), ['img/01.jpg', 'img/02.png']);
	assert.deepEqual(result.images.map((image) => image.path), ['sources/img/01.jpg', 'sources/img/02.png']);
	assert.deepEqual(result.pages[0].measures, [
		{ ulx: 200, uly: 200, lrx: 500, lry: 600 },
		{ ulx: 100, uly: 1000, lrx: 400, lry: 1400 }
	]);
	assert.deepEqual(progress.map(([done, total]) => [done, total]), [[0, 2], [1, 2], [2, 2]]);
});

test('PDFs and images combine into one page sequence in file order', async (t) => {
	const detected: string[] = [];
	t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
		detected.push(((init?.body as FormData).get('file') as File).name);
		return Response.json({ measures: [] });
	});
	const renderPdf = async (file: File) =>
		file.name === 'violin1.pdf'
			? [new Blob(['v1p1']), new Blob(['v1p2'])]
			: [new Blob(['v2p1'])];

	const result = await prepareFacsimile(
		[
			new File(['pdf'], 'violin1.pdf', { type: 'application/pdf' }),
			new File(['png'], 'cover.png', { type: 'image/png' }),
			new File(['pdf'], 'violin2.pdf', { type: 'application/pdf' })
		],
		undefined,
		{ getImageSize: imageSize, renderPdf }
	);

	assert.deepEqual(detected, ['01.jpg', '02.jpg', '03.png', '04.jpg']);
	assert.deepEqual(
		result.pages.map((page) => page.image),
		['img/01.jpg', 'img/02.jpg', 'img/03.png', 'img/04.jpg']
	);
});

test('an HTTP 500 skips only that page and preserves the remaining source number', async (t) => {
	let call = 0;
	t.mock.method(globalThis, 'fetch', async () =>
		call++ === 0
			? Response.json({ message: 'detector failed' }, { status: 500 })
			: Response.json({ measures: [] })
	);

	const result = await prepareFacsimile(
		[
			new File(['one'], 'one.jpg', { type: 'image/jpeg' }),
			new File(['two'], 'two.jpg', { type: 'image/jpeg' })
		],
		undefined,
		{ getImageSize: imageSize }
	);

	assert.deepEqual(result.skipped, ['01.jpg']);
	assert.deepEqual(result.pages.map((page) => page.image), ['img/02.jpg']);
	assert.deepEqual(result.images.map((image) => image.path), ['sources/img/02.jpg']);
});

test('malformed or non-normalized detector boxes are rejected', async (t) => {
	const responses: unknown[] = [
		{ measures: [{}] },
		{ measures: [{ bbox: { x1: -0.1, y1: 0, x2: 0.5, y2: 0.5 } }] },
		{ measures: [{ bbox: { x1: 0.8, y1: 0.1, x2: 0.2, y2: 0.5 } }] }
	];
	let call = 0;
	t.mock.method(globalThis, 'fetch', async () => Response.json(responses[call++]));
	const file = new File(['page'], 'page.jpg', { type: 'image/jpeg' });

	await assert.rejects(
		prepareFacsimile([file], undefined, { getImageSize: imageSize }),
		/unexpected response shape/
	);
	await assert.rejects(
		prepareFacsimile([file], undefined, { getImageSize: imageSize }),
		/malformed coordinates/
	);
	await assert.rejects(
		prepareFacsimile([file], undefined, { getImageSize: imageSize }),
		/malformed coordinates/
	);
});

test('unsupported image types fail before contacting the detector', async (t) => {
	const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ measures: [] }));
	await assert.rejects(
		prepareFacsimile([new File(['text'], 'notes.txt', { type: 'text/plain' })], undefined, {
			getImageSize: imageSize
		}),
		/Unsupported page image/
	);
	assert.equal(fetch.mock.callCount(), 0);
});

test('blobToBase64 preserves arbitrary bytes', async () => {
	assert.equal(await blobToBase64(new Blob([new Uint8Array([0, 1, 254, 255])])), 'AAH+/w==');
});
