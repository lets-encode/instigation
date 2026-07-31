// The steps a long-running action has worked through, each timed.
//
// An action that takes tens of seconds — rasterising a PDF, detecting measures
// on every page, committing a campaign — reports which unit of work it is on
// and how long each one took, rather than only that it is busy. A step stays in
// the list once it finishes, so the whole run can be read afterwards, including
// where it stopped when it failed.

/** One unit of work: what it was, when it ran, and how it ended. */
export interface ProgressStep {
	label: string;
	/** The part of this step being worked on now, e.g. `page 3 of 12`. */
	detail: string;
	/** From performance.now(), so the times are monotonic. */
	startedAt: number;
	/** Unset while the step is still running. */
	endedAt?: number;
	/** False for a step whose duration says nothing, so it is not reported. */
	timed: boolean;
	/**
	 * A duration the action measured itself, reported instead of how long the
	 * step was open. For work that runs in parallel with other work, the time
	 * spent waiting on it says nothing about the work itself.
	 */
	tookMs?: number;
	/** Set on the step an action stopped in. */
	failed: boolean;
}

export class ProgressLog {
	steps = $state<ProgressStep[]>([]);

	/** True while a step is open, which is what an action being under way means. */
	get running(): boolean {
		const step = this.steps.at(-1);
		return step !== undefined && step.endedAt === undefined;
	}

	/**
	 * Close the step that was running and open one for `label`. Pass
	 * `{ timed: false }` for work fast enough that its duration is noise.
	 */
	step(label: string, options: { timed?: boolean } = {}) {
		this.stop();
		this.steps.push({
			label,
			detail: '',
			startedAt: performance.now(),
			timed: options.timed ?? true,
			failed: false
		});
	}

	/** Say which part of the running step is being worked on. */
	detail(detail: string) {
		const step = this.steps.at(-1);
		if (step && step.endedAt === undefined) step.detail = detail;
	}

	/**
	 * Close the running step: the action got through it. Pass `tookMs` to
	 * report a duration the action measured itself instead of how long the
	 * step was open.
	 */
	done(tookMs?: number) {
		const step = this.steps.at(-1);
		if (step && step.endedAt === undefined && tookMs !== undefined) step.tookMs = tookMs;
		this.stop();
	}

	/** Close the running step, marking it as where the action stopped. */
	fail() {
		const step = this.steps.at(-1);
		if (step && step.endedAt === undefined) {
			step.failed = true;
			step.endedAt = performance.now();
		}
	}

	/** Empty the list, for an action being started again. */
	clear() {
		this.steps = [];
	}

	private stop() {
		const step = this.steps.at(-1);
		if (step && step.endedAt === undefined) step.endedAt = performance.now();
	}
}
