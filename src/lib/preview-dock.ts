// The review view's rail: how wide it is, kept per browser. Like the pane
// choice (preview-pane.ts) this is a viewing preference. The rail is
// side-fixed, so only its width applies.

/** The stored panel layouts: the review view's rail. */
export type DockId = 'review';

/** The edge of the view a panel docks to. */
export type DockSide = 'left' | 'bottom' | 'right';

export interface DockLayout {
	side: DockSide;
	/** Panel height in px when docked at the bottom. */
	height: number;
	/** Panel width in px when docked at a side. */
	width: number;
}

const KEYS: Record<DockId, string> = {
	review: 'lets-encode:review-rail'
};

export const DOCK_MIN = 260;

const DEFAULTS: Record<DockId, DockLayout> = {
	review: { side: 'right', height: 360, width: 400 }
};

// Storage is read through this so the module can be used where there is none.
const store = () => (typeof localStorage === 'undefined' ? null : localStorage);

const isSide = (v: unknown): v is DockSide => v === 'left' || v === 'bottom' || v === 'right';

const size = (v: unknown, fallback: number): number =>
	typeof v === 'number' && Number.isFinite(v) && v >= DOCK_MIN ? Math.round(v) : fallback;

/** The stored layout of a panel, or its default where nothing valid is stored. */
export function readDockLayout(id: DockId): DockLayout {
	try {
		const raw = store()?.getItem(KEYS[id]);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		const p = (parsed ?? {}) as Record<string, unknown>;
		return {
			side: isSide(p.side) ? p.side : DEFAULTS[id].side,
			height: size(p.height, DEFAULTS[id].height),
			width: size(p.width, DEFAULTS[id].width)
		};
	} catch {
		return { ...DEFAULTS[id] };
	}
}

/** Store a panel's layout. A browser refusing the write leaves it unstored. */
export function writeDockLayout(id: DockId, layout: DockLayout): void {
	try {
		store()?.setItem(KEYS[id], JSON.stringify(layout));
	} catch {
		/* full or blocked storage only costs the preference */
	}
}
