import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	SESSION,
	routeSessionVia,
	getRepoAccess,
	getPullRequestDetails,
	getPullRequestFiles,
	commitFiles,
	ensureFork,
	fastForwardBranch,
	deleteBranch,
	openChangePr,
	RateLimitError,
	getGitHubRequestTelemetry,
	resetGitHubRequestTelemetry
} from '../forge/github-rest.ts';

const file = (index: number) => ({ filename: `sources/${index}.mei`, status: 'modified' });

test('getPullRequestFiles reads every page before returning the PR boundary', async (t) => {
	const urls: string[] = [];
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
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
	await assert.rejects(getPullRequestFiles('token', 'owner', 'repo', 7, -1), /invalid changed-file count/);
	await assert.rejects(getPullRequestFiles('token', 'owner', 'repo', 7, 1.5), /invalid changed-file count/);
	await assert.rejects(getPullRequestFiles('token', 'owner', 'repo', 7, 3001), /3,000-file inspection limit/);
	assert.equal(fetch.mock.callCount(), 0);
});

test('SESSION routes through the broker without exposing an Authorization header', async (t) => {
	routeSessionVia('/oauth/proxy/api.github.com');
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(String(input), '/oauth/proxy/api.github.com/repos/owner/repo');
		assert.equal(new Headers(init?.headers).get('Authorization'), null);
		return Response.json({ private: true, permissions: { push: true } });
	});
	assert.deepEqual(await getRepoAccess(SESSION, 'owner', 'repo'), { isPrivate: true, canPush: true });
});

test('JSON reads reuse a cached ETag body after a 304 response', async (t) => {
	let call = 0;
	t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
		const etag = new Headers(init?.headers).get('If-None-Match');
		if (call++ === 0) {
			assert.equal(etag, null);
			return Response.json(
				{ private: false, permissions: { push: true } },
				{ headers: { ETag: '"repo-v1"' } }
			);
		}
		assert.equal(etag, '"repo-v1"');
		return new Response(null, { status: 304 });
	});
	const first = await getRepoAccess('token', 'etag-owner', 'etag-repo');
	const second = await getRepoAccess('token', 'etag-owner', 'etag-repo');
	assert.deepEqual(second, first);
});

test('commitFiles builds one tree and advances the requested branch from the supplied base', async (t) => {
	const calls: Array<{ url: string; method: string; body: unknown; headers: Headers }> = [];
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, method, body, headers: new Headers(init?.headers) });
		if (url.endsWith('/git/commits/base-sha')) return Response.json({ tree: { sha: 'base-tree' } });
		if (url.endsWith('/git/blobs')) return Response.json({ sha: 'binary-blob' });
		if (url.endsWith('/git/trees')) return Response.json({ sha: 'new-tree' });
		if (url.endsWith('/git/commits')) return Response.json({ sha: 'new-commit' });
		if (url.endsWith('/git/refs/heads/work')) return Response.json({});
		throw new Error(`Unexpected request: ${method} ${url}`);
	});

	const sha = await commitFiles(
		'token',
		'owner',
		'repo',
		[
			{ path: 'tracking/state.csv', content: 'state' },
			{ path: 'sources/page.jpg', contentBase64: 'aW1hZ2U=' }
		],
		'Update campaign',
		{ baseSha: 'base-sha', branch: 'work' }
	);
	assert.equal(sha, 'new-commit');
	assert.equal(calls[0].headers.get('Authorization'), 'Bearer token');
	assert.deepEqual(calls.find((call) => call.url.endsWith('/git/trees'))?.body, {
		base_tree: 'base-tree',
		tree: [
			{ path: 'tracking/state.csv', mode: '100644', type: 'blob', content: 'state' },
			{ path: 'sources/page.jpg', mode: '100644', type: 'blob', sha: 'binary-blob' }
		]
	});
	assert.deepEqual(calls.find((call) => call.url.endsWith('/git/commits'))?.body, {
		message: 'Update campaign',
		tree: 'new-tree',
		parents: ['base-sha']
	});
	assert.deepEqual(calls.at(-1)?.body, { sha: 'new-commit' });
});

test('commitFiles rejects ambiguous file content before making a request', async (t) => {
	const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}));
	const commit = (file: { path: string; content?: string; contentBase64?: string }) =>
		commitFiles('token', 'owner', 'repo', [file], 'Invalid update', {
			baseSha: 'base-sha',
			branch: 'work'
		});
	await assert.rejects(commit({ path: 'empty.txt' }), /exactly one of content or contentBase64/);
	await assert.rejects(
		commit({ path: 'ambiguous.txt', content: 'text', contentBase64: 'dGV4dA==' }),
		/exactly one of content or contentBase64/
	);
	assert.equal(fetch.mock.callCount(), 0);
});

test('ensureFork waits for readiness and syncs its default branch with upstream', async (t) => {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body = init?.body ? JSON.parse(String(init.body)) : null;
		calls.push({ url, method, body });
		if (url.endsWith('/repos/upstream-owner/score/forks')) {
			return Response.json({ full_name: 'volunteer/score', default_branch: 'main' }, { status: 202 });
		}
		if (url.endsWith('/repos/volunteer/score/git/ref/heads/main')) return Response.json({ object: { sha: 'fork-sha' } });
		if (url.endsWith('/repos/volunteer/score/merge-upstream')) return Response.json({ merge_type: 'fast-forward' });
		throw new Error(`Unexpected request: ${method} ${url}`);
	});

	assert.deepEqual(await ensureFork('token', 'upstream-owner', 'score'), {
		owner: 'volunteer',
		repo: 'score'
	});
	assert.deepEqual(calls.at(-1), {
		url: 'https://api.github.com/repos/volunteer/score/merge-upstream',
		method: 'POST',
		body: { branch: 'main' }
	});
});

test('fastForwardBranch distinguishes non-fast-forward conflicts from API failures', async (t) => {
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
		if (String(input).includes('/conflict/')) {
			return Response.json({ message: 'Update is not a fast forward' }, { status: 422 });
		}
		return Response.json({ message: 'Resource not accessible by integration' }, { status: 403 });
	});

	assert.equal(await fastForwardBranch('token', 'owner', 'conflict', 'work', 'sha'), false);
	await assert.rejects(
		fastForwardBranch('token', 'owner', 'forbidden', 'work', 'sha'),
		/Resource not accessible by integration/
	);
});

test('deleteBranch does not hide arbitrary 422 responses', async (t) => {
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
		if (String(input).includes('/missing/')) {
			return Response.json({ message: 'Reference does not exist' }, { status: 422 });
		}
		return Response.json({ message: 'Cannot delete the default branch' }, { status: 422 });
	});

	await deleteBranch('token', 'owner', 'missing', 'work');
	await assert.rejects(deleteBranch('token', 'owner', 'protected', 'main'), /Cannot delete the default branch/);
});

test('openChangePr removes its prepared branch when PR creation fails', async (t) => {
	let deleted = false;
	t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		if (url.endsWith('/repos/lifecycle-owner/score') && method === 'GET') {
			return Response.json({ default_branch: 'main', permissions: { push: true } });
		}
		if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'base-sha' } });
		if (url.endsWith('/git/refs') && method === 'POST') return Response.json({}, { status: 201 });
		if (url.endsWith('/git/commits/base-sha')) return Response.json({ tree: { sha: 'base-tree' } });
		if (url.endsWith('/git/trees')) return Response.json({ sha: 'new-tree' });
		if (url.endsWith('/git/commits') && method === 'POST') return Response.json({ sha: 'new-commit' });
		if (url.endsWith('/git/refs/heads/work') && method === 'PATCH') return Response.json({});
		if (url.endsWith('/pulls') && method === 'POST') {
			return Response.json({ message: 'Validation Failed', errors: [{ message: 'No commits between main and work' }] }, { status: 422 });
		}
		if (url.endsWith('/git/refs/heads/work') && method === 'DELETE') {
			deleted = true;
			return new Response(null, { status: 204 });
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});

	await assert.rejects(
		openChangePr('token', 'lifecycle-owner', 'score', {
			branch: 'work',
			files: [{ path: 'tracking/lock.csv', content: 'lock' }],
			message: 'Prepare claim',
			title: 'Claim',
			body: 'Claim body'
		}),
		/No commits between main and work/
	);
	assert.equal(deleted, true);
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
		(error: unknown) =>
			error instanceof RateLimitError &&
			error.source === 'github' &&
			error.remaining === 42 &&
			error.retryAfterSeconds === 30
	);
});

test('request telemetry records rate headers without query strings', async (t) => {
	resetGitHubRequestTelemetry();
	t.mock.method(console, 'info', () => {});
	t.mock.method(globalThis, 'fetch', async () =>
		Response.json(
			{ private: false, permissions: { push: true } },
			{
				headers: {
					'X-RateLimit-Resource': 'core',
					'X-RateLimit-Limit': '5000',
					'X-RateLimit-Remaining': '4998',
					'X-RateLimit-Used': '2',
					'X-RateLimit-Reset': '2000000000'
				}
			}
		)
	);

	await getRepoAccess('token', 'telemetry-owner', 'telemetry-repo');
	const telemetry = getGitHubRequestTelemetry();
	assert.equal(telemetry.total, 1);
	assert.deepEqual(telemetry.byMethod, { GET: 1 });
	assert.deepEqual(telemetry.byResource, { core: 1 });
	assert.equal(telemetry.last?.endpoint, '/repos/telemetry-owner/telemetry-repo');
	assert.equal(telemetry.last?.remaining, 4998);
	assert.equal(telemetry.last?.limit, 5000);
	assert.equal(telemetry.last?.used, 2);
});

test('broker throttling is distinguished from a GitHub rate limit', async (t) => {
	resetGitHubRequestTelemetry();
	t.mock.method(console, 'info', () => {});
	t.mock.method(globalThis, 'fetch', async () =>
		Response.json(
			{ error: 'OAuth broker request rate limit exceeded', source: 'broker' },
			{ status: 429, headers: { 'X-Lets-Encode-Upstream': 'broker' } }
		)
	);

	await assert.rejects(
		getPullRequestDetails(SESSION, 'owner', 'repo', 7),
		(error: unknown) =>
			error instanceof RateLimitError &&
			error.source === 'broker' &&
			/OAuth broker request rate limit exceeded/.test(error.message)
	);
	assert.equal(getGitHubRequestTelemetry().rateLimited, 1);
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
