// The layout model's raw output for a layout task, kept per browser so that
// leaving the zone editor before submitting does not require another model
// run. One record per campaign repo and task, holding each detected page's
// layout by image path, for one model version.

import type { OmrPipeline } from "./omr-client.ts";
import type { CocoLayout } from "./omr-layout.ts";

interface CachedLayouts {
  model: OmrPipeline;
  pages: Record<string, CocoLayout>;
}

// Storage is read through this so the module can be used where there is none.
const store = () => (typeof localStorage === "undefined" ? null : localStorage);

const key = (repoId: number, taskId: string) =>
  `lets-encode:omr-layout:${repoId}:${taskId}`;

/** The stored layouts by image path, or an empty map where none were stored by this model. */
export function readCachedLayouts(
  repoId: number,
  taskId: string,
  model: OmrPipeline,
): Record<string, CocoLayout> {
  try {
    const raw = store()?.getItem(key(repoId, taskId));
    const parsed = (raw ? JSON.parse(raw) : null) as CachedLayouts | null;
    if (
      parsed?.model?.name !== model.name ||
      parsed.model.version !== model.version
    )
      return {};
    return parsed.pages && typeof parsed.pages === "object" ? parsed.pages : {};
  } catch {
    return {};
  }
}

/** Store one page's layout beside the task's other stored pages. */
export function writeCachedLayout(
  repoId: number,
  taskId: string,
  model: OmrPipeline,
  image: string,
  layout: CocoLayout,
): void {
  const pages = {
    ...readCachedLayouts(repoId, taskId, model),
    [image]: layout,
  };
  try {
    store()?.setItem(key(repoId, taskId), JSON.stringify({ model, pages }));
  } catch {
    /* full or blocked storage only costs a later model run */
  }
}

export function clearCachedLayouts(repoId: number, taskId: string): void {
  try {
    store()?.removeItem(key(repoId, taskId));
  } catch {
    /* blocked storage holds nothing to clear */
  }
}
