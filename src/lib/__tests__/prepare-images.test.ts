import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	classifyUpload,
	iiifCanvasUrl,
	iiifImageUrl,
	iiifProxyUrl,
	parseIiifManifest,
	prepareCandidates,
	resolvePages,
	fetchIiifCanvases,
	MAX_IMAGE_EDGE,
	PREVIEW_IMAGE_EDGE,
	type IiifCanvas,
	type PageCandidate,
	type PdfRenderOptions
} from '../prepare-images.ts';

/** A stand-in for an uploaded File: only name/type and the bytes are read. */
function fakeFile(name: string, type = '', text = ''): File {
	return { name, type, text: async () => text } as unknown as File;
}

const blob = (marker: string) => ({ marker }) as unknown as Blob;

const service = (id: string): IiifCanvas => ({ service: id, url: `${id}/canvas.jpg` });

// Injected browser steps: no canvas, pdf.js or verovio outside a browser.
const stubs = {
	renderPdf: async (file: File, options: PdfRenderOptions) =>
		(options.pages ?? [1, 2]).map((page) => blob(`${file.name}-p${page}@${options.scale}`)),
	downscale: async (b: Blob) => b,
	toMei: async (f: File) => `<mei><!-- ${f.name} --></mei>`
};

const okFetch = (marker = 'iiif') => {
	const requested: string[] = [];
	const fetchFn = async (input: RequestInfo | URL) => {
		requested.push(String(input));
		return { ok: true, blob: async () => blob(marker) } as unknown as Response;
	};
	return { requested, fetchFn };
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

test('asks a canvas for the wanted size, or takes it whole without a service', () => {
	assert.equal(
		iiifCanvasUrl(service('https://iiif.example/img/1'), 400),
		'https://iiif.example/img/1/full/!400,400/0/default.jpg'
	);
	assert.equal(
		iiifCanvasUrl({ service: null, url: 'https://ex/plain.jpg' }, 400),
		'https://ex/plain.jpg'
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
	assert.deepEqual(
		parseIiifManifest(manifest).map((c) => c.service),
		['https://iiif.example/img/1', 'https://iiif.example/img/2']
	);
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
	assert.deepEqual(parseIiifManifest(manifest), [
		{ service: 'https://iiif.example/img/1', url: '' }
	]);
});

test('falls back to the resource URL when a canvas has no image service', () => {
	const manifest = {
		sequences: [{ canvases: [{ images: [{ resource: { '@id': 'https://ex/plain.jpg' } }] }] }]
	};
	assert.deepEqual(parseIiifManifest(manifest), [{ service: null, url: 'https://ex/plain.jpg' }]);
});

test('returns no canvases for input that is not a manifest', () => {
	assert.deepEqual(parseIiifManifest(null), []);
	assert.deepEqual(parseIiifManifest('nope'), []);
	assert.deepEqual(parseIiifManifest({}), []);
});

test('offers every PDF page, image file and canvas as a candidate, in upload order', async () => {
	const { fetchFn } = okFetch();
	const { candidates } = await prepareCandidates(
		[fakeFile('scan.pdf', 'application/pdf'), fakeFile('extra.png', 'image/png')],
		[service('https://iiif.example/img/1')],
		undefined,
		{ ...stubs, fetchFn, brokerUrl: '/auth' }
	);
	assert.deepEqual(
		candidates.map((c) => c.label),
		['scan.pdf — page 1', 'scan.pdf — page 2', 'extra.png', 'Canvas 1']
	);
	assert.deepEqual(
		candidates.map((c) => c.source.kind),
		['pdf-page', 'pdf-page', 'file', 'iiif']
	);
	assert.equal(new Set(candidates.map((c) => c.id)).size, 4, 'ids identify a page');
});

test('reads a source at preview size only, leaving the committing-size work undone', async () => {
	const scales: number[] = [];
	const { requested, fetchFn } = okFetch();
	await prepareCandidates(
		[fakeFile('scan.pdf', 'application/pdf')],
		[service('https://iiif.example/img/1')],
		undefined,
		{
			...stubs,
			renderPdf: async (file, options) => {
				scales.push(options.scale);
				return stubs.renderPdf(file, options);
			},
			downscale: async (b, maxEdge) => {
				assert.equal(maxEdge, PREVIEW_IMAGE_EDGE, 'previews are capped small');
				return b;
			},
			fetchFn,
			brokerUrl: '/auth'
		}
	);
	assert.deepEqual(scales, [0.5], 'PDF pages are rasterised at preview scale');
	assert.ok(
		requested[0].includes(encodeURIComponent(`!${PREVIEW_IMAGE_EDGE},${PREVIEW_IMAGE_EDGE}`)),
		`expected a preview-size canvas request, got ${requested[0]}`
	);
});

test('converts uploaded encodings to MEI and keeps them out of the pages', async () => {
	const { candidates, encodings } = await prepareCandidates(
		[fakeFile('piece.musicxml'), fakeFile('page.jpg', 'image/jpeg')],
		[],
		undefined,
		stubs
	);
	assert.equal(candidates.length, 1);
	assert.deepEqual(encodings, [
		{ name: 'piece.musicxml', mei: '<mei><!-- piece.musicxml --></mei>' }
	]);
});

test('rejects an unsupported upload by name', async () => {
	await assert.rejects(
		() => prepareCandidates([fakeFile('notes.txt', 'text/plain')], [], undefined, stubs),
		/Unsupported file: notes\.txt/
	);
});

test('rejects when there is nothing to prepare', async () => {
	await assert.rejects(() => prepareCandidates([], [], undefined, stubs), /No images or encodings/);
});

test('refuses to fetch IIIF canvases without a broker to relay through', async () => {
	const fetchFn = async () => {
		throw new Error('must not reach the network');
	};
	await assert.rejects(
		() => prepareCandidates([], [service('https://iiif.example/img/1')], undefined, {
			...stubs,
			fetchFn
		}),
		/broker URL is required/
	);
});

test('surfaces a failed IIIF canvas fetch', async () => {
	const fetchFn = async () => ({ ok: false, status: 404 }) as unknown as Response;
	await assert.rejects(
		() =>
			prepareCandidates([], [{ service: null, url: 'https://iiif.example/missing' }], undefined, {
				...stubs,
				fetchFn,
				brokerUrl: '/auth'
			}),
		/Could not fetch the IIIF image .* \(404\)/
	);
});

test('wraps a IIIF URL in the broker relay, escaping the target', () => {
	assert.equal(
		iiifProxyUrl('https://iiif.example/a?b=1&c=2', '/auth'),
		'/auth/iiif?url=https%3A%2F%2Fiiif.example%2Fa%3Fb%3D1%26c%3D2'
	);
});

test('fetches IIIF canvases through the relay, never the host directly', async () => {
	const { requested, fetchFn } = okFetch();
	await prepareCandidates([], [service('https://iiif.example/img/1')], undefined, {
		...stubs,
		fetchFn,
		brokerUrl: '/auth'
	});
	assert.equal(requested.length, 1);
	assert.ok(requested[0].includes('/iiif?url='), `expected the relay, got ${requested[0]}`);
	assert.ok(!requested[0].startsWith('https://iiif.example'));
});

// --- Committing the chosen pages -------------------------------------------

/** The candidates of an upload, so a subset of them can be resolved. */
async function candidatesOf(
	files: File[],
	canvases: IiifCanvas[] = [],
	options = {}
): Promise<PageCandidate[]> {
	const { candidates } = await prepareCandidates(files, canvases, undefined, {
		...stubs,
		...options
	});
	return candidates;
}

test('numbers the chosen pages across the sequence, in the order given', async () => {
	const pages = await candidatesOf([
		fakeFile('scan.pdf', 'application/pdf'),
		fakeFile('extra.png', 'image/png')
	]);
	const images = await resolvePages([pages[2], pages[0]], undefined, stubs);
	assert.deepEqual(
		images.map((i) => i.path),
		['sources/img/01.png', 'sources/img/02.jpg']
	);
});

test('renders only the chosen pages of a PDF, in one pass over it', async () => {
	const passes: PdfRenderOptions[] = [];
	const pages = await candidatesOf([fakeFile('scan.pdf', 'application/pdf')]);
	const renderPdf = async (file: File, options: PdfRenderOptions) => {
		passes.push(options);
		return stubs.renderPdf(file, options);
	};
	// Chosen out of order: the pass over the document still goes forwards.
	const images = await resolvePages([pages[1], pages[0]], undefined, { ...stubs, renderPdf });
	assert.equal(passes.length, 1, 'one pass over the document');
	assert.deepEqual(passes[0].pages, [1, 2]);
	assert.equal(passes[0].scale, 2, 'committed pages are rasterised at full scale');
	assert.equal(images.length, 2);
});

test('fetches a chosen canvas at committing size, and an unchosen one not at all', async () => {
	const pages = await candidatesOf(
		[],
		[service('https://iiif.example/img/1'), service('https://iiif.example/img/2')],
		{ fetchFn: okFetch().fetchFn, brokerUrl: '/auth' }
	);
	const { requested, fetchFn } = okFetch();
	await resolvePages([pages[1]], undefined, { ...stubs, fetchFn, brokerUrl: '/auth' });
	assert.equal(requested.length, 1);
	assert.ok(requested[0].includes(encodeURIComponent('img/2')), 'the chosen canvas');
	assert.ok(
		requested[0].includes(encodeURIComponent(`!${MAX_IMAGE_EDGE},${MAX_IMAGE_EDGE}`)),
		`expected a committing-size request, got ${requested[0]}`
	);
});

test('keeps images within the cap byte-for-byte and re-encodes downscaled ones as JPEG', async () => {
	const pages = await candidatesOf([fakeFile('big.png', 'image/png')]);
	const downscaled = await resolvePages(pages, undefined, {
		...stubs,
		// Simulate a downscale: a different blob comes back.
		downscale: async () => blob('downscaled')
	});
	assert.equal(downscaled[0].path, 'sources/img/01.jpg', 'a re-encoded image commits as .jpg');

	const untouched = await resolvePages(pages, undefined, stubs);
	assert.equal(untouched[0].path, 'sources/img/01.png', 'an unchanged image keeps its type');
});

test('fetches a manifest and returns its canvases', async () => {
	const manifest = {
		items: [{ items: [{ items: [{ body: { service: [{ id: 'https://iiif.example/img/9' }] } }] }] }]
	};
	const fetchFn = async () => ({ ok: true, json: async () => manifest }) as unknown as Response;
	assert.deepEqual(await fetchIiifCanvases('https://iiif.example/manifest', '/auth', { fetchFn }), [
		{ service: 'https://iiif.example/img/9', url: '' }
	]);
});

test('reports a manifest with no canvases rather than committing nothing', async () => {
	const fetchFn = async () => ({ ok: true, json: async () => ({}) }) as unknown as Response;
	await assert.rejects(
		() => fetchIiifCanvases('https://iiif.example/manifest', '/auth', { fetchFn }),
		/No canvas images were found/
	);
});
