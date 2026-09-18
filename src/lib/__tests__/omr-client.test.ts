import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOmrClient, OmrError } from '../omr-client.ts';

interface Seen {
	method: string;
	url: string;
	body?: string;
	contentType?: string;
}

/** A fetch that answers from `routes` (method + URL → response) and records every call. */
function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
	const seen: Seen[] = [];
	const doFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const method = init?.method ?? 'GET';
		const url = String(input);
		const body = init?.body;
		seen.push({
			method,
			url,
			body: typeof body === 'string' ? body : body instanceof Blob ? await body.text() : undefined,
			contentType: (init?.headers as Record<string, string> | undefined)?.['content-type']
		});
		const route = routes[`${method} ${url}`] ?? routes[`${method} ${url.split('?')[0]}`];
		if (!route) return Response.json({ error: `unrouted ${method} ${url}` }, { status: 404 });
		return route(init);
	};
	return { seen, fetch: doFetch as typeof fetch };
}

const noSleep = { sleep: async () => undefined };
const BASE = '/auth/omr';

test('requirePipelines names the pipelines the service no longer offers', async () => {
	const { fetch } = fakeFetch({
		[`GET ${BASE}/api/pipelines`]: () =>
			Response.json({
				pipelines: [
					{ name: 'dvorak-ola', version: '2.0-2025-03-09', implicit: true, signature: {} },
					{ name: 'mzk-staff', version: '2', implicit: false, signature: {} }
				],
				warnings: []
			})
	});
	const client = createOmrClient('/auth', { fetch, ...noSleep });
	await client.requirePipelines([{ name: 'dvorak-ola', version: '2.0-2025-03-09' }]);
	await assert.rejects(
		client.requirePipelines([
			{ name: 'mzk-staff', version: '1' },
			{ name: 'ayce', version: 'x' }
		]),
		/no longer offers mzk-staff 1, ayce x/
	);
});

test('upload asks for presigned URLs, then puts each file through the blob relay', async () => {
	const { seen, fetch } = fakeFetch({
		[`POST ${BASE}/api/musicorpus-pages/p1/file-urls`]: () =>
			Response.json({
				put: {
					'Staves/1/image.jpg': 'https://quest.example/bucket/p1/Staves/1/image.jpg?sig=a',
					'Staves/2/image.jpg': 'https://quest.example/bucket/p1/Staves/2/image.jpg?sig=b'
				},
				expires_at: '2026-09-18T10:00:00Z'
			}),
		[`PUT ${BASE}/blob`]: () => Response.json({ ok: true })
	});
	const client = createOmrClient('/auth', { fetch, ...noSleep });
	await client.upload('p1', {
		'Staves/1/image.jpg': new Blob(['one'], { type: 'image/jpeg' }),
		'Staves/2/image.jpg': new Blob(['two'], { type: 'image/jpeg' })
	});
	assert.deepEqual(JSON.parse(seen[0].body!), { put: ['Staves/1/image.jpg', 'Staves/2/image.jpg'] });
	assert.equal(
		seen[1].url,
		`${BASE}/blob?url=${encodeURIComponent('https://quest.example/bucket/p1/Staves/1/image.jpg?sig=a')}`
	);
	assert.deepEqual(
		seen.slice(1).map((s) => [s.method, s.body, s.contentType]),
		[
			['PUT', 'one', 'image/jpeg'],
			['PUT', 'two', 'image/jpeg']
		]
	);
});

test('download fetches each presigned URL through the blob relay', async () => {
	const { fetch } = fakeFetch({
		[`POST ${BASE}/api/musicorpus-pages/p1/file-urls`]: () =>
			Response.json({ get: { 'layout.json': 'https://quest.example/b/layout.json?sig=c' } }),
		[`GET ${BASE}/blob`]: () => new Response('{"annotations":[]}', { headers: { 'content-type': 'application/json' } })
	});
	const client = createOmrClient('/auth', { fetch, ...noSleep });
	const files = await client.download('p1', ['layout.json']);
	assert.equal(await files['layout.json'].text(), '{"annotations":[]}');
});

test('run starts the execution and polls until it has settled', async () => {
	let polls = 0;
	const { seen, fetch } = fakeFetch({
		[`POST ${BASE}/api/musicorpus-pages/p1/pipeline-executions`]: () =>
			Response.json({
				execution_id: 7,
				pipeline_name: 'mzk-staff',
				pipeline_version: '1',
				input: ['Staves/1/image.jpg'],
				state: 'running',
				error: null
			}),
		[`GET ${BASE}/api/musicorpus-pages/p1/pipeline-executions/7`]: () =>
			Response.json({
				execution_id: 7,
				pipeline_name: 'mzk-staff',
				pipeline_version: '1',
				input: ['Staves/1/image.jpg'],
				state: ++polls < 3 ? 'running' : 'failed',
				error: polls < 3 ? null : 'malformed sequence'
			})
	});
	const client = createOmrClient('/auth', { fetch, ...noSleep });
	const execution = await client.run(
		'p1',
		{ name: 'mzk-staff', version: '1' },
		['Staves/1/image.jpg'],
		{ image_size: 1280 }
	);
	assert.deepEqual(JSON.parse(seen[0].body!), {
		pipeline_name: 'mzk-staff',
		pipeline_version: '1',
		input: ['Staves/1/image.jpg'],
		parameters: { image_size: 1280 }
	});
	assert.equal(polls, 3);
	// A failed execution is reported, not thrown: one staff failing must not fail a page.
	assert.equal(execution.state, 'failed');
	assert.equal(execution.error, 'malformed sequence');
});

test('run gives up on an execution that never settles', async () => {
	let now = 0;
	const { fetch } = fakeFetch({
		[`POST ${BASE}/api/musicorpus-pages/p1/pipeline-executions`]: () =>
			Response.json({ execution_id: 1, state: 'running', error: null }),
		[`GET ${BASE}/api/musicorpus-pages/p1/pipeline-executions/1`]: () =>
			Response.json({ execution_id: 1, state: 'running', error: null })
	});
	const client = createOmrClient('/auth', {
		fetch,
		executionTimeoutMs: 2500,
		pollMs: 1000,
		sleep: async (ms) => {
			now += ms;
		}
	});
	const realNow = Date.now;
	Date.now = () => now;
	try {
		await assert.rejects(
			client.run('p1', { name: 'mzk-staff', version: '1' }, ['Staves/1/image.jpg']),
			/did not finish within 2\.5s/
		);
	} finally {
		Date.now = realNow;
	}
});

test('withPage deletes the page even when the work fails', async () => {
	const { seen, fetch } = fakeFetch({
		[`POST ${BASE}/api/musicorpus-pages`]: () => Response.json({ page_id: 'p9', executions: [] }, { status: 201 }),
		[`DELETE ${BASE}/api/musicorpus-pages/p9`]: () => new Response(null, { status: 204 })
	});
	const client = createOmrClient('/auth', { fetch, ...noSleep });
	await assert.rejects(
		client.withPage(async (pageId) => {
			assert.equal(pageId, 'p9');
			throw new Error('crop failed');
		}),
		/crop failed/
	);
	assert.deepEqual(
		seen.map((s) => `${s.method} ${s.url}`),
		[`POST ${BASE}/api/musicorpus-pages`, `DELETE ${BASE}/api/musicorpus-pages/p9`]
	);
});

test("a failing relay status carries the relay's message and the status", async () => {
	const { fetch } = fakeFetch({
		[`POST ${BASE}/api/musicorpus-pages`]: () =>
			Response.json({ error: 'OMR is not configured on this instance', source: 'musibot' }, { status: 503 })
	});
	const client = createOmrClient('/auth', { fetch, ...noSleep });
	await assert.rejects(client.createPage(), (err: unknown) => {
		assert.ok(err instanceof OmrError);
		assert.equal(err.status, 503);
		assert.match(err.message, /returned 503 .*: OMR is not configured on this instance/);
		return true;
	});
});
