// Where the campaign view's dock panels sit and how large they are. Like the
// pane choice (preview-pane.ts) this is a viewing preference, kept per
// browser. There are two panels — the score preview and the task panel — and
// each remembers its own edge and size. A bottom dock is sized by height, a
// side dock by width.

/** The dock panels the campaign view has. */
export type DockId = 'preview' | 'task';

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
	preview: 'lets-encode:preview-dock',
	task: 'lets-encode:task-dock'
};

export const DOCK_MIN = 260;

const DEFAULTS: Record<DockId, DockLayout> = {
	preview: { side: 'bottom', height: 440, width: 640 },
	task: { side: 'right', height: 360, width: 400 }
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
