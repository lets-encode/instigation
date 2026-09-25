// Staff transcriptions kept per browser while a score setup's recognition
// runs, so that leaving the editor or a failed run does not require the
// staves already transcribed to run again. One record per campaign repo,
// staff zone and box, for one staff pipeline version and crop margin, in
// IndexedDB (a piece's MusicXML outgrows localStorage). Failed staves are not
// kept. Every call resolves, and without IndexedDB nothing is kept.

import type { MeasureBox } from './mei-facsimile.ts';
import type { OmrPipeline } from './omr-client.ts';

/** What is kept for a staff: its MusicXML and the label read in front of it. */
export interface CachedStaff {
	musicxml: string;
	label: string;
}

const DB = 'lets-encode-omr';
const STORE = 'staves';

export const staffCacheKey = (
	repoId: number,
	zone: string,
	box: MeasureBox,
	pipeline: OmrPipeline,
	cropMargin: number
): string =>
	[repoId, zone, box.ulx, box.uly, box.lrx, box.lry, pipeline.name, pipeline.version, cropMargin].join('|');

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
	if (typeof indexedDB === 'undefined') return Promise.resolve(null);
	opening ??= new Promise((resolve) => {
		try {
			const request = indexedDB.open(DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return opening;
}

/** The kept staves for `keys`, by key; a key with nothing kept is absent. */
export async function readCachedStaves(keys: string[]): Promise<Map<string, CachedStaff>> {
	const db = await open();
	const found = new Map<string, CachedStaff>();
	if (!db || !keys.length) return found;
	return new Promise((resolve) => {
		try {
			const store = db.transaction(STORE, 'readonly').objectStore(STORE);
			let left = keys.length;
			for (const key of keys) {
				const request = store.get(key);
				request.onsuccess = () => {
					if (request.result) found.set(key, request.result as CachedStaff);
					if (--left === 0) resolve(found);
				};
				request.onerror = () => {
					if (--left === 0) resolve(found);
				};
			}
		} catch {
			resolve(found);
		}
	});
}

/** Keep staves by key. */
export async function writeCachedStaves(entries: [string, CachedStaff][]): Promise<void> {
	const db = await open();
	if (!db || !entries.length) return;
	await new Promise<void>((resolve) => {
		try {
			const transaction = db.transaction(STORE, 'readwrite');
			const store = transaction.objectStore(STORE);
			for (const [key, value] of entries) store.put(value, key);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => resolve();
			transaction.onabort = () => resolve();
		} catch {
			resolve();
		}
	});
}
