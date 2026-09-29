// A scrolling list of page rows, one row per spread, shared by the zone editor
// and the score preview: which rows the view shows, scrolling to a row, and
// returning to a remembered position after the rows change size.

/** Each row's top and height in the scroller's content coordinates. */
function rowBoxes(
  scroller: HTMLElement,
  rows: HTMLElement[],
): { top: number; h: number }[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  return rows.map((row) => {
    const b = row.getBoundingClientRect();
    return { top: b.top - base, h: b.height };
  });
}

/** What the view shows of its rows. */
export interface RowView {
  /** The row being read: the first one reaching below a third of the view. */
  current: number;
  /** Rows that fill at least half the view or show at least half their height. */
  shown: number[];
  /** Rows within one view height of the visible area. */
  near: number[];
  atTop: boolean;
  atEnd: boolean;
}

export function rowView(scroller: HTMLElement, rows: HTMLElement[]): RowView {
  const top = scroller.scrollTop;
  const h = scroller.clientHeight;
  const boxes = rowBoxes(scroller, rows);
  const current = boxes.findIndex((b) => b.top + b.h > top + h / 3);
  const shown: number[] = [];
  const near: number[] = [];
  boxes.forEach((b, i) => {
    const seen = Math.min(b.top + b.h, top + h) - Math.max(b.top, top);
    if (seen > 0 && seen >= Math.min(b.h, h) / 2) shown.push(i);
    if (b.top < top + 2 * h && b.top + b.h > top - h) near.push(i);
  });
  return {
    current: current < 0 ? rows.length - 1 : current,
    shown,
    near,
    atTop: top <= 1,
    atEnd: top + h >= scroller.scrollHeight - 1,
  };
}

/** The scroller's top padding: a row scrolled to the top sits below it. */
function padTop(scroller: HTMLElement): number {
  return parseFloat(getComputedStyle(scroller).paddingTop) || 0;
}

/** Scroll a row's top to the top of the view, below the scroller's padding. */
export function scrollToRow(
  scroller: HTMLElement,
  rows: HTMLElement[],
  row: number,
) {
  const b = rowBoxes(scroller, rows)[row];
  if (!b) return;
  scroller.scrollTop = b.top - padTop(scroller);
}

/**
 * A scroll position that survives the rows changing size: the row at the top
 * edge (below the scroller's padding), how far down it the edge is (a share
 * of its height), and the horizontal centre as a share of the content width.
 */
export interface ScrollAnchor {
  row: number;
  frac: number;
  x?: number;
}

export function readAnchor(
  scroller: HTMLElement,
  rows: HTMLElement[],
): ScrollAnchor | null {
  const boxes = rowBoxes(scroller, rows);
  if (!boxes.length) return null;
  const top = scroller.scrollTop + padTop(scroller);
  let row = boxes.findIndex((b) => b.top + b.h > top);
  if (row < 0) row = boxes.length - 1;
  const b = boxes[row];
  return {
    row,
    frac: b.h ? Math.max(-1, Math.min(1, (top - b.top) / b.h)) : 0,
    x: (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth,
  };
}

/** Scroll back to an anchor; the horizontal position only when it has one. */
export function applyAnchor(
  scroller: HTMLElement,
  rows: HTMLElement[],
  a: ScrollAnchor,
) {
  const b = rowBoxes(scroller, rows)[a.row];
  if (!b) return;
  scroller.scrollTop = b.top + a.frac * b.h - padTop(scroller);
  if (a.x !== undefined)
    scroller.scrollLeft = a.x * scroller.scrollWidth - scroller.clientWidth / 2;
}
