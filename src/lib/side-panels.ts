// The campaign view's in-page side panels (the comments panel and the task
// panel): whether one is open and how wide it is, kept per browser like the
// dock layouts (preview-dock.ts). The task panel's open state follows the
// ?task= parameter, so only its width applies. The width is ONE value shared
// by both panels — they occupy the same place in the layout, and a differing
// width would shift the centred board when one replaces the other.

export type SidePanelId = 'comments' | 'task';

export interface SidePanelState {
	open: boolean;
	width: number;
}

const KEYS: Record<SidePanelId, string> = {
	comments: 'lets-encode:comments-panel',
	task: 'lets-encode:task-panel'
};

// The shared width; the per-panel keys keep their {open, width} shape, whose
// width serves as the fallback where the shared key is not yet stored.
const WIDTH_KEY = 'lets-encode:side-panel-width';

export const PANEL_MIN = 240;
const DEFAULT_WIDTH = 300;

const DEFAULT_OPEN: Record<SidePanelId, boolean> = {
	comments: true,
	task: true
};

// Storage is read through this so the module can be used where there is none.
const store = () => (typeof localStorage === 'undefined' ? null : localStorage);

const width = (v: unknown, fallback: number): number =>
	typeof v === 'number' && Number.isFinite(v) && v >= PANEL_MIN ? Math.round(v) : fallback;

// The panel key's stored {open, width}, or {} where nothing valid is stored.
function readPanelKey(id: SidePanelId): Record<string, unknown> {
	try {
		const raw = store()?.getItem(KEYS[id]);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		return (parsed ?? {}) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** The stored panel state, or its default where nothing valid is stored. */
export function readSidePanel(id: SidePanelId): SidePanelState {
	const p = readPanelKey(id);
	let shared: unknown = null;
	try {
		const raw = store()?.getItem(WIDTH_KEY);
		shared = raw ? JSON.parse(raw) : null;
	} catch {
		/* an unreadable width falls back to the panel's own */
	}
	return {
		open: typeof p.open === 'boolean' ? p.open : DEFAULT_OPEN[id],
		width: width(shared, width(p.width, DEFAULT_WIDTH))
	};
}

/** Store a panel's state. A browser refusing the write leaves it unstored. */
export function writeSidePanel(id: SidePanelId, state: SidePanelState): void {
	try {
		store()?.setItem(KEYS[id], JSON.stringify(state));
		store()?.setItem(WIDTH_KEY, JSON.stringify(state.width));
	} catch {
		/* full or blocked storage only costs the preference */
	}
}

// The task the panel showed last, kept per campaign so the board reopens it.
const lastTaskKey = (campaign: string) => `lets-encode:last-task:${campaign}`;

/** The task the panel showed last in this campaign, or null. */
export function readLastTask(campaign: string): string | null {
	try {
		return store()?.getItem(lastTaskKey(campaign)) ?? null;
	} catch {
		return null;
	}
}

/** Store the task the panel shows; null clears it. */
export function writeLastTask(campaign: string, task: string | null): void {
	try {
		if (task === null) store()?.removeItem(lastTaskKey(campaign));
		else store()?.setItem(lastTaskKey(campaign), task);
	} catch {
		/* full or blocked storage only costs the preference */
	}
}

/** A dragged panel width, kept between the minimum and half the viewport. */
export function clampPanelWidth(w: number, viewport: number): number {
	return Math.round(Math.min(Math.max(w, PANEL_MIN), Math.max(PANEL_MIN, viewport / 2)));
}
