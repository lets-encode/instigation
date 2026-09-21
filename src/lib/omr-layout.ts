// The Musibot layout model's output (a COCO document, `layout.json`) turned
// into the boxes the zone editor works with: `systemMeasure` boxes become the
// measure zones, `staff` boxes the staff zones. Pure functions, no DOM.

import type { MeasureBox } from './mei-facsimile.ts';
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
}

/**
 * Parameters for the layout model. The model downscales the page to its
 * `image_size` (default 640) on the long edge before detecting. The default is
 * kept: at 1280 the staff boxes of a page fragment into overlapping halves
 * with low confidence and the measure count doubles.
 */
export const LAYOUT_PARAMETERS: Record<string, unknown> = {};

/**
 * The measure and staff boxes of a layout, scaled to `page`'s pixel size when
 * the document declares another image size, clamped to the page, rounded to
 * whole pixels. Boxes with no area after clamping are dropped.
 */
export function layoutBoxes(layout: CocoLayout, page: { width: number; height: number }): PageLayout {
	const names = new Map((layout.categories ?? []).map((c) => [c.id, c.name]));
	const declared = layout.images?.[0];
	const sx = declared?.width ? page.width / declared.width : 1;
	const sy = declared?.height ? page.height / declared.height : 1;
	const out: PageLayout = { measures: [], staves: [] };
	for (const a of layout.annotations ?? []) {
		const name = names.get(a.category_id);
		const target = name === 'systemMeasure' ? out.measures : name === 'staff' ? out.staves : null;
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
 * A page's staves grouped by system, top to bottom and each system's staves
 * top to bottom. Two staves belong to one system when a measure box spans
 * both: the staff's vertical centre lies inside the box. A staff no measure
 * spans joins the system of the nearest spanned staff. Without staves the
 * result is empty.
 */
export function stavesBySystem(measures: MeasureBox[], staves: MeasureBox[]): MeasureBox[][] {
	const sorted = [...staves].sort((a, b) => a.uly - b.uly || a.ulx - b.ulx);
	const centre = (b: MeasureBox) => (b.uly + b.lry) / 2;
	// Union-find over staff indices.
	const parent = sorted.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	const spanned = new Set<number>();
	for (const m of measures) {
		const inside = sorted.flatMap((s, i) => (centre(s) >= m.uly && centre(s) <= m.lry ? [i] : []));
		for (const i of inside) {
			spanned.add(i);
			parent[find(i)] = find(inside[0]);
		}
	}
	if (!spanned.size) return [];
	sorted.forEach((s, i) => {
		if (spanned.has(i)) return;
		let nearest = -1;
		for (const j of spanned) {
			if (nearest < 0 || Math.abs(centre(s) - centre(sorted[j])) < Math.abs(centre(s) - centre(sorted[nearest]))) nearest = j;
		}
		parent[find(i)] = find(nearest);
	});
	const systems = new Map<number, MeasureBox[]>();
	sorted.forEach((s, i) => {
		const root = find(i);
		if (!systems.has(root)) systems.set(root, []);
		systems.get(root)!.push(s);
	});
	return [...systems.values()].sort((a, b) => a[0].uly - b[0].uly);
}

/**
 * The staff count the piece's systems agree on: the most frequent
 * staves-per-system over every page among systems of more than one staff
 * (ties go to the larger count), or 1 when there is no such system. A
 * single-staff system says nothing about grouping: it is what a staff no
 * measure box joins to another looks like.
 */
export function staffCountOf(pages: { measures: MeasureBox[]; staves: MeasureBox[] }[]): number {
	const counts = new Map<number, number>();
	for (const page of pages) {
		for (const system of stavesBySystem(page.measures, page.staves)) {
			if (system.length > 1) counts.set(system.length, (counts.get(system.length) ?? 0) + 1);
		}
	}
	let best = 1;
	let bestCount = 0;
	for (const [count, systems] of counts) {
		if (systems > bestCount || (systems === bestCount && count > best)) {
			best = count;
			bestCount = systems;
		}
	}
	return best;
}
