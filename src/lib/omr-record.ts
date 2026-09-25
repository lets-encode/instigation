// The recognition record of an OMR-prepared piece, committed as `omr.xml`
// next to the score by the score setup: what the staff pipeline and the OCR
// produced for every staff box, keyed to the score's staff zones, and the
// corrections volunteers made to what is computed from it (staff assignment,
// opening clefs). Everything derivable (systems, clef/key/meter timelines,
// the stitched page, the converted MEI) is recomputed from it. Each staff's
// MusicXML is embedded as an element, its XML declaration and DOCTYPE
// removed. Regex over the document text, no DOM.

import type { MeasureBox } from './mei-facsimile.ts';
import type { OmrPipeline } from './omr-client.ts';

export const OMR_RECORD_SCHEMA = 1;

export interface OmrStaffEntry {
	/** The score's staff zone id (`staff-zone-P-K`). */
	zone: string;
	/** The staff box the crop was cut from. */
	box: MeasureBox;
	/** The instrument label read in front of the staff; '' when nothing was read. */
	label: string;
	/** The staff pipeline's MusicXML, with its declaration; null for a failed staff. */
	musicxml: string | null;
	/** Why the staff has no transcription; '' when it has one. */
	error: string;
}

export interface OmrPageEntry {
	/** 1-based, as in `surface-N`. */
	n: number;
	/** The score's graphic target of the page. */
	image: string;
	staves: OmrStaffEntry[];
}

export interface OcrEngine {
	engine: string;
	version: string;
	language: string;
}

export interface OmrRecord {
	/** Multiple of the staff height the crops were cut with. */
	cropMargin: number;
	staffPipeline: OmrPipeline;
	ocr: OcrEngine;
	pages: OmrPageEntry[];
	/** Staff assignments a volunteer corrected: score staff (1-based, 0 for none) per staff zone. */
	assignments: { zone: string; staff: number }[];
	/** Opening-clef corrections: the score staff, the clef the model read and the clef it should be. */
	clefs: { staff: number; read: string; corrected: string }[];
}

/** The record's path for a score: `omr.xml` in the score's directory. */
export const omrRecordPath = (fragment: string): string =>
	`${fragment.slice(0, fragment.lastIndexOf('/') + 1)}omr.xml`;

const escape = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const unescape = (s: string): string =>
	s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

const boxAttributes = (box: MeasureBox): string =>
	`ulx="${box.ulx}" uly="${box.uly}" lrx="${box.lrx}" lry="${box.lry}"`;

/** A MusicXML document without its XML declaration and DOCTYPE. */
const bare = (musicxml: string): string =>
	musicxml
		.replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*/, '')
		.replace(/^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>\s*/, '')
		.trim();

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

export function serializeOmrRecord(record: OmrRecord): string {
	const lines = [
		XML_DECLARATION.trim(),
		`<omr schema="${OMR_RECORD_SCHEMA}" cropMargin="${record.cropMargin}">`,
		'  <models>',
		`    <staffPipeline name="${escape(record.staffPipeline.name)}" version="${escape(record.staffPipeline.version)}"/>`,
		`    <ocr engine="${escape(record.ocr.engine)}" version="${escape(record.ocr.version)}" language="${escape(record.ocr.language)}"/>`,
		'  </models>'
	];
	for (const page of record.pages) {
		lines.push(`  <page n="${page.n}" image="${escape(page.image)}">`);
		for (const staff of page.staves) {
			const open = `    <staff zone="${escape(staff.zone)}" ${boxAttributes(staff.box)}`;
			const label = staff.label ? `      <label>${escape(staff.label)}</label>` : '';
			if (staff.musicxml === null) {
				const error = ` error="${escape(staff.error || 'not transcribed')}"`;
				lines.push(label ? `${open}${error}>\n${label}\n    </staff>` : `${open}${error}/>`);
			} else {
				lines.push(`${open}>`, ...(label ? [label] : []), bare(staff.musicxml), '    </staff>');
			}
		}
		lines.push('  </page>');
	}
	for (const a of record.assignments) lines.push(`  <assignment zone="${escape(a.zone)}" staff="${a.staff}"/>`);
	for (const c of record.clefs) {
		lines.push(`  <clef staff="${c.staff}" read="${escape(c.read)}" corrected="${escape(c.corrected)}"/>`);
	}
	lines.push('</omr>');
	return lines.join('\n') + '\n';
}

const attr = (tag: string, name: string): string | null => {
	const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
	return value === undefined ? null : unescape(value);
};

const num = (tag: string, name: string): number => Number(attr(tag, name) ?? NaN);

/** A record read from `omr.xml`, or null for a file of another schema or none. */
export function parseOmrRecord(xml: string | null): OmrRecord | null {
	const root = xml ? /<omr\b[^>]*>/.exec(xml)?.[0] : null;
	if (!xml || !root || num(root, 'schema') !== OMR_RECORD_SCHEMA) return null;
	const pipeline = /<staffPipeline\b[^>]*>/.exec(xml)?.[0] ?? '';
	const ocr = /<ocr\b[^>]*>/.exec(xml)?.[0] ?? '';
	// Pages and staff entries are found by their attributes: the embedded
	// MusicXML has <staff>, <staff-details> and <page-layout> elements of its own.
	const pages: OmrPageEntry[] = [];
	for (const page of xml.match(/<page n="[\s\S]*?<\/page>/g) ?? []) {
		const tag = /^<page\b[^>]*>/.exec(page)![0];
		const staves: OmrStaffEntry[] = [];
		const starts = [...page.matchAll(/<staff zone="/g)].map((m) => m.index!);
		for (const [i, from] of starts.entries()) {
			const staff = page.slice(from, starts[i + 1] ?? page.length);
			const open = /^<staff\b[^>]*>/.exec(staff)![0];
			const score = /<score-partwise\b[\s\S]*<\/score-partwise>/.exec(staff)?.[0] ?? null;
			const label = /^<staff\b[^>]*[^/]>\s*<label>([\s\S]*?)<\/label>/.exec(staff)?.[1];
			staves.push({
				zone: attr(open, 'zone') ?? '',
				box: { ulx: num(open, 'ulx'), uly: num(open, 'uly'), lrx: num(open, 'lrx'), lry: num(open, 'lry') },
				label: label === undefined ? '' : unescape(label),
				musicxml: score ? XML_DECLARATION + score : null,
				error: score ? '' : (attr(open, 'error') ?? 'not transcribed')
			});
		}
		pages.push({ n: num(tag, 'n'), image: attr(tag, 'image') ?? '', staves });
	}
	// Assignments and clef corrections sit after the pages, outside every staff's MusicXML.
	const tail = xml.slice(xml.lastIndexOf('</page>') + 1);
	return {
		cropMargin: num(root, 'cropMargin'),
		staffPipeline: { name: attr(pipeline, 'name') ?? '', version: attr(pipeline, 'version') ?? '' },
		ocr: { engine: attr(ocr, 'engine') ?? '', version: attr(ocr, 'version') ?? '', language: attr(ocr, 'language') ?? '' },
		pages,
		assignments: (tail.match(/<assignment\b[^>]*>/g) ?? []).map((tag) => ({
			zone: attr(tag, 'zone') ?? '',
			staff: num(tag, 'staff')
		})),
		clefs: (tail.match(/<clef\b[^>]*\bcorrected="[^"]*"[^>]*>/g) ?? []).map((tag) => ({
			staff: num(tag, 'staff'),
			read: attr(tag, 'read') ?? '',
			corrected: attr(tag, 'corrected') ?? ''
		}))
	};
}

const sameBox = (a: MeasureBox, b: MeasureBox): boolean =>
	a.ulx === b.ulx && a.uly === b.uly && a.lrx === b.lrx && a.lry === b.lry;

/**
 * The record's entry for a staff zone, while it still describes that box and
 * was made by `pipeline` with `cropMargin`; null otherwise, so the staff is
 * transcribed again.
 */
export function entryFor(
	record: OmrRecord | null,
	zone: string,
	box: MeasureBox,
	pipeline: OmrPipeline,
	cropMargin: number
): OmrStaffEntry | null {
	if (
		!record ||
		record.cropMargin !== cropMargin ||
		record.staffPipeline.name !== pipeline.name ||
		record.staffPipeline.version !== pipeline.version
	)
		return null;
	for (const page of record.pages) {
		const entry = page.staves.find((s) => s.zone === zone);
		if (entry) return sameBox(entry.box, box) ? entry : null;
	}
	return null;
}
