// The Musibot layout model's output (a COCO document, `layout.json`) turned
// into the boxes the zone editor works with: `systemMeasure` boxes become the
// measure zones, `staff` boxes the staff zones. Pure functions, no DOM.

import type { MeasureBox, ZoneModel } from './mei-facsimile.ts';
import type { OmrPipeline } from './omr-client.ts';

/** The parts of a COCO layout document that are read. */
export interface CocoLayout {
	categories?: { id: number; name: string }[];
	images?: { width: number; height: number }[];
	annotations?: { category_id: number; bbox: [number, number, number, number] }[];
}

/**
 * The layout model's raw output for a piece, committed as `layout.json` next
 * to the score. The corrected boxes are the zones in the score; this file
 * keeps what the model returned, per page, so it can be read again without
 * another model run.
 */
export interface LayoutRecord {
	model: OmrPipeline;
	/** Always false: the boxes in this file are not corrected. */
	corrected: false;
	note: string;
	/** One entry per page, `image` as the score's graphic target. */
	pages: { image: string; layout: CocoLayout }[];
}

export const LAYOUT_RECORD_NOTE =
	'Raw output of the layout model, not corrected. The corrected staff and measure boxes are the zones in score.mei.';

/** The record for the pages' raw layouts, as `layout.json` is written. */
export function layoutRecord(model: OmrPipeline, pages: { image: string; layout: CocoLayout }[]): LayoutRecord {
	return { model, corrected: false, note: LAYOUT_RECORD_NOTE, pages };
}

/** The boxes of one page, in the page image's pixel space, unsorted. */
export interface PageLayout {
	measures: MeasureBox[];
	staves: MeasureBox[];
	grandstaves: MeasureBox[];
}

/**
 * Parameters for the layout model. The model downscales the page to its
 * `image_size` (default 640) on the long edge before detecting. The default is
 * kept: at 1280 the staff boxes of a page fragment into overlapping halves
 * with low confidence and the measure count doubles.
 */
export const LAYOUT_PARAMETERS: Record<string, unknown> = {};

/**
 * The measure, staff and grand-staff boxes of a layout, scaled to `page`'s pixel size when
 * the document declares another image size, clamped to the page, rounded to
 * whole pixels. Boxes with no area after clamping are dropped.
 */
export function layoutBoxes(layout: CocoLayout, page: { width: number; height: number }): PageLayout {
	const names = new Map((layout.categories ?? []).map((c) => [c.id, c.name]));
	const declared = layout.images?.[0];
	const sx = declared?.width ? page.width / declared.width : 1;
	const sy = declared?.height ? page.height / declared.height : 1;
	const out: PageLayout = { measures: [], staves: [], grandstaves: [] };
	for (const a of layout.annotations ?? []) {
		const name = names.get(a.category_id);
		const target =
			name === 'systemMeasure'
				? out.measures
				: name === 'staff'
					? out.staves
					: name === 'grandstaff'
						? out.grandstaves
						: null;
		if (!target || !Array.isArray(a.bbox) || a.bbox.length !== 4) continue;
		const [x, y, w, h] = a.bbox;
		const box = {
			ulx: Math.max(0, Math.round(x * sx)),
			uly: Math.max(0, Math.round(y * sy)),
			lrx: Math.min(page.width, Math.round((x + w) * sx)),
			lry: Math.min(page.height, Math.round((y + h) * sy))
		};
		if (box.lrx > box.ulx && box.lry > box.uly) target.push(box);
	}
	return out;
}

/**
 * The margin around a staff box when it is cropped for the staff model, as a
 * fraction of the staff's height on every side: the framing the model's
 * training crops had.
 */
export const STAFF_CROP_MARGIN = 0.9;

/** The crop rectangle for each staff box: the box grown by the margin, clamped to the page. */
export function staffCrops(
	staves: MeasureBox[],
	page: { width: number; height: number },
	margin = STAFF_CROP_MARGIN
): MeasureBox[] {
	return staves.map((box) => {
		const pad = Math.round((box.lry - box.uly) * margin);
		return {
			ulx: Math.max(0, box.ulx - pad),
			uly: Math.max(0, box.uly - pad),
			lrx: Math.min(page.width, box.lrx + pad),
			lry: Math.min(page.height, box.lry + pad)
		};
	});
}

/**
 * A page's systems as its layout correction defines them: the measure zones in
 * order, a new system at each zone that starts a page or a system (`pb`/`sb`),
 * each system with the staff boxes that overlap its measures' vertical extent
 * most, top to bottom. A system may hold fewer staves than another, or none.
 * `unplaced` counts the staff boxes that overlap no system.
 */
export function pageSystems<B extends MeasureBox>(page: { zones: ZoneModel[]; staves?: B[] }): {
	systems: B[][];
	unplaced: number;
} {
	const rows: { uly: number; lry: number }[] = [];
	for (const [i, zone] of page.zones.entries()) {
		const row = rows[rows.length - 1];
		if (i === 0 || zone.pb || zone.sb) rows.push({ uly: zone.box.uly, lry: zone.box.lry });
		else {
			row.uly = Math.min(row.uly, zone.box.uly);
			row.lry = Math.max(row.lry, zone.box.lry);
		}
	}
	const systems: B[][] = rows.map(() => []);
	let unplaced = 0;
	for (const staff of page.staves ?? []) {
		let best = -1;
		let bestOverlap = 0;
		for (const [r, row] of rows.entries()) {
			const overlap = Math.min(staff.lry, row.lry) - Math.max(staff.uly, row.uly);
			if (overlap > bestOverlap) {
				best = r;
				bestOverlap = overlap;
			}
		}
		if (best < 0) unplaced++;
		else systems[best].push(staff);
	}
	for (const system of systems) system.sort((a, b) => a.uly - b.uly || a.ulx - b.ulx);
	return { systems, unplaced };
}

/**
 * The staff count of the piece: the most staves any system of the corrected
 * layout holds, or 1 when no system holds a staff. A system that shows fewer
 * staves omits some of the piece's.
 */
export function staffCountOf(pages: { zones: ZoneModel[]; staves?: MeasureBox[] }[]): number {
	return Math.max(1, ...pages.flatMap((page) => pageSystems(page).systems.map((s) => s.length)));
}
