import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_REQUIREMENTS } from '../commands.ts';

// The campaign repos' workflow runs on pull_request_target with a write token,
// so its safety rests on never executing anything from the fork: the PR head
// may be passed to the coordinator as data (env), but no step may check it out
// or expand it into a command. These checks pin that invariant, which the
// workflow otherwise states only in comments.
const workflow = readFileSync(
	fileURLToPath(new URL('../../../../user-repo-template/.github/workflows/caller.yml', import.meta.url)),
	'utf8'
);
const lines = workflow.split('\n');
const indentOf = (line: string) => line.length - line.trimStart().length;

// Lines inside an `env:` mapping (of any step), where PR head values may appear.
function isInEnv(index: number): boolean {
	for (let i = index - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.trim()) continue;
		if (indentOf(line) >= indentOf(lines[index])) continue;
		return /^\s*env:\s*$/.test(line);
	}
	return false;
}

// Each step's lines, split at the list items under `steps:`.
function steps(): string[][] {
	const out: string[][] = [];
	let current: string[] | null = null;
	for (const line of lines) {
		if (/^\s{6}- /.test(line)) {
			current = [line];
			out.push(current);
		} else if (current) current.push(line);
	}
	return out;
}

test('caller.yml runs on pull_request_target, so the invariant applies', () => {
	assert.match(workflow, /^\s*pull_request_target:/m);
});

test('the PR head is passed to the coordinator only as env data', () => {
	const offenders = lines
		.map((line, i) => ({ line, i }))
		.filter(({ line }) => /pull_request\.head|github\.head_ref|github\.event\.pull_request\.head/.test(line))
		.filter(({ i }) => !isInEnv(i))
		.map(({ line, i }) => `${i + 1}: ${line.trim()}`);
	assert.deepEqual(offenders, []);
});

test('no step checks out the fork', () => {
	for (const step of steps()) {
		if (!step.some((l) => /uses:\s*actions\/checkout/.test(l))) continue;
		const withBlock = step.filter((l) => /^\s*(ref|repository|token):/.test(l)).join('\n');
		assert.doesNotMatch(withBlock, /head|pull_request|fork/, `checkout reads the fork:\n${step.join('\n')}`);
	}
});

test('run steps do not expand PR head values into commands', () => {
	for (const step of steps()) {
		const runStart = step.findIndex((l) => /^\s*run:/.test(l));
		if (runStart < 0) continue;
		const runBlock = step.slice(runStart).join('\n');
		assert.doesNotMatch(runBlock, /\$\{\{[^}]*head\.(sha|ref|repo)/, `a run step expands the PR head:\n${runBlock}`);
	}
});

// The central pointer (repository, ref, entry point) is base-controlled data
// read from config.yaml. It reaches the checkout as action inputs and the run
// step as a quoted environment variable, never as an expansion inside a
// command line.
test('run steps do not expand the central pointer into commands', () => {
	for (const step of steps()) {
		const runStart = step.findIndex((l) => /^\s*run:/.test(l));
		if (runStart < 0) continue;
		const runBlock = step.slice(runStart).join('\n');
		assert.doesNotMatch(runBlock, /\$\{\{[^}]*steps\.cfg\.outputs/, `a run step expands the central pointer:\n${runBlock}`);
	}
});

test('the cfg step validates the pointer fields before exporting them', () => {
	const cfg = steps().find((s) => s.some((l) => /^\s*id:\s*cfg\s*$/.test(l)));
	assert.ok(cfg, 'no step with id cfg');
	const block = cfg!.join('\n');
	assert.match(block, /\[\[ "\$repo" =~ \^\[A-Za-z0-9_.-\]\+\/\[A-Za-z0-9_.-\]\+\$ \]\]/);
	assert.match(block, /"\$path" != "scripts\/coordinator\.ts"/);
});

// Each pull request queues its own runs; runs for different pull requests
// never wait on or cancel each other.
test('pull request runs get a concurrency group of their own', () => {
	const concurrency = /^concurrency:\n((?:[ ]+.*\n)+)/m.exec(workflow);
	assert.ok(concurrency, 'no concurrency block');
	assert.match(concurrency![1], /github\.event\.pull_request\.number/);
});

test('pull request runs are gated on the event payload before a runner is assigned', () => {
	const job = /^  run:\n((?:[ ]{4}.*\n)+?)[ ]{4}steps:/m.exec(workflow);
	assert.ok(job, 'no run job');
	const guard = job![1].split('\n').find((l) => /^\s*if:/.test(l)) ?? '';
	assert.match(guard, /pull_request\.changed_files <= 2/);
	assert.match(guard, /pull_request\.draft == false/);
	assert.match(guard, /pull_request\.user\.type == 'User'/);
	// The console names the same requirements when a run was skipped.
	assert.match(RUN_REQUIREMENTS, /two files/);
	assert.match(RUN_REQUIREMENTS, /draft/);
	assert.match(RUN_REQUIREMENTS, /user account/);
});

