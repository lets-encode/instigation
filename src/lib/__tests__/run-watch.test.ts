import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowRunWatch, type ProgressUpdate } from '../run-watch.ts';
import type { ForgeClient, WorkflowRunInfo, WorkflowJobInfo } from '../forge/types.ts';

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

const run = (overrides: Partial<WorkflowRunInfo>): WorkflowRunInfo => ({
	id: 7,
	status: 'queued',
	conclusion: null,
	created_at: new Date().toISOString(),
	html_url: 'https://example.test/run/7',
	...overrides
});

// Read through functions rather than directly: assert.equal's asserts-signature
// would otherwise pin `watch.state` to one union member across ticks.
const phaseOf = (w: WorkflowRunWatch): string => w.state.phase;
const conclusionOf = (w: WorkflowRunWatch): string | null | undefined =>
	w.state.phase === 'completed' ? w.state.run.conclusion : undefined;

const job = (stepName: string, stepStatus: string): WorkflowJobInfo => ({
	name: 'run',
	status: 'in_progress',
	conclusion: null,
	steps: [
		{ name: 'Set up job', status: 'completed', conclusion: 'success' },
		{ name: stepName, status: stepStatus, conclusion: null }
	]
});

test('narrates a run from search through steps to completion', async () => {
	const updates: ProgressUpdate[] = [];
	let listed: WorkflowRunInfo[] = [];
	let current = run({});
	let jobs: WorkflowJobInfo[] = [];
	const forge = fakeForge({
		listWorkflowRuns: async () => listed,
		getWorkflowRun: async () => current,
		getWorkflowRunJobs: async () => jobs
	});
	const watch = new WorkflowRunWatch(
		forge,
		'owner',
		'campaign',
		{ workflow: 'caller.yml', event: 'workflow_dispatch', since: Date.now() },
		(u) => updates.push(u)
	);

	await watch.tick(); // nothing dispatched has shown up yet
	assert.equal(phaseOf(watch), 'searching');
	assert.deepEqual(updates, [{ step: 'Waiting for the run to start on GitHub…' }]);

	await watch.tick(); // still searching: announced once, not repeated
	assert.equal(updates.length, 1);

	listed = [current]; // the run appears, still queued
	await watch.tick();
	assert.equal(phaseOf(watch), 'running');
	assert.deepEqual(updates.at(-1), { step: 'Waiting for a free GitHub runner…' });

	current = run({ status: 'in_progress' });
	jobs = [job('Run the central coordinator', 'in_progress')];
	await watch.tick();
	assert.deepEqual(updates.at(-1), { step: 'Run the central coordinator' });

	await watch.tick(); // same step: announced once, not repeated
	assert.equal(updates.length, 3);

	jobs = [job('Post Run actions/setup-node@abc123', 'in_progress')];
	await watch.tick(); // the runner's cleanup steps are not narrated
	assert.equal(updates.length, 3);

	current = run({ status: 'completed', conclusion: 'success' });
	await watch.tick();
	assert.equal(phaseOf(watch), 'completed');
	assert.equal(conclusionOf(watch), 'success');
});

test('ignores runs created before `since` (an older run of the same workflow)', async () => {
	const stale = run({ created_at: new Date(Date.now() - 600_000).toISOString() });
	const forge = fakeForge({ listWorkflowRuns: async () => [stale] });
	const watch = new WorkflowRunWatch(
		forge,
		'owner',
		'campaign',
		{ workflow: 'caller.yml', event: 'workflow_dispatch', since: Date.now() },
		() => {}
	);

	await watch.tick();
	assert.equal(phaseOf(watch), 'searching');
});

test('a run found already completed reports its conclusion without reading jobs', async () => {
	const failed = run({ status: 'completed', conclusion: 'failure' });
	const forge = fakeForge({ listWorkflowRuns: async () => [failed] });
	const watch = new WorkflowRunWatch(
		forge,
		'owner',
		'campaign',
		{ workflow: 'caller.yml', event: 'pull_request_target', headSha: 'abc123' },
		() => {}
	);

	await watch.tick();
	assert.equal(phaseOf(watch), 'completed');
	assert.equal(conclusionOf(watch), 'failure');
});
