import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	blobToBase64,
	classifyUpload,
	iiifCanvasUrl,
	iiifImageUrl,
	iiifProxyUrl,
	parseIiifManifest,
	prepareCandidates,
	resolvePages,
	fetchIiifCanvases,
	IIIF_PREVIEW_REQUESTS,
	IIIF_REQUESTS_PER_SECOND,
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

// Injected browser steps: no canvas, pdf.js or verovio outside a browser. `wait`
// returns at once, so tests that are not about pacing do not pay for it.
const stubs = {
	renderPdf: async (file: File, options: PdfRenderOptions) =>
		(options.pages ?? [1, 2]).map((page) => blob(`${file.name}-p${page}@${options.scale}`)),
	downscale: async (b: Blob) => b,
	toMei: async (f: File) => `<mei><!-- ${f.name} --></mei>`,
	wait: async () => {}
};

/** The nth canvas a relay URL points at, from `.../img/<n>/...` escaped in it. */
const canvasNumber = (input: RequestInfo | URL) =>
	Number(String(input).match(/img%2F(\d+)/)?.[1] ?? 0);

/** A failure carrying the broker's marker for whose answer the status is. */
const marked = (status: number, upstream: string | null) =>
	({
		ok: false,
		status,
		headers: { get: (name: string) => (name === 'x-lets-encode-upstream' ? upstream : null) }
	}) as unknown as Response;

/** A status the relay passed through from the source server. */
const relayed = (status: number) => marked(status, 'iiif');
/** The relay's rate-limit refusal, which it marks as its own answer. */
const refused = (status: number) => marked(status, 'broker');
/** A relay error raised before reaching out, which carries no marker at all. */
const unmarked = (status: number) => marked(status, null);

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
	assert.deepEqual(scales, [1.5], 'PDF pages are rasterised at preview scale');
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

test('fetches canvas previews a few at a time, keeping the manifest order', async () => {
	const canvases = Array.from({ length: 10 }, (_, i) => service(`https://iiif.example/img/${i + 1}`));
	let inFlight = 0;
	let peak = 0;
	const fetchFn = async (input: RequestInfo | URL) => {
		peak = Math.max(peak, ++inFlight);
		// Answer in reverse: a later canvas comes back before an earlier one.
		const nth = canvasNumber(input);
		await new Promise((resolve) => setTimeout(resolve, (11 - nth) * 2));
		inFlight--;
		return { ok: true, blob: async () => blob(`canvas-${nth}`) } as unknown as Response;
	};
	const { candidates } = await prepareCandidates([], canvases, undefined, {
		...stubs,
		fetchFn,
		brokerUrl: '/auth'
	});
	assert.ok(peak > 1, 'previews are fetched in parallel');
	assert.ok(
		peak <= IIIF_PREVIEW_REQUESTS,
		`expected at most ${IIIF_PREVIEW_REQUESTS} requests in flight, saw ${peak}`
	);
	assert.deepEqual(
		candidates.map((c) => (c.preview as unknown as { marker: string }).marker),
		canvases.map((_, i) => `canvas-${i + 1}`)
	);
});

test("spaces relay requests inside the broker's per-second budget", async () => {
	const canvases = Array.from({ length: 30 }, (_, i) => service(`https://iiif.example/img/${i + 1}`));
	// A virtual clock: waiting advances it rather than spending the time asked for.
	let now = 0;
	const starts: number[] = [];
	const fetchFn = async () => {
		starts.push(now);
		return { ok: true, blob: async () => blob('canvas') } as unknown as Response;
	};
	await prepareCandidates([], canvases, undefined, {
		...stubs,
		fetchFn,
		brokerUrl: '/auth',
		wait: async (ms: number) => {
			now += ms;
		}
	});
	assert.equal(starts.length, canvases.length);
	for (const start of starts) {
		const inSecond = starts.filter((at) => at >= start && at < start + 1000).length;
		assert.ok(
			inSecond <= IIIF_REQUESTS_PER_SECOND,
			`expected at most ${IIIF_REQUESTS_PER_SECOND} requests in any second, saw ${inSecond}`
		);
	}
});

test('waits longer and re-attempts a refused canvas, keeping the ones already fetched', async () => {
	const canvases = Array.from({ length: 12 }, (_, i) => service(`https://iiif.example/img/${i + 1}`));
	const waits: number[] = [];
	let refusedOnce = false;
	const fetchFn = async (input: RequestInfo | URL) => {
		const nth = canvasNumber(input);
		if (nth === 7 && !refusedOnce) {
			refusedOnce = true;
			return refused(429);
		}
		return { ok: true, blob: async () => blob(`canvas-${nth}`) } as unknown as Response;
	};
	const { candidates } = await prepareCandidates([], canvases, undefined, {
		...stubs,
		fetchFn,
		brokerUrl: '/auth',
		wait: async (ms: number) => {
			waits.push(ms);
		}
	});
	assert.deepEqual(
		candidates.map((c) => (c.preview as unknown as { marker: string }).marker),
		canvases.map((_, i) => `canvas-${i + 1}`)
	);
	const pacingInterval = 1000 / IIIF_REQUESTS_PER_SECOND;
	assert.ok(
		waits.some((ms) => ms > pacingInterval),
		`expected a wait longer than the ${pacingInterval}ms pacing interval, got ${waits.join(', ')}`
	);
});

test('gives up on a canvas the relay keeps refusing, blaming the relay not the source', async () => {
	let requests = 0;
	const fetchFn = async () => {
		requests++;
		return refused(429);
	};
	await assert.rejects(
		() =>
			prepareCandidates([], [service('https://iiif.example/img/1')], undefined, {
				...stubs,
				fetchFn,
				brokerUrl: '/auth'
			}),
		/too many requests to the image relay .*\(429\)/
	);
	assert.ok(requests > 1, 'expected the refused canvas to be re-attempted');
});

test('tells a source server’s refusal apart from the relay’s own', async () => {
	const canvas = { service: null, url: 'https://iiif.example/missing' };
	const fails = (res: Response) =>
		prepareCandidates([], [canvas], undefined, {
			...stubs,
			fetchFn: async () => res,
			brokerUrl: '/auth'
		});
	// One status must not read the same from both sides: a relayed 429 is the
	// source rationing its own service, the relay's own is this application's cap.
	await assert.rejects(() => fails(refused(429)), /image relay/);
	await assert.rejects(() => fails(relayed(429)), /source server returned 429/);
	// An error the relay raises before reaching out is marked by its absence.
	await assert.rejects(() => fails(unmarked(502)), /the image relay answered 502/);
});

test('stops fetching previews once one canvas has failed', async () => {
	const canvases = Array.from({ length: 40 }, (_, i) => service(`https://iiif.example/img/${i + 1}`));
	let requests = 0;
	const fetchFn = async () => {
		requests++;
		return relayed(503);
	};
	await assert.rejects(
		() => prepareCandidates([], canvases, undefined, { ...stubs, fetchFn, brokerUrl: '/auth' }),
		/returned 503/
	);
	assert.ok(
		requests <= IIIF_PREVIEW_REQUESTS,
		`expected the pass to stop, but it made ${requests} requests`
	);
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
	const fetchFn = async () => relayed(404);
	await assert.rejects(
		() =>
			prepareCandidates([], [{ service: null, url: 'https://iiif.example/missing' }], undefined, {
				...stubs,
				fetchFn,
				brokerUrl: '/auth'
			}),
		/Could not fetch the IIIF image at https:\/\/iiif\.example\/missing: the source server returned 404\./
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

test('names the server that refused a manifest', async () => {
	await assert.rejects(
		() => fetchIiifCanvases('https://iiif.example/manifest', '/auth', { fetchFn: async () => refused(429) }),
		/Could not fetch the IIIF manifest at https:\/\/iiif\.example\/manifest: too many requests to the image relay/
	);
	await assert.rejects(
		() => fetchIiifCanvases('https://iiif.example/manifest', '/auth', { fetchFn: async () => relayed(404) }),
		/the source server returned 404/
	);
});

test('reports a manifest with no canvases rather than committing nothing', async () => {
	const fetchFn = async () => ({ ok: true, json: async () => ({}) }) as unknown as Response;
	await assert.rejects(
		() => fetchIiifCanvases('https://iiif.example/manifest', '/auth', { fetchFn }),
		/No canvas images were found/
	);
});

test('blobToBase64 preserves arbitrary bytes', async () => {
	assert.equal(await blobToBase64(new Blob([new Uint8Array([0, 1, 254, 255])])), 'AAH+/w==');
});
