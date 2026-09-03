import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commands, invoke, setVerdictSink, type CommandContext } from '../commands.ts';
import { envelopeFromPrBody } from '../command-envelope.ts';
import type { ForgeClient, OpenedChangeRequest } from '../forge/types.ts';

type ForgeOverrides = Partial<{ [K in keyof ForgeClient]: ForgeClient[K] }>;

function fakeForge(overrides: ForgeOverrides): ForgeClient {
	return new Proxy(overrides, {
		get(target, property) {
			if (property in target) return target[property as keyof ForgeOverrides];
			return () => {
				throw new Error(`Unexpected forge call: ${String(property)}`);
			};
		}
	}) as ForgeClient;
}

function context(forge: ForgeClient): CommandContext {
	// viewer is the acting user's numeric id (written to the tables); viewerLogin
	// is their login (human-readable PR prose only).
	return {
		forge,
		repoId: 555,
		owner: 'campaign-owner',
		repo: 'campaign',
		viewer: '9001',
		viewerLogin: 'volunteer',
		progress: () => {}
	};
}

async function withImmediateTimeouts<T>(run: () => Promise<T>): Promise<T> {
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
		queueMicrotask(callback);
		return 0;
	}) as typeof setTimeout;
	try {
		return await run();
	} finally {
		globalThis.setTimeout = original;
	}
}

const lockHeader = 'task_id,subtask_id,user_id,timestamp,kind\n';
// What an encoding submission reads before opening its PR: the task table for
// the fragment path, and the fragment itself from the encode branch.
const encodingFiles: Record<string, string> = {
	'tracking/task.csv': 'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n',
	'sources/score.mei': '<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.1"/>'
};
// Take the schema download away, so the browser-side pre-check reports itself
// unavailable and the submission proceeds to the automation's check.
function offline(t: { mock: { method: (obj: object, name: string, impl: () => Promise<never>) => unknown } }): void {
	t.mock.method(globalThis, 'fetch', async () => {
		throw new Error('offline');
	});
}

// Capture the background settlement of an optimistic PR command: the promise
// resolves when the command's verdict lands in the sink.
function captureVerdict(): Promise<{ state: string; message: string }> {
	return new Promise((resolve) => {
		setVerdictSink({
			begin: () => 'test',
			attachPr: () => {},
			settle: (_id, state, message) => resolve({ state, message })
		});
	});
}

test('readTables decodes generated quoted config values', async () => {
	const files: Record<string, string> = {
		'tracking/task.csv':
			'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n',
		'tracking/state.csv':
			'task_id,subtask_id,status,encoder,encoded_at,validate_status_1,validate_status_2\nT0001,,encoding_required,,,,\n',
		'tracking/lock.csv': lockHeader,
		'tracking/history.csv':
			'timestamp,task_id,subtask_id,user_id,action,outcome,detail,command,command_version,command_input\n',
		'config.yaml':
			'campaign:\n  title: "A \\"quoted\\" \\\\ title\\nsecond line"\n  license: "CC-BY-4.0"\nvalidation:\n  pass_threshold: 2\n'
	};
	const forge = fakeForge({
		getRepoFile: async (_owner, _repo, path) => files[path] ?? null,
		getRepoAccess: async () => ({ isPrivate: true, canPush: false })
	});

	const result = await invoke(commands.readTables, {}, context(forge));

	assert.equal(result.title, 'A "quoted" \\ title\nsecond line');
	assert.equal(result.license, 'CC-BY-4.0');
	assert.equal(result.passThreshold, 2);
	assert.equal(result.isPrivate, true);
});

test('submitValidation rejects an invalid verdict before opening a PR', async () => {
	const result = await invoke(
		commands.submitValidation,
		{ task_id: 'T0001', subtask_id: 'S0001', verdict: 'passing' },
		context(fakeForge({}))
	);

	assert.equal(result.error, 'Invalid validation verdict: passing.');
});

test('a headless claim carries its envelope and cleans its fork branch after acceptance', async () => {
	let openedBody = '';
	let deleted: string[] = [];
	const opened: OpenedChangeRequest = {
		number: 12,
		html_url: 'https://example.test/pr/12',
		head: { owner: 'volunteer', repo: 'campaign', branch: 'claim-P0001-abcd' }
	};
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoFile: async (_owner, _repo, path) => (path === 'tracking/lock.csv' ? lockHeader : null),
		openChangePr: async (_owner, _repo, options) => {
			openedBody = options.body;
			return opened;
		},
		getPullRequestState: async () => 'closed',
		getLastIssueComment: async () => '✅ Claim accepted.',
		deleteBranch: async (owner, repo, branch) => {
			deleted = [owner, repo, branch];
		}
	});

	const result = await withImmediateTimeouts(() =>
		invoke(commands.claimTask, { task_id: 'P0001' }, context(forge))
	);
	const envelope = envelopeFromPrBody(openedBody);

	assert.equal(result.ok, true);
	assert.equal(envelope?.command, 'campaign.claimTask');
	assert.equal(envelope?.user_id, '9001');
	assert.deepEqual(envelope?.input, { task_id: 'P0001' });
	assert.deepEqual(deleted, ['volunteer', 'campaign', 'claim-P0001-abcd']);
});

test('a failed automation run surfaces as an error while the PR stays open', async () => {
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoFile: async () => lockHeader,
		openChangePr: async () => ({
			number: 21,
			html_url: 'https://example.test/pr/21',
			headSha: 'abc123',
			head: { owner: 'volunteer', repo: 'campaign', branch: 'claim-P0001-abcd' }
		}),
		getPullRequestState: async () => 'open',
		listWorkflowRuns: async (_owner, _repo, _workflow, filter) => {
			assert.equal(filter?.headSha, 'abc123');
			return [
				{
					id: 7,
					status: 'completed',
					conclusion: 'failure',
					created_at: new Date().toISOString(),
					html_url: 'https://example.test/run/7'
				}
			];
		}
	});

	const result = await withImmediateTimeouts(() =>
		invoke(commands.claimTask, { task_id: 'P0001' }, context(forge))
	);

	assert.match(result.error ?? '', /automation run for PR #21 failed/);
	assert.match(result.error ?? '', /example\.test\/run\/7/);
});

test('a skipped automation run is explained and its PR closed by the console', async () => {
	let closed = 0;
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoFile: async () => lockHeader,
		openChangePr: async () => ({
			number: 22,
			html_url: 'https://example.test/pr/22',
			headSha: 'def456',
			head: { owner: 'volunteer', repo: 'campaign', branch: 'claim-P0001-abcd' }
		}),
		getPullRequestState: async () => 'open',
		listWorkflowRuns: async () => [
			{
				id: 8,
				status: 'completed',
				conclusion: 'skipped',
				created_at: new Date().toISOString(),
				html_url: 'https://example.test/run/8'
			}
		],
		closePullRequest: async (_owner, _repo, number) => {
			assert.equal(number, 22);
			closed++;
		}
	});

	const result = await withImmediateTimeouts(() =>
		invoke(commands.claimTask, { task_id: 'P0001' }, context(forge))
	);

	assert.match(result.error ?? '', /did not run for PR #22: a pull request must change at most two files/);
	assert.match(result.error ?? '', /was closed/);
	assert.equal(closed, 1);
});

test('a closed PR without a coordinator verdict fails closed', async () => {
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoFile: async () => lockHeader,
		openChangePr: async () => ({
			number: 13,
			html_url: 'https://example.test/pr/13',
			head: { owner: 'campaign-owner', repo: 'campaign', branch: 'claim-P0001-abcd' }
		}),
		getPullRequestState: async () => 'closed',
		getLastIssueComment: async () => null
	});

	const result = await withImmediateTimeouts(() =>
		invoke(commands.claimTask, { task_id: 'P0001' }, context(forge))
	);

	assert.equal(result.error, 'PR #13 closed without a coordinator verdict.');
	assert.equal(result.warn, undefined);
});

test('a volunteer encoding submission cleans the encode branch in their fork', async (t) => {
	offline(t);
	let pullHead = '';
	let deleted: string[] = [];
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoHead: async () => ({ branch: 'main', sha: 'base-sha', treeSha: 'base-sha-tree', canPush: false }),
		ensureFork: async () => ({ owner: 'volunteer', repo: 'campaign' }),
		getRepoFile: async (_owner, _repo, path) => encodingFiles[path] ?? null,
		createPullRequest: async (_owner, _repo, options) => {
			pullHead = options.head;
			return { number: 14, html_url: 'https://example.test/pr/14' };
		},
		getPullRequestState: async () => 'closed',
		getLastIssueComment: async () => '✅ Submission accepted (encoding).',
		deleteBranch: async (owner, repo, branch) => {
			deleted = [owner, repo, branch];
		}
	});

	const settled = captureVerdict();
	const { result, verdict } = await withImmediateTimeouts(async () => {
		const result = await invoke(commands.submitEncoding, { task_id: 'T0001' }, context(forge));
		return { result, verdict: await settled };
	});

	assert.equal(result.ok, true);
	assert.equal(pullHead, 'volunteer:encode-T0001');
	assert.equal(verdict.state, 'accepted');
	assert.deepEqual(deleted, ['volunteer', 'campaign', 'encode-T0001']);
});

test('a poll failure settles a background submission as timeout, not rejection', async (t) => {
	offline(t);
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoHead: async () => ({ branch: 'main', sha: 'base-sha', treeSha: 'base-sha-tree', canPush: false }),
		ensureFork: async () => ({ owner: 'volunteer', repo: 'campaign' }),
		getRepoFile: async (_owner, _repo, path) => encodingFiles[path] ?? null,
		createPullRequest: async () => ({ number: 16, html_url: 'https://example.test/pr/16' }),
		getPullRequestState: async () => {
			throw new Error('network down');
		}
	});

	const settled = captureVerdict();
	const { result, verdict } = await withImmediateTimeouts(async () => {
		const result = await invoke(commands.submitEncoding, { task_id: 'T0001' }, context(forge));
		return { result, verdict: await settled };
	});

	assert.equal(result.ok, true);
	assert.equal(verdict.state, 'timeout');
	assert.match(verdict.message, /still being processed/);
});

test('a poll failure leaves a claim as still-processing, not rejected', async () => {
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoFile: async () => lockHeader,
		openChangePr: async () => ({
			number: 17,
			html_url: 'https://example.test/pr/17',
			head: { owner: 'volunteer', repo: 'campaign', branch: 'claim-P0001-abcd' }
		}),
		getPullRequestState: async () => {
			throw new Error('network down');
		}
	});

	const result = await withImmediateTimeouts(() =>
		invoke(commands.claimTask, { task_id: 'P0001' }, context(forge))
	);

	assert.equal(result.error, undefined);
	assert.equal(result.ok, true);
	assert.equal(result.warn, true);
	assert.match(result.message ?? '', /still being processed/);
});

test('resolving a comment flips its replies in the PR payload too', async () => {
	const commentCsv =
		'comment_id,task_id,subtask_id,kind,page,measure_start,measure_end,author_id,timestamp,resolved,parent_id,body\n' +
		'c1,T0001,,question,,,,9001,t1,,,Answered?\n' +
		'c2,T0001,,reply,,,,7,t2,,c1,Yes\n' +
		'c3,T0001,,question,,,,9001,t3,,,Other thread\n';
	let serialized = '';
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoFile: async () => commentCsv,
		openChangePr: async (_owner, _repo, options) => {
			serialized = options.files[0].content ?? '';
			return {
				number: 18,
				html_url: 'https://example.test/pr/18',
				head: { owner: 'campaign-owner', repo: 'campaign', branch: 'resolve-c1-abcd' }
			};
		},
		getPullRequestState: async () => 'closed',
		getLastIssueComment: async () => '✅ Comment resolved.'
	});

	const settled = captureVerdict();
	const { result } = await withImmediateTimeouts(async () => {
		const result = await invoke(commands.resolveComment, { comment_id: 'c1' }, context(forge));
		return { result, verdict: await settled };
	});

	assert.equal(result.ok, true);
	assert.match(serialized, /c1,T0001,,question,,,,9001,t1,true,,Answered\?/);
	assert.match(serialized, /c2,T0001,,reply,,,,7,t2,true,c1,Yes/);
	assert.match(serialized, /c3,T0001,,question,,,,9001,t3,,,Other thread/);
});

test('a rejected volunteer encoding keeps its fork branch for correction', async (t) => {
	offline(t);
	let deleted = false;
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoHead: async () => ({ branch: 'main', sha: 'base-sha', treeSha: 'base-sha-tree', canPush: false }),
		ensureFork: async () => ({ owner: 'volunteer', repo: 'campaign' }),
		getRepoFile: async (_owner, _repo, path) => encodingFiles[path] ?? null,
		createPullRequest: async () => ({ number: 15, html_url: 'https://example.test/pr/15' }),
		getPullRequestState: async () => 'closed',
		getLastIssueComment: async () => '❌ Submission rejected: `invalid_mei`.',
		deleteBranch: async () => {
			deleted = true;
		}
	});

	const settled = captureVerdict();
	const { result, verdict } = await withImmediateTimeouts(async () => {
		const result = await invoke(commands.submitEncoding, { task_id: 'T0001' }, context(forge));
		return { result, verdict: await settled };
	});

	assert.equal(result.ok, true);
	assert.equal(verdict.state, 'rejected');
	assert.match(verdict.message, /invalid_mei/);
	assert.equal(deleted, false);
});
