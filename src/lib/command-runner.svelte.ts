// Shared plumbing for pages that run campaign commands: the signed-in
// viewer's identity, the forge client fallback, and the busy/progress/result
// state every command runs behind. The pages keep their own refresh logic and
// pass it to `run` as the follow-up.

import { auth, forge } from './auth.svelte.ts';
import { createForge } from './forge/index.ts';
import type { ForgeClient } from './forge/index.ts';
import { ProgressLog } from './progress-log.svelte.ts';
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
	readonly log = new ProgressLog();
	result = $state<Result | null>(null);

	/** A CommandContext against `target`, its progress wired to the busy log. */
	context(f: ForgeClient, target: CommandTarget, opts: { meiFriendUrl?: string } = {}): CommandContext {
		return {
			forge: f,
			...target,
			viewer: viewerId(),
			viewerLogin: auth.user?.login ?? '',
			...opts,
			progress: (u) => {
				if (u.step) this.log.step(u.step);
				if (u.detail) this.log.detail(u.detail);
			}
		};
	}

	/**
	 * Run one command behind the busy overlay and keep its result for the
	 * banner. `after` runs while still busy — the page's refresh (or
	 * navigation) after a command lands.
	 */
	async run(command: () => Promise<Result>, after?: (result: Result) => Promise<void> | void): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.log.clear();
		try {
			this.result = await command();
			if (after) await after(this.result);
		} finally {
			this.log.done();
			this.busy = false;
		}
	}
}
