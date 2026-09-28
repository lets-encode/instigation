// Rectangle geometry shared by the box editors (the zone editor and the
// wizard's piece regions): the pointer's position on a page, and the box a
// draw, move, resize or arrow-key nudge produces. Boxes are in the page
// image's pixel space and stay on the page. Pure functions.

export interface Box {
  ulx: number;
  uly: number;
  lrx: number;
  lry: number;
}

export interface PageSize {
  width: number;
  height: number;
}

/** Screen pixels the pointer must travel before a draw creates its box. */
export const DRAW_THRESHOLD_PX = 12;

/** The pointer's position on a page drawn at `rect`, in page pixels, clamped to the page. */
export function pagePoint(
  e: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  page: PageSize,
): { x: number; y: number } {
  return {
    x: Math.max(
      0,
      Math.min(page.width, ((e.clientX - rect.left) * page.width) / rect.width),
    ),
    y: Math.max(
      0,
      Math.min(
        page.height,
        ((e.clientY - rect.top) * page.height) / rect.height,
      ),
    ),
  };
}

/**
 * Whether a draw has travelled far enough to create its box. `dx`/`dy` are in
 * page pixels; `screenWidth` is the page's width on screen.
 */
export const drawStarted = (
  dx: number,
  dy: number,
  page: PageSize,
  screenWidth: number,
): boolean =>
  Math.hypot(dx, dy) >= DRAW_THRESHOLD_PX * (page.width / screenWidth);

/** The box spanning a draw's start point and the pointer, in any direction, at least `min` each way. */
export function drawnBox(
  sx: number,
  sy: number,
  x: number,
  y: number,
  min: number,
): Box {
  const ulx = Math.min(sx, x);
  const uly = Math.min(sy, y);
  return {
    ulx,
    uly,
    lrx: Math.max(sx, x, ulx + min),
    lry: Math.max(sy, y, uly + min),
  };
}

/** `orig` shifted by (dx, dy), kept whole on the page. */
export function movedBox(
  orig: Box,
  dx: number,
  dy: number,
  page: PageSize,
): Box {
  const w = orig.lrx - orig.ulx;
  const h = orig.lry - orig.uly;
  const ulx = Math.max(0, Math.min(page.width - w, orig.ulx + dx));
  const uly = Math.max(0, Math.min(page.height - h, orig.uly + dy));
  return { ulx, uly, lrx: ulx + w, lry: uly + h };
}

/**
 * `orig` with the grabbed `edges` — "n", "s", "e", "w" or a corner's pair
 * ("nw", "se", …) — at the pointer, never closer than `min` to the opposite
 * edge.
 */
export function resizedBox(
  orig: Box,
  edges: string,
  x: number,
  y: number,
  min: number,
): Box {
  return {
    ulx: edges.includes("w") ? Math.min(orig.lrx - min, x) : orig.ulx,
    lrx: edges.includes("e") ? Math.max(orig.ulx + min, x) : orig.lrx,
    uly: edges.includes("n") ? Math.min(orig.lry - min, y) : orig.uly,
    lry: edges.includes("s") ? Math.max(orig.uly + min, y) : orig.lry,
  };
}

/** `box` with its `edges` shifted by (dx, dy), on the page and never closer than `min` to the opposite edge. */
export function nudgedEdges(
  box: Box,
  edges: string,
  dx: number,
  dy: number,
  min: number,
  page: PageSize,
): Box {
  return {
    ulx: edges.includes("w")
      ? Math.max(0, Math.min(box.lrx - min, box.ulx + dx))
      : box.ulx,
    lrx: edges.includes("e")
      ? Math.min(page.width, Math.max(box.ulx + min, box.lrx + dx))
      : box.lrx,
    uly: edges.includes("n")
      ? Math.max(0, Math.min(box.lry - min, box.uly + dy))
      : box.uly,
    lry: edges.includes("s")
      ? Math.min(page.height, Math.max(box.uly + min, box.lry + dy))
      : box.lry,
  };
}

/** An arrow key's shift as (dx, dy), `step` pixels long; null for any other key. */
export function arrowShift(
  key: string,
  step: number,
): { dx: number; dy: number } | null {
  if (!key.startsWith("Arrow")) return null;
  return {
    dx: key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0,
    dy: key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0,
  };
}
