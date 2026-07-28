import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	classifyUpload,
	iiifImageUrl,
	iiifProxyUrl,
	parseIiifManifest,
	prepareImages,
	fetchIiifCanvasUrls,
	MAX_IMAGE_EDGE
} from '../prepare-images.ts';

/** A stand-in for an uploaded File: only name/type and the bytes are read. */
function fakeFile(name: string, type = '', text = ''): File {
	return { name, type, text: async () => text } as unknown as File;
}

const blob = (marker: string) => ({ marker }) as unknown as Blob;

// Injected browser steps: no canvas, pdf.js or verovio outside a browser.
const stubs = {
	renderPdf: async () => [blob('pdf-1'), blob('pdf-2')],
	downscale: async (b: Blob) => b,
	toMei: async (f: File) => `<mei><!-- ${f.name} --></mei>`
};

test('classifies uploads by MIME type, falling back to the extension', () => {
	assert.equal(classifyUpload({ name: 'a.pdf', type: 'application/pdf' }), 'pdf');
	assert.equal(classifyUpload({ name: 'scan.PDF' }), 'pdf');
	assert.equal(classifyUpload({ name: 'p1.jpg', type: 'image/jpeg' }), 'image');
	assert.equal(classifyUpload({ name: 'p1.PNG' }), 'image');
	assert.equal(classifyUpload({ name: 'score.mei' }), 'encoding');
	assert.equal(classifyUpload({ name: 'score.musicxml' }), 'encoding');
	assert.equal(classifyUpload({ name: 'score.mxl' }), 'encoding');
	assert.equal(classifyUpload({ name: 'notes.txt' }), null);
});

test('builds a capped IIIF Image API request', () => {
	assert.equal(
		iiifImageUrl('https://iiif.example/iiif/2/abc'),
		`https://iiif.example/iiif/2/abc/full/!${MAX_IMAGE_EDGE},${MAX_IMAGE_EDGE}/0/default.jpg`
	);
	// A trailing slash on the service id must not double up.
	assert.equal(
		iiifImageUrl('https://iiif.example/iiif/2/abc/', 800),
		'https://iiif.example/iiif/2/abc/full/!800,800/0/default.jpg'
	);
});

test('parses canvases from a Presentation API v2 manifest', () => {
	const manifest = {
		sequences: [
			{
				canvases: [
					{
						images: [
							{ resource: { service: { '@id': 'https://iiif.example/img/1' } } }
						]
					},
					{
						images: [
							{ resource: { service: { '@id': 'https://iiif.example/img/2' } } }
						]
					}
				]
			}
		]
	};
	assert.deepEqual(parseIiifManifest(manifest), [
		iiifImageUrl('https://iiif.example/img/1'),
		iiifImageUrl('https://iiif.example/img/2')
	]);
});

test('parses canvases from a Presentation API v3 manifest', () => {
	const manifest = {
		items: [
			{
				items: [
					{
						items: [{ body: { service: [{ id: 'https://iiif.example/img/1' }] } }]
					}
				]
			}
		]
	};
	assert.deepEqual(parseIiifManifest(manifest), [iiifImageUrl('https://iiif.example/img/1')]);
});

test('falls back to the resource URL when a canvas has no image service', () => {
	const manifest = {
		sequences: [{ canvases: [{ images: [{ resource: { '@id': 'https://ex/plain.jpg' } }] }] }]
	};
	assert.deepEqual(parseIiifManifest(manifest), ['https://ex/plain.jpg']);
});

test('returns no canvases for input that is not a manifest', () => {
	assert.deepEqual(parseIiifManifest(null), []);
	assert.deepEqual(parseIiifManifest('nope'), []);
	assert.deepEqual(parseIiifManifest({}), []);
});

test('numbers page images across PDFs and image files in upload order', async () => {
	const { images } = await prepareImages(
		[fakeFile('scan.pdf', 'application/pdf'), fakeFile('extra.png', 'image/png')],
		[],
		undefined,
		stubs
	);
	assert.deepEqual(
		images.map((i) => i.path),
		['sources/img/01.jpg', 'sources/img/02.jpg', 'sources/img/03.png']
	);
});

test('keeps images within the cap byte-for-byte and re-encodes downscaled ones as JPEG', async () => {
	const original = fakeFile('big.png', 'image/png');
	const { images } = await prepareImages([original], [], undefined, {
		...stubs,
		// Simulate a downscale: a different blob comes back.
		downscale: async () => blob('downscaled')
	});
	assert.equal(images[0].path, 'sources/img/01.jpg', 'a re-encoded image commits as .jpg');

	const untouched = await prepareImages([original], [], undefined, stubs);
	assert.equal(untouched.images[0].path, 'sources/img/01.png', 'an unchanged image keeps its type');
});

test('converts uploaded encodings to MEI and keeps them out of the images', async () => {
	const { images, encodings } = await prepareImages(
		[fakeFile('piece.musicxml'), fakeFile('page.jpg', 'image/jpeg')],
		[],
		undefined,
		stubs
	);
	assert.equal(images.length, 1);
	assert.deepEqual(encodings, [{ name: 'piece.musicxml', mei: '<mei><!-- piece.musicxml --></mei>' }]);
});

test('appends IIIF canvases after the uploaded pages', async () => {
	const fetchFn = async () => ({ ok: true, blob: async () => blob('iiif') }) as unknown as Response;
	const { images } = await prepareImages(
		[fakeFile('page.jpg', 'image/jpeg')],
		['https://iiif.example/img/1/full/!2000,2000/0/default.jpg'],
		undefined,
		{ ...stubs, fetchFn, brokerUrl: '/auth' }
	);
	assert.deepEqual(
		images.map((i) => i.path),
		['sources/img/01.jpg', 'sources/img/02.jpg']
	);
});

test('wraps a IIIF URL in the broker relay, escaping the target', () => {
	assert.equal(
		iiifProxyUrl('https://iiif.example/a?b=1&c=2', '/auth'),
		'/auth/iiif?url=https%3A%2F%2Fiiif.example%2Fa%3Fb%3D1%26c%3D2'
	);
});

test('fetches IIIF canvases through the relay, never the host directly', async () => {
	const requested: string[] = [];
	const fetchFn = async (input: RequestInfo | URL) => {
		requested.push(String(input));
		return { ok: true, blob: async () => blob('iiif') } as unknown as Response;
	};
	await prepareImages([], ['https://iiif.example/img/1'], undefined, {
		...stubs,
		fetchFn,
		brokerUrl: '/auth'
	});
	assert.equal(requested.length, 1);
	assert.ok(
		requested[0].includes('/iiif?url='),
		`expected the relay, got ${requested[0]}`
	);
	assert.ok(!requested[0].startsWith('https://iiif.example'));
});

test('refuses to fetch IIIF canvases without a broker to relay through', async () => {
	const fetchFn = async () => {
		throw new Error('must not reach the network');
	};
	await assert.rejects(
		() => prepareImages([], ['https://iiif.example/img/1'], undefined, { ...stubs, fetchFn }),
		/broker URL is required/
	);
});

test('rejects an unsupported upload by name', async () => {
	await assert.rejects(
		() => prepareImages([fakeFile('notes.txt', 'text/plain')], [], undefined, stubs),
		/Unsupported file: notes\.txt/
	);
});

test('rejects when there is nothing to prepare', async () => {
	await assert.rejects(() => prepareImages([], [], undefined, stubs), /No images or encodings/);
});

test('surfaces a failed IIIF canvas fetch', async () => {
	const fetchFn = async () => ({ ok: false, status: 404 }) as unknown as Response;
	await assert.rejects(
		() =>
			prepareImages([], ['https://iiif.example/missing'], undefined, {
				...stubs,
				fetchFn,
				brokerUrl: '/auth'
			}),
		/Could not fetch the IIIF image .* \(404\)/
	);
});

test('fetches a manifest and returns its capped canvas URLs', async () => {
	const manifest = {
		items: [{ items: [{ items: [{ body: { service: [{ id: 'https://iiif.example/img/9' }] } }] }] }]
	};
	const fetchFn = async () => ({ ok: true, json: async () => manifest }) as unknown as Response;
	assert.deepEqual(
		await fetchIiifCanvasUrls('https://iiif.example/manifest', '/auth', { fetchFn }),
		[iiifImageUrl('https://iiif.example/img/9')]
	);
});

test('reports a manifest with no canvases rather than committing nothing', async () => {
	const fetchFn = async () => ({ ok: true, json: async () => ({}) }) as unknown as Response;
	await assert.rejects(
		() => fetchIiifCanvasUrls('https://iiif.example/manifest', '/auth', { fetchFn }),
		/No canvas images were found/
	);
});
