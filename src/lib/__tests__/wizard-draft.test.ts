import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	DRAFT_VERSION,
	discardDraft,
	fetchDraftImages,
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
	// A record without its entries cannot be continued, so it is not a record.
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
	assert.deepEqual(
		resumableDrafts('ada').map((d) => d.handle),
		['newer', 'older']
	);
	assert.deepEqual(resumableDrafts('grace').map((d) => d.handle), ['someone-elses']);
});

test('a finished setup leaves nothing to continue', () => {
	// The wizard discards the record once the campaign is committed, so there is
	// no trace of it here afterwards.
	writeDraft(draft());
	discardDraft('symphony-9');
	assert.equal(readDraft('symphony-9'), null);
	assert.deepEqual(resumableDrafts('ada'), []);
	assert.deepEqual([...items.keys()], []);
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

test('reads the page images back through the API, in page order', async () => {
	const read: string[] = [];
	const images = await fetchDraftImages(
		{
			getRepoFileBytes: async (_owner, _repo, path) => {
				read.push(path);
				return new Blob([path]);
			}
		},
		{ owner: 'ada', name: 'symphony-9' },
		['img/02.jpg', 'img/01.jpg']
	);
	assert.deepEqual(
		images.map((image) => image.path),
		['img/02.jpg', 'img/01.jpg']
	);
	assert.deepEqual(read, ['img/02.jpg', 'img/01.jpg']);
});

test('labels the bytes as an image, whatever media type they arrive under', async () => {
	const images = await fetchDraftImages(
		{
			getRepoFileBytes: async (_owner, _repo, path) =>
				new Blob([path], { type: 'application/vnd.github.raw' })
		},
		{ owner: 'ada', name: 'symphony-9' },
		['img/01.jpg', 'img/02.PNG']
	);
	assert.deepEqual(
		images.map((image) => image.blob.type),
		['image/jpeg', 'image/png']
	);
});

test('fails when an image is no longer in the repository', async () => {
	await assert.rejects(
		fetchDraftImages(
			{ getRepoFileBytes: async () => null },
			{ owner: 'ada', name: 'symphony-9' },
			['img/01.jpg']
		),
		/img\/01\.jpg is no longer in ada\/symphony-9/
	);
});
