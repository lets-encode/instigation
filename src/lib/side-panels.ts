// The side panel of the campaign views (SidePanel.svelte): its width when it
// sits beside the content and its height when it is docked below it, kept
// per browser.

export interface SidePanelState {
  width: number;
  height: number;
}

const WIDTH_KEY = "lets-encode:side-panel-width";
const HEIGHT_KEY = "lets-encode:side-panel-height";

/** Where the panel docks below the content instead of beside it: portrait
    screens up to tablet width. ui.css stacks `.sidehost` rows on the same
    query. */
export const DOCKED_QUERY = "(orientation: portrait) and (max-width: 900px)";

export const PANEL_MIN = 280;
export const DEFAULT_PANEL_WIDTH = 480;
/** Below this docked height the panel shows only its task box. */
export const PANEL_LOWERED = 200;

// Storage is read through this so the module can be used where there is none.
const store = () => (typeof localStorage === "undefined" ? null : localStorage);

function readNumber(key: string): unknown {
  try {
    const raw = store()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** The default docked height: 40% of the viewport. */
export const defaultPanelHeight = (viewport: number): number =>
  Math.round(viewport * 0.4);

/** The stored panel state, or its defaults where nothing valid is stored. */
export function readSidePanel(): SidePanelState {
  const w = readNumber(WIDTH_KEY);
  const h = readNumber(HEIGHT_KEY);
  const viewport = typeof window === "undefined" ? 800 : window.innerHeight;
  return {
    width: finite(w) && w >= PANEL_MIN ? Math.round(w) : DEFAULT_PANEL_WIDTH,
    height:
      finite(h) && h > 0
        ? clampPanelHeight(h, viewport)
        : defaultPanelHeight(viewport),
  };
}

/** Store the panel state. A browser refusing the write leaves it unstored. */
export function writeSidePanel(state: SidePanelState): void {
  try {
    store()?.setItem(WIDTH_KEY, JSON.stringify(state.width));
    store()?.setItem(HEIGHT_KEY, JSON.stringify(state.height));
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
  return Math.round(
    Math.min(Math.max(w, PANEL_MIN), Math.max(PANEL_MIN, viewport / 2)),
  );
}

/** A dragged docked height, kept between 120px and the viewport less 160px
    for the content above it. */
export function clampPanelHeight(h: number, viewport: number): number {
  return Math.round(Math.min(Math.max(h, 120), Math.max(120, viewport - 160)));
}
