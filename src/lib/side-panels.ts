// The campaign view's in-page side panels (the comments panel and the task
// panel): whether one is open and how wide it is, kept per browser like the
// dock layouts (preview-dock.ts). The task panel's open state follows the
// ?task= parameter, so only its width applies.

export type SidePanelId = 'comments' | 'task';

export interface SidePanelState {
	open: boolean;
	width: number;
}

const KEYS: Record<SidePanelId, string> = {
	comments: 'lets-encode:comments-panel',
	task: 'lets-encode:task-panel'
};

export const PANEL_MIN = 240;

const DEFAULTS: Record<SidePanelId, SidePanelState> = {
	comments: { open: true, width: 300 },
	task: { open: true, width: 310 }
};

// Storage is read through this so the module can be used where there is none.
const store = () => (typeof localStorage === 'undefined' ? null : localStorage);

const width = (v: unknown, fallback: number): number =>
	typeof v === 'number' && Number.isFinite(v) && v >= PANEL_MIN ? Math.round(v) : fallback;

/** The stored panel state, or its default where nothing valid is stored. */
export function readSidePanel(id: SidePanelId): SidePanelState {
	try {
		const raw = store()?.getItem(KEYS[id]);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		const p = (parsed ?? {}) as Record<string, unknown>;
		return {
			open: typeof p.open === 'boolean' ? p.open : DEFAULTS[id].open,
			width: width(p.width, DEFAULTS[id].width)
		};
	} catch {
		return { ...DEFAULTS[id] };
	}
}

/** Store a panel's state. A browser refusing the write leaves it unstored. */
export function writeSidePanel(id: SidePanelId, state: SidePanelState): void {
	try {
		store()?.setItem(KEYS[id], JSON.stringify(state));
	} catch {
		/* full or blocked storage only costs the preference */
	}
}

/** A dragged panel width, kept between the minimum and half the viewport. */
export function clampPanelWidth(w: number, viewport: number): number {
	return Math.round(Math.min(Math.max(w, PANEL_MIN), Math.max(PANEL_MIN, viewport / 2)));
}
