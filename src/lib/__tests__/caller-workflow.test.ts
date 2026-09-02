import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
