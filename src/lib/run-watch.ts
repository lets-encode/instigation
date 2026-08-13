// Follows one GitHub Actions workflow run and narrates it: first the search
// for the run an event triggered, then the wait for a runner while it is
// queued, then which job step it is on, using the workflow's own step names.
// The caller owns the polling cadence: each tick() reads at most two API
// endpoints (both ETag-cached, so unchanged polls are cheap) and reports what
// changed through the progress callback.

import type { ForgeClient, WorkflowRunInfo } from './forge/types.ts';

/**
 * One progress update: open a new step, and/or set the running step's detail.
 * `command` names the command whose steps follow, sent once when it starts.
 */
export type ProgressUpdate = { step?: string; detail?: string; command?: string };

/** Where the watched run stands after the latest tick. */
export type RunWatchState =
	| { phase: 'searching' }
	| { phase: 'running'; run: WorkflowRunInfo }
	| { phase: 'completed'; run: WorkflowRunInfo };

export class WorkflowRunWatch {
	state: RunWatchState = { phase: 'searching' };
	private lastAnnounced = '';

	constructor(
		private forge: ForgeClient,
		private owner: string,
		private repo: string,
		private opts: {
			/** The workflow filename whose runs are watched, e.g. `caller.yml`. */
			workflow: string;
			/** The trigger event the run must have, e.g. `workflow_dispatch`. */
			event: string;
			/** Narrow the search to runs of this head commit (PR-triggered runs). */
			headSha?: string;
			/** Only accept runs created at/after this time (ms epoch); 15s clock-skew slack. */
			since?: number;
		},
		private progress: (update: ProgressUpdate) => void
	) {}

	/**
	 * One poll: advance whatever the run has done since the last tick. Throws on
	 * an API failure — the caller decides whether that ends the command or only
	 * the watching.
	 */
	async tick(): Promise<void> {
		if (this.state.phase === 'completed') return;
		if (this.state.phase === 'searching') {
			const run = await this.find();
			if (!run) {
				this.announce({ step: 'Waiting for the run to start on GitHub…' });
				return;
			}
			this.state = { phase: 'running', run };
			console.log('[run-watch] following run', run.id, run.html_url);
		} else {
			const run = await this.forge.getWorkflowRun(this.owner, this.repo, this.state.run.id);
			this.state = { phase: 'running', run };
		}
		const { run } = this.state;
		if (run.status === 'completed') {
			this.state = { phase: 'completed', run };
			console.log('[run-watch] run', run.id, 'completed:', run.conclusion);
			return;
		}
		if (run.status === 'queued') {
			this.announce({ step: 'Waiting for a free GitHub runner…' });
			return;
		}
		if (run.status !== 'in_progress') {
			// waiting/pending: not queued for a runner, no jobs to read yet.
			this.announce({ detail: `run ${run.status} on GitHub` });
			return;
		}
		await this.announceCurrentStep(run.id);
	}

	private async find(): Promise<WorkflowRunInfo | null> {
		const runs = await this.forge.listWorkflowRuns(this.owner, this.repo, this.opts.workflow, {
			event: this.opts.event,
			headSha: this.opts.headSha
		});
		const { since } = this.opts;
		return runs.find((r) => since === undefined || Date.parse(r.created_at) >= since - 15_000) ?? null;
	}

	// Report the step the run is on, once per step. A step that starts and
	// finishes between two polls is skipped — this narrates, it does not audit.
	private async announceCurrentStep(runId: number): Promise<void> {
		const jobs = await this.forge.getWorkflowRunJobs(this.owner, this.repo, runId);
		for (const job of jobs) {
			if (job.status !== 'in_progress') continue;
			const step = job.steps.find((s) => s.status === 'in_progress');
			if (!step) continue;
			// The runner's own bookkeeping steps ("Post <step>" cleanup, "Complete
			// job") say nothing about the workflow's progress; the step before
			// them stays the one reported.
			if (step.name.startsWith('Post ') || step.name === 'Complete job') return;
			this.announce({ step: jobs.length > 1 ? `${job.name}: ${step.name}` : step.name });
			return;
		}
	}

	/** Pass one update through, skipping repeats of the last one. */
	private announce(update: ProgressUpdate): void {
		const label = update.step ?? update.detail ?? '';
		if (label === this.lastAnnounced) return;
		this.lastAnnounced = label;
		this.progress(update);
	}
}
