import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPullRequestDetails, getPullRequestFiles, RateLimitError } from './github-rest.js';

const file = (index: number) => ({ filename: `sources/${index}.mei`, status: 'modified' });

test('getPullRequestFiles reads every page before returning the PR boundary', async (t) => {
	const urls: string[] = [];
	t.mock.method(globalThis, 'fetch', async (input) => {
		const url = String(input);
		urls.push(url);
		const page = new URL(url).searchParams.get('page');
		return Response.json(page === '1' ? Array.from({ length: 100 }, (_, i) => file(i)) : [file(100)]);
	});

	const files = await getPullRequestFiles('token', 'owner', 'repo', 7, 101);
	assert.equal(files.length, 101);
	assert.deepEqual(
		urls.map((url) => new URL(url).searchParams.get('page')),
		['1', '2']
	);
});

test('getPullRequestFiles fails closed when GitHub returns a partial list', async (t) => {
	t.mock.method(globalThis, 'fetch', async () => Response.json([file(0)]));
	await assert.rejects(
		getPullRequestFiles('token', 'owner', 'repo', 7, 2),
		/Incomplete pull-request file list: expected 2, received 1/
	);
});

test('getPullRequestFiles rejects PRs beyond GitHub’s inspection limit without fetching', async (t) => {
	const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json([]));
	await assert.rejects(getPullRequestFiles('token', 'owner', 'repo', 7, 3001), /3,000-file inspection limit/);
	assert.equal(fetch.mock.callCount(), 0);
});

test('secondary rate limits are surfaced even when primary quota remains', async (t) => {
	t.mock.method(globalThis, 'fetch', async () =>
		Response.json(
			{ message: 'You have exceeded a secondary rate limit.' },
			{ status: 403, headers: { 'X-RateLimit-Remaining': '42', 'Retry-After': '30' } }
		)
	);
	await assert.rejects(
		getPullRequestDetails('token', 'owner', 'repo', 7),
		(error: unknown) => error instanceof RateLimitError && error.retryAfterSeconds === 30
	);
});

test('ordinary permission failures are not mislabeled as rate limits', async (t) => {
	t.mock.method(globalThis, 'fetch', async () =>
		Response.json({ message: 'Resource not accessible by integration' }, { status: 403 })
	);
	await assert.rejects(
		getPullRequestDetails('token', 'owner', 'repo', 7),
		(error: unknown) => error instanceof Error && !(error instanceof RateLimitError) && /Resource not accessible/.test(error.message)
	);
});
