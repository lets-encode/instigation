// Text recognition (OCR) in the browser with tesseract.js, used to read the
// instrument labels printed in front of the staves: by the score setup, which
// fills the labels in, and by the OCR page drafts, which place the staves of
// a shorter system by them. Its worker
// and WASM core are bundled assets and its language data is served at /ocr/
// (vite.config.js), all from the app's own origin and loaded on first use
// only.

import type { MeasureBox } from './mei-facsimile.ts';

/** An axis-aligned box in image pixels: left, top, right, bottom. */
export type OcrBox = [number, number, number, number];

export interface OcrWord {
	text: string;
	/** The engine's confidence, 0–100. */
	conf: number;
	box: OcrBox;
}

export interface OcrLine {
	text: string;
	conf: number;
	box: OcrBox;
	words: OcrWord[];
}

/** The languages the recognition runs with. */
const OCR_LANGUAGES = ['deu', 'eng'];

/** The engine as a recognition record names it; `version` is the bundled tesseract.js release. */
export const OCR_ENGINE = { engine: 'tesseract.js', version: '7.0.0', language: OCR_LANGUAGES.join('+') };

/** The smallest part of a word's confidence kept; lower readings are noise. */
const MIN_WORD_CONF = 30;

type Bbox = { x0: number; y0: number; x1: number; y1: number };

async function createWorker() {
	const [tesseract, worker, core] = await Promise.all([
		import('tesseract.js'),
		import('tesseract.js/dist/worker.min.js?url'),
		import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url')
	]);
	// A failed start is reported through the error handler; createWorker's
	// promise does not settle then, so the failure is raced against it.
	let failed: (e: Error) => void = () => {};
	const failure = new Promise<never>((_, reject) => (failed = reject));
	return Promise.race([
		tesseract.createWorker(OCR_LANGUAGES, tesseract.OEM.LSTM_ONLY, {
			// The worker is started from its own URL rather than a blob, so the
			// page's script policy (same origin only) covers it.
			workerPath: worker.default,
			corePath: core.default,
			workerBlobURL: false,
			langPath: '/ocr',
			errorHandler: (e: unknown) => failed(new Error(`text recognition could not start (${String(e)}).`))
		}),
		failure
	]);
}

/** A running recognition engine; `close` releases it. */
export interface OcrReader {
	/**
	 * The lines read in `region` of the image (the whole image without one),
	 * enlarged by `scale` first, with boxes in the image's pixels. `sparse`
	 * looks for scattered words (labels beside staves) rather than blocks of
	 * text.
	 */
	read(image: ImageBitmap, options?: { region?: OcrBox; scale?: number; sparse?: boolean }): Promise<OcrLine[]>;
	close(): Promise<void>;
}

export async function createOcrReader(): Promise<OcrReader> {
	const worker = await createWorker();
	let mode = '';
	return {
		async read(image, { region, scale = 1, sparse = false } = {}) {
			const [x0, y0, x1, y1] = region ?? [0, 0, image.width, image.height];
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round((x1 - x0) * scale));
			canvas.height = Math.max(1, Math.round((y1 - y0) * scale));
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Canvas 2D context unavailable.');
			ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0, 0, 0, canvas.width, canvas.height);
			// Page segmentation: automatic (3) or sparse text (11).
			const psm = sparse ? '11' : '3';
			if (mode !== psm) {
				await worker.setParameters({ tessedit_pageseg_mode: psm as never });
				mode = psm;
			}
			const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
			const toImage = (b: Bbox): OcrBox => [
				Math.round(x0 + b.x0 / scale),
				Math.round(y0 + b.y0 / scale),
				Math.round(x0 + b.x1 / scale),
				Math.round(y0 + b.y1 / scale)
			];
			return (data.blocks ?? []).flatMap((block) =>
				block.paragraphs.flatMap((paragraph) =>
					paragraph.lines.flatMap((line) => {
						const words = line.words
							.filter((w) => w.confidence >= MIN_WORD_CONF && w.text.trim())
							.map((w) => ({ text: w.text.trim(), conf: Math.round(w.confidence), box: toImage(w.bbox) }));
						if (!words.length) return [];
						return [
							{
								text: words.map((w) => w.text).join(' '),
								conf: Math.round(line.confidence),
								box: toImage(line.bbox),
								words
							}
						];
					})
				)
			);
		},
		close: () => worker.terminate().then(() => {})
	};
}

/**
 * The label printed in front of each staff box of each system on a page
 * image: the words read in the margin left of the staves, enlarged, each
 * given to the staff of its system whose middle is nearest, within that
 * staff's height (a label between two braced staves goes to one of them). A
 * system's margin ends where its own staves begin, so a system indented
 * further than the others (an introduction) keeps the label in its indent.
 * A word outside every system's height, such as a page foot, right of its
 * system's margin, or without a letter is given to none. '' for a box with
 * no label.
 */
export async function readStaffLabels(image: Blob, systems: MeasureBox[][]): Promise<string[][]> {
	const margins = systems.map((system) => (system.length ? Math.min(...system.map((box) => box.ulx)) - 2 : 0));
	const right = Math.max(0, ...margins);
	if (right < 10) return systems.map((system) => system.map(() => ''));
	const bitmap = await createImageBitmap(image);
	const reader = await createOcrReader();
	try {
		const lines = await reader.read(bitmap, { region: [0, 0, right, bitmap.height], scale: 3, sparse: true });
		const words = systems.map((system) => system.map(() => [] as OcrWord[]));
		for (const word of lines.flatMap((line) => line.words)) {
			const middle = (word.box[1] + word.box[3]) / 2;
			const s = systems.findIndex(
				(system) =>
					system.length > 0 &&
					middle >= Math.min(...system.map((box) => box.uly)) &&
					middle <= Math.max(...system.map((box) => box.lry))
			);
			// A word without a letter is a brace or bracket read as text.
			if (s < 0 || word.box[2] > margins[s] || !/\p{L}/u.test(word.text)) continue;
			let best = -1;
			let distance = Infinity;
			systems[s].forEach((box, i) => {
				const d = Math.abs((box.uly + box.lry) / 2 - middle);
				if (d <= box.lry - box.uly && d < distance) {
					best = i;
					distance = d;
				}
			});
			if (best >= 0) words[s][best].push(word);
		}
		// A label may take two printed lines: its words in line order, left to
		// right within a line (a word starting below the middle of another is
		// on a later line).
		const byLine = (a: OcrWord, b: OcrWord) =>
			a.box[1] >= (b.box[1] + b.box[3]) / 2
				? 1
				: b.box[1] >= (a.box[1] + a.box[3]) / 2
					? -1
					: a.box[0] - b.box[0];
		return words.map((system) => system.map((w) => w.sort(byLine).map((word) => word.text).join(' ')));
	} finally {
		await reader.close();
		bitmap.close();
	}
}
