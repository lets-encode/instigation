// Book-style paging shared by the zone editor and the score preview: show one
// spread (one or two pages) at a time. `firstOnRight` places page 1 as a
// right-hand page (recto), so a two-up view pairs 2|3, 4|5, … the way a score
// opens — the printed page number's side can't be read without OCR, so this
// convention (with a toggle) stands in for it.

/** One spread: the page indices it shows, and which half stays empty. */
export interface Spread {
	pages: number[];
	lonelySide?: 'left' | 'right';
}

/**
 * The view a freshly opened score starts in. A two-page score shows both
 * pages side by side; anything else opens one page at a time with page 1 as
 * a recto.
 */
export function defaultSpreadView(n: number): {
	view: 'single' | 'double';
	firstOnRight: boolean;
} {
	return n === 2 ? { view: 'double', firstOnRight: false } : { view: 'single', firstOnRight: true };
}

/** Slice `n` pages into spreads for the given view. */
export function buildSpreads(
	n: number,
	view: 'single' | 'double',
	firstOnRight: boolean
): Spread[] {
	const spreads: Spread[] = [];
	if (view === 'single') {
		for (let i = 0; i < n; i++) spreads.push({ pages: [i] });
		return spreads;
	}
	let i = 0;
	if (firstOnRight && n > 0) {
		spreads.push({ pages: [0], lonelySide: 'right' });
		i = 1;
	}
	for (; i < n; i += 2) {
		if (i + 1 < n) spreads.push({ pages: [i, i + 1] });
		else spreads.push({ pages: [i], lonelySide: 'left' });
	}
	return spreads;
}
