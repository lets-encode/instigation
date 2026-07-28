import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	DRAFT_VERSION,
	discardDraft,
	fetchDraftImages,
	finishDraft,
	parseDraft,
	readDraft,
	resumableDrafts,
	writeDraft,
	type DraftEntries,
	type WizardDraft
} from '../wizard-draft.ts';
import { emptySourceMetadata } from '../source-metadata.ts';

// The module reads the global `localStorage`, absent outside a browser.
function installStorage(): Map<string, string> {
	const items = new Map<string, string>();
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			get length() {
				return items.size;
			},
			key: (i: number) => [...items.keys()][i] ?? null,
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => void items.set(key, value),
			removeItem: (key: string) => void items.delete(key)
		}
	});
	return items;
}

let items: Map<string, string>;
beforeEach(() => {
	items = installStorage();
});

const entries = (over: Partial<DraftEntries> = {}): DraftEntries => ({
	step: 'source',
	title: 'Symphony No. 9',
	description: '',
	license: 'CC0-1.0',
	iiifManifestUrl: '',
	copyrightAccepted: true,
	imagePaths: ['img/01.jpg'],
	encodings: [],
	source: emptySourceMetadata(),
	pieces: [],
	...over
});

const draft = (over: Partial<WizardDraft> = {}): WizardDraft => ({
	version: DRAFT_VERSION,
	owner: 'ada',
	handle: 'symphony-9',
	finishedSetup: false,
	updatedAt: '2026-07-28T10:00:00.000Z',
	claim: null,
	repo: null,
	entries: entries(),
	...over
});

test('stores a draft under its campaign name and reads it back', () => {
	assert.equal(writeDraft(draft()), null);
	assert.deepEqual([...items.keys()], ['lets-encode:setup:symphony-9']);
	assert.deepEqual(readDraft('symphony-9'), draft());
	assert.equal(readDraft('other'), null);
});

test('discarding removes the record', () => {
	writeDraft(draft());
	discardDraft('symphony-9');
	assert.equal(readDraft('symphony-9'), null);
});

test('rejects records that are unreadable, of another version, or incomplete', () => {
	assert.equal(parseDraft(null), null);
	assert.equal(parseDraft('not json'), null);
	assert.equal(parseDraft('"a string"'), null);
	assert.equal(parseDraft(JSON.stringify({ ...draft(), version: DRAFT_VERSION + 1 })), null);
	assert.equal(parseDraft(JSON.stringify({ ...draft(), handle: '' })), null);
	// An unfinished setup without its entries cannot be continued.
	assert.equal(parseDraft(JSON.stringify({ ...draft(), entries: undefined })), null);
	assert.equal(
		parseDraft(JSON.stringify({ ...draft(), entries: { ...entries(), pieces: 'one' } })),
		null
	);
});

test('lists the signed-in account’s unfinished setups, most recently changed first', () => {
	writeDraft(draft({ handle: 'older', updatedAt: '2026-07-01T00:00:00.000Z' }));
	writeDraft(draft({ handle: 'newer', updatedAt: '2026-07-27T00:00:00.000Z' }));
	writeDraft(draft({ handle: 'someone-elses', owner: 'grace' }));
	writeDraft(draft({ handle: 'done', finishedSetup: true, entries: undefined }));
	assert.deepEqual(
		resumableDrafts('ada').map((d) => d.handle),
		['newer', 'older']
	);
	assert.deepEqual(resumableDrafts('grace').map((d) => d.handle), ['someone-elses']);
});

test('finishing replaces the entries with the completion marker', () => {
	writeDraft(draft({ repo: null }));
	const repo = {
		owner: 'ada',
		name: 'symphony-9',
		full_name: 'ada/symphony-9',
		html_url: 'https://example.test/ada/symphony-9',
		id: 42
	};
	finishDraft('symphony-9', 'ada', repo);
	const stored = readDraft('symphony-9');
	assert.equal(stored?.finishedSetup, true);
	assert.equal(stored?.entries, undefined);
	assert.deepEqual(stored?.repo, repo);
	// A finished setup is never offered for continuing again.
	assert.deepEqual(resumableDrafts('ada'), []);
});

test('reports the browser refusing a write rather than throwing', () => {
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			length: 0,
			key: () => null,
			getItem: () => null,
			setItem: () => {
				throw new Error('quota exceeded');
			},
			removeItem: () => {}
		}
	});
	assert.equal(writeDraft(draft()), 'quota exceeded');
});

test('reads the page images back in page order, listing each directory once', async () => {
	const listed: string[] = [];
	const fetched: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		fetched.push(String(url));
		return { ok: true, blob: async () => new Blob([String(url)]) };
	}) as typeof fetch;
	try {
		const images = await fetchDraftImages(
			{
				getDirDownloadUrls: async (_owner, _repo, dir) => {
					listed.push(dir);
					return { '01.jpg': 'https://raw.test/01.jpg', '02.jpg': 'https://raw.test/02.jpg' };
				}
			},
			{ owner: 'ada', name: 'symphony-9' },
			['img/02.jpg', 'img/01.jpg']
		);
		assert.deepEqual(
			images.map((image) => image.path),
			['img/02.jpg', 'img/01.jpg']
		);
		assert.deepEqual(listed, ['img']);
		assert.deepEqual(fetched, ['https://raw.test/02.jpg', 'https://raw.test/01.jpg']);
	} finally {
		globalThis.fetch = original;
	}
});

test('fails when an image is no longer in the repository', async () => {
	await assert.rejects(
		fetchDraftImages(
			{ getDirDownloadUrls: async () => ({}) },
			{ owner: 'ada', name: 'symphony-9' },
			['img/01.jpg']
		),
		/img\/01\.jpg is no longer in ada\/symphony-9/
	);
});
