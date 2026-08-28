// Shared plumbing for pages that run campaign commands: the signed-in
// viewer's identity, the forge client fallback, and the busy/progress/result
// state every command runs behind. The pages keep their own refresh logic and
// pass it to `run` as the follow-up.

import { auth, forge } from './auth.svelte.ts';
import { createForge } from './forge/index.ts';
import type { ForgeClient } from './forge/index.ts';
import { ProgressLog } from './progress-log.svelte.ts';
import type { ProgressStep } from './progress-log.svelte.ts';
import type { CommandContext, Result } from './commands.ts';

/** The viewer's stable numeric account id, as the tables store it; '' when anonymous. */
export const viewerId = (): string => (auth.user?.id != null ? String(auth.user.id) : '');

/** The session's authenticated forge client, or an anonymous one. */
export const readForge = (): ForgeClient => forge() ?? createForge('');

/** One campaign repo as a command target. */
export interface CommandTarget {
	repoId: number;
	owner: string;
	repo: string;
}

/**
 * The busy flag, progress log and result banner behind a page's commands,
 * plus the run wrapper that maintains them around one command invocation.
 */
export class CommandRunner {
	busy = $state(false);
	/** True once the command has finished and the overlay waits to be dismissed. */
	held = $state(false);
	readonly log = new ProgressLog();
	result = $state<Result | null>(null);
	private release: (() => void) | null = null;
	/** The running command's id, from the `command` progress update. */
	private command = '';

	/** A CommandContext against `target`, its progress wired to the busy log. */
	context(f: ForgeClient, target: CommandTarget, opts: { meiFriendUrl?: string } = {}): CommandContext {
		return {
			forge: f,
			...target,
			viewer: viewerId(),
			viewerLogin: auth.user?.login ?? '',
			...opts,
			progress: (u) => {
				if (u.command) this.command = u.command;
				if (u.step) this.log.step(u.step);
				if (u.detail) this.log.detail(u.detail);
			}
		};
	}

	/**
	 * Run one command behind the busy overlay and keep its result for the
	 * banner. Once the command has finished, the overlay is held open with its
	 * step times until dismiss() — the overlay's Continue button. `after` runs
	 * after that press, while still busy — the page's refresh (or navigation)
	 * after a command lands.
	 */
	async run(command: () => Promise<Result>, after?: (result: Result) => Promise<void> | void): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.command = '';
		this.log.clear();
		try {
			const result = (this.result = await command());
			// A command that resolved to an error stopped in its open step; mark
			// it so the log shows where, rather than closing it as got-through.
			if (result?.error) this.log.fail();
			else this.log.done();
			this.logTiming(!result?.error);
			// A background command holds nobody: no overlay stop, no banner —
			// the task's run state carries on from here.
			if (!result?.background) {
				this.held = true;
				await new Promise<void>((resolve) => (this.release = resolve));
				this.release = null;
				this.held = false;
			}
			if (after) await after(result);
		} finally {
			this.log.done();
			this.held = false;
			this.busy = false;
		}
	}

	/** Close a finished command's overlay (its Continue button). */
	dismiss(): void {
		this.release?.();
	}

	// One machine-readable line per finished command, with the overlay's step
	// times, so the timings can be copied from the console or collected by
	// tooling. Durations mirror the overlay: a step's self-measured tookMs when
	// it reported one, otherwise how long the step was open.
	private logTiming(ok: boolean): void {
		const stepMs = (step: ProgressStep) => step.tookMs ?? (step.endedAt ?? step.startedAt) - step.startedAt;
		const seconds = (ms: number) => Math.round(ms / 100) / 10;
		console.info(
			'[overlay-timing] ' +
				JSON.stringify({
					command: this.command,
					steps: this.log.steps.map((step) => ({ label: step.label, s: seconds(stepMs(step)) })),
					total_s: seconds(this.log.steps.reduce((sum, step) => sum + stepMs(step), 0)),
					ok
				})
		);
	}
}
