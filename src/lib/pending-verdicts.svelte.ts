// Background verdicts for PR commands that return before the campaign
// automation has processed their PR. Each optimistic command registers an
// entry when its PR opens; the entry settles when the automation's verdict
// lands. Pages render the entries (PendingVerdicts.svelte) and hook their
// table refresh into onSettled. Loading this module plugs the store into the
// command layer's verdict sink — commands.ts itself stays free of runes so
// the Node test runner can import it.

import { setVerdictSink } from './commands.ts';

export type PendingState = 'processing' | 'accepted' | 'rejected' | 'timeout';

export interface PendingVerdict {
	id: string;
	/** What was submitted, e.g. "Encoding of T0002". */
	label: string;
	prNumber: number;
	prUrl: string;
	state: PendingState;
	/** The verdict or error text once settled; '' while processing. */
	message: string;
}

/** How long an accepted entry stays visible before it removes itself. */
const ACCEPTED_LINGER_MS = 6_000;

class PendingVerdictStore {
	entries = $state<PendingVerdict[]>([]);
	/** Called on every settle; the active page hooks its table refresh here. */
	onSettled: (() => void) | null = null;

	begin(entry: { label: string; prNumber: number; prUrl: string }): string {
		const id = crypto.randomUUID().slice(0, 8);
		this.entries = [...this.entries, { id, ...entry, state: 'processing', message: '' }];
		return id;
	}

	settle(id: string, state: Exclude<PendingState, 'processing'>, message: string): void {
		this.entries = this.entries.map((e) => (e.id === id ? { ...e, state, message } : e));
		this.onSettled?.();
		if (state === 'accepted') setTimeout(() => this.dismiss(id), ACCEPTED_LINGER_MS);
	}

	dismiss(id: string): void {
		this.entries = this.entries.filter((e) => e.id !== id);
	}
}

export const pendingVerdicts = new PendingVerdictStore();
setVerdictSink(pendingVerdicts);
