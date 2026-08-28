// Background verdicts for PR commands that return before the campaign
// automation has processed their PR. Each optimistic command registers an
// entry when its PR opens; the entry settles when the automation's verdict
// lands. The entries render task-anchored (TaskRunState.svelte); rejections
// additionally take the viewport over (PendingVerdicts.svelte, in the
// layout); pages hook their table refresh into onSettled. Loading this module
// plugs the store into the command layer's verdict sink — commands.ts itself
// stays free of runes so the Node test runner can import it.

import { setVerdictSink } from './commands.ts';

export type PendingState = 'opening' | 'processing' | 'accepted' | 'rejected' | 'timeout';

export interface PendingVerdict {
	id: string;
	/** What was submitted, e.g. "Encoding of T0002". */
	label: string;
	/** 0 while the PR is still being opened in the background. */
	prNumber: number;
	prUrl: string;
	/** Structured id of the acted-on target (e.g. "validate:T0002/S0001"); '' when untyped. */
	key: string;
	/** The campaign repo the submission acts on; 0 when unknown. */
	repoId: number;
	state: PendingState;
	/** The verdict or error text once settled; '' while processing. */
	message: string;
}

/** How long an accepted entry stays visible before it removes itself. */
const ACCEPTED_LINGER_MS = 6_000;

/** How long a task stays highlighted on the board after an accepted submission. */
const FINISHED_HIGHLIGHT_MS = 60_000;

/** The task id a structured key acts on: "validate:T0002/S0001" → "T0002". */
const taskOf = (key: string): string => {
	const rest = key.slice(key.indexOf(':') + 1);
	return key.includes(':') ? rest.split('/', 1)[0] : '';
};

/** Submission kinds that finish work on a task, as the board understands it. */
const FINISH_KINDS = new Set(['encode', 'validate', 'sendback']);

class PendingVerdictStore {
	entries = $state<PendingVerdict[]>([]);
	/** Tasks an accepted encoding, validation or send-back of the viewer's just
	 * moved on the board, per repo — each highlighted for a short while. Raw
	 * state: the expiry timeout removes its mark by identity, which the deep
	 * proxy of plain $state would break. */
	recentlyFinished = $state.raw<{ repoId: number; task: string }[]>([]);
	/** Called on every settle; pages hook their table refresh here. */
	private settledListeners = new Set<() => void>();

	/** Register a settle listener. Returns the unsubscribe. */
	onSettled(listener: () => void): () => void {
		this.settledListeners.add(listener);
		return () => {
			this.settledListeners.delete(listener);
		};
	}

	begin(entry: {
		label: string;
		prNumber: number;
		prUrl: string;
		key?: string;
		repoId?: number;
		state?: 'opening' | 'processing';
	}): string {
		const id = crypto.randomUUID().slice(0, 8);
		this.entries = [
			...this.entries,
			{
				...entry,
				key: entry.key ?? '',
				repoId: entry.repoId ?? 0,
				id,
				state: entry.state ?? 'processing',
				message: ''
			}
		];
		return id;
	}

	/** The background-opened PR exists now; the entry moves to 'processing'. */
	attachPr(id: string, prNumber: number, prUrl: string): void {
		this.entries = this.entries.map((e) =>
			e.id === id ? { ...e, prNumber, prUrl, state: 'processing' as const } : e
		);
	}

	/** The entry acting on `taskId` — processing first, else the latest
	 * settled one still on screen; null when the task has none. Drives the
	 * task-anchored run state (TaskRunState.svelte). */
	forTask(taskId: string): PendingVerdict | null {
		if (!taskId) return null;
		const mine = this.entries.filter((e) => taskOf(e.key) === taskId);
		return (
			mine.find((e) => e.state === 'opening' || e.state === 'processing') ??
			mine[mine.length - 1] ??
			null
		);
	}

	/** Whether a submission for `key` is still being processed — its controls
	 * should hold until the verdict lands (a repeat would only be rejected). */
	isProcessing(key: string): boolean {
		return this.entries.some(
			(e) => e.key === key && (e.state === 'processing' || e.state === 'opening')
		);
	}

	settle(id: string, state: Exclude<PendingState, 'opening' | 'processing'>, message: string): void {
		this.entries = this.entries.map((e) => (e.id === id ? { ...e, state, message } : e));
		if (state === 'accepted') {
			const entry = this.entries.find((e) => e.id === id);
			if (entry && entry.repoId && FINISH_KINDS.has(entry.key.split(':', 1)[0])) {
				const mark = { repoId: entry.repoId, task: taskOf(entry.key) };
				this.recentlyFinished = [...this.recentlyFinished, mark];
				setTimeout(() => {
					this.recentlyFinished = this.recentlyFinished.filter((m) => m !== mark);
				}, FINISHED_HIGHLIGHT_MS);
			}
		}
		for (const listener of this.settledListeners) listener();
		if (state === 'accepted') setTimeout(() => this.dismiss(id), ACCEPTED_LINGER_MS);
	}

	dismiss(id: string): void {
		this.entries = this.entries.filter((e) => e.id !== id);
	}
}

export const pendingVerdicts = new PendingVerdictStore();
setVerdictSink(pendingVerdicts);
