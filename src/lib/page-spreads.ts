// Book-style spreads shared by the zone editor and the score preview: the
// pages scroll as rows of one or two pages. `firstOnRight` places page 1 as a
// right-hand page (recto), so a two-up view pairs 2|3, 4|5, … the way a score
// opens — the printed page number's side can't be read without OCR, so this
// convention (with a toggle) stands in for it.

/** One spread: the page indices it shows, and which half stays empty. */
export interface Spread {
  pages: number[];
  lonelySide?: "left" | "right";
}

/**
 * The view a freshly opened score starts in. A two-page score shows both
 * pages side by side; anything else opens one page at a time with page 1 as
 * a recto.
 */
export function defaultSpreadView(n: number): {
  view: "single" | "double";
  firstOnRight: boolean;
} {
  return n === 2
    ? { view: "double", firstOnRight: false }
    : { view: "single", firstOnRight: true };
}

/** Slice `n` pages into spreads for the given view. */
export function buildSpreads(
  n: number,
  view: "single" | "double",
  firstOnRight: boolean,
): Spread[] {
  const spreads: Spread[] = [];
  if (view === "single") {
    for (let i = 0; i < n; i++) spreads.push({ pages: [i] });
    return spreads;
  }
  let i = 0;
  if (firstOnRight && n > 0) {
    spreads.push({ pages: [0], lonelySide: "right" });
    i = 1;
  }
  for (; i < n; i += 2) {
    if (i + 1 < n) spreads.push({ pages: [i, i + 1] });
    else spreads.push({ pages: [i], lonelySide: "left" });
  }
  return spreads;
}

/** The toolbar's page label for the spreads in view, e.g. "Pages 2–3 of 6". */
export function shownPagesLabel(
  spreads: Spread[],
  rows: number[],
  total: number,
): string {
  const pages = rows.flatMap((r) => spreads[r]?.pages ?? []);
  const a = (pages.length ? Math.min(...pages) : 0) + 1;
  const b = (pages.length ? Math.max(...pages) : 0) + 1;
  return a === b ? `Page ${a} of ${total}` : `Pages ${a}–${b} of ${total}`;
}

/**
 * The page label's width in `ch`, fitting its longest form for `total` pages,
 * so the paging buttons beside it keep their place as the label changes.
 */
export function pagesLabelCh(total: number): number {
  return `Pages ${total}–${total} of ${total}`.length;
}
