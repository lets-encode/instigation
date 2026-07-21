import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commands, invoke, type CommandContext } from '../commands.ts';
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

test('readTables decodes generated quoted config values', async () => {
	const files: Record<string, string> = {
		'tracking/task.csv':
			'task_id,subtask_id,fragment,locator,allowlist,blocklist,depends_on\nT0001,,sources/score.mei,,,,\n',
		'tracking/state.csv':
			'task_id,subtask_id,status,encoder,encoded_at,validate_status_1\nT0001,,encoding_required,,,\n',
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

test('a volunteer encoding submission cleans the encode branch in their fork', async () => {
	let pullHead = '';
	let deleted: string[] = [];
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoHead: async () => ({ branch: 'main', sha: 'base-sha', canPush: false }),
		ensureFork: async () => ({ owner: 'volunteer', repo: 'campaign' }),
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

	const result = await withImmediateTimeouts(() =>
		invoke(commands.submitEncoding, { task_id: 'T0001' }, context(forge))
	);

	assert.equal(result.ok, true);
	assert.equal(pullHead, 'volunteer:encode-T0001');
	assert.deepEqual(deleted, ['volunteer', 'campaign', 'encode-T0001']);
});

test('a rejected volunteer encoding keeps its fork branch for correction', async () => {
	let deleted = false;
	const forge = fakeForge({
		getRepoSubscription: async () => ({ subscribed: false, ignored: true }),
		getRepoHead: async () => ({ branch: 'main', sha: 'base-sha', canPush: false }),
		ensureFork: async () => ({ owner: 'volunteer', repo: 'campaign' }),
		createPullRequest: async () => ({ number: 15, html_url: 'https://example.test/pr/15' }),
		getPullRequestState: async () => 'closed',
		getLastIssueComment: async () => '❌ Submission rejected: `invalid_mei`.',
		deleteBranch: async () => {
			deleted = true;
		}
	});

	const result = await withImmediateTimeouts(() =>
		invoke(commands.submitEncoding, { task_id: 'T0001' }, context(forge))
	);

	assert.match(result.error ?? '', /invalid_mei/);
	assert.equal(deleted, false);
});
