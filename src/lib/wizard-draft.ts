// Storage for a campaign setup in progress: the entries the onboarding wizard
// has collected are mirrored into localStorage under one record per campaign
// name, so a setup interrupted by a reload, a closed tab or a failed step can be
// continued from the campaign list.
//
// A record holds less than the wizard's state. `File` objects and image bytes
// cannot be stored, so a draft keeps the repository-relative paths of the page
// images the pages step committed and reads their bytes back from the repository
// when the setup is continued; files that were picked but not yet uploaded, and
// the candidate pages read from them, are not kept. Uploaded encodings are MEI
// text and are stored as they are, since nothing else holds them until the final
// step commits them.
//
// A record exists only while a setup is unfinished: once the last step has
// committed the campaign, the record is removed. So every record here describes
// something that can be continued.

import type { EncodingSource, PageImage } from './prepare-images.ts';
import type { SourceMetadata } from './source-metadata.ts';
import type { Piece } from './pieces.ts';
import type { WizardClaim, WizardRepo, WizardStepId } from './wizard.svelte.ts';
import type { ForgeClient } from './forge/types.ts';

/** Records written under any other version are ignored when read back. */
export const DRAFT_VERSION = 1;

const KEY_PREFIX = 'lets-encode:setup:';

/** The wizard entries a draft carries over. */
export interface DraftEntries {
	/** The step the setup was left on. */
	step: WizardStepId;
	title: string;
	description: string;
	license: string;
	iiifManifestUrl: string;
	copyrightAccepted: boolean;
	/** Paths of the committed page images, in page order; the bytes are re-read. */
	imagePaths: string[];
	encodings: EncodingSource[];
	source: SourceMetadata;
	pieces: Piece[];
}

export interface WizardDraft {
	version: number;
	/** Login of the account the setup was started on. */
	owner: string;
	/** The campaign's name, which is also this record's key. */
	handle: string;
	/** ISO timestamp of the last write. */
	updatedAt: string;
	/**
	 * The name held for this setup in the slug registry. Carried so a continued
	 * setup can still register the name it holds, rather than having to ask for it
	 * again and find it gone.
	 */
	claim: WizardClaim | null;
	/** The campaign repository, once the pages step has created it. */
	repo: WizardRepo | null;
	entries: DraftEntries;
}

const draftKey = (handle: string) => `${KEY_PREFIX}${handle}`;

// Storage is read through this so the module can be used where there is none.
const store = () => (typeof localStorage === 'undefined' ? null : localStorage);

/**
 * A record from its stored JSON, or null if it is absent, unreadable, of another
 * version, or missing the entries a setup needs to be continued.
 */
export function parseDraft(text: string | null): WizardDraft | null {
	if (!text) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const draft = value as WizardDraft;
	if (draft.version !== DRAFT_VERSION) return null;
	if (typeof draft.handle !== 'string' || !draft.handle) return null;
	if (typeof draft.owner !== 'string') return null;
	const entries = draft.entries;
	if (!entries || typeof entries !== 'object') return null;
	if (!Array.isArray(entries.imagePaths)) return null;
	if (!Array.isArray(entries.encodings)) return null;
	if (!Array.isArray(entries.pieces)) return null;
	if (!entries.source || typeof entries.source !== 'object') return null;
	return draft;
}

export function readDraft(handle: string): WizardDraft | null {
	return parseDraft(store()?.getItem(draftKey(handle)) ?? null);
}

/**
 * Store a record. Returns the browser's message when it refused the write —
 * a storage quota is a few megabytes, and uploaded encodings count against it —
 * and null when the record was stored.
 */
export function writeDraft(draft: WizardDraft): string | null {
	const storage = store();
	if (!storage) return null;
	try {
		storage.setItem(draftKey(draft.handle), JSON.stringify(draft));
		return null;
	} catch (err) {
		return (err as Error).message;
	}
}

export function discardDraft(handle: string): void {
	store()?.removeItem(draftKey(handle));
}

/**
 * The setups `owner` can continue, most recently changed first. Records of other
 * accounts are left out: continuing a setup creates the repository on the
 * account that is signed in.
 */
export function resumableDrafts(owner: string): WizardDraft[] {
	const storage = store();
	if (!storage) return [];
	const drafts: WizardDraft[] = [];
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (!key?.startsWith(KEY_PREFIX)) continue;
		const draft = parseDraft(storage.getItem(key));
		if (draft && draft.owner === owner) drafts.push(draft);
	}
	return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The bytes of a draft's page images, read back from the repository the upload
 * step committed them to. The result follows `paths`, which is page order.
 *
 * Read through the API rather than from each file's download URL: a page
 * displayed from raw.githubusercontent.com is an image the browser loads, while
 * reading its bytes is a connection this app only makes to the API.
 */
export async function fetchDraftImages(
	forge: Pick<ForgeClient, 'getRepoFileBytes'>,
	repo: { owner: string; name: string },
	paths: string[],
	onProgress?: (done: number, total: number) => void
): Promise<PageImage[]> {
	const images: PageImage[] = [];
	for (const path of paths) {
		const blob = await forge.getRepoFileBytes(repo.owner, repo.name, path);
		if (!blob) throw new Error(`${path} is no longer in ${repo.owner}/${repo.name}.`);
		images.push({ path, blob: asImageBlob(blob, path) });
		onProgress?.(images.length, paths.length);
	}
	return images;
}

/**
 * The same bytes under an image media type, taken from the file's extension when
 * they arrive under another one. A blob URL is displayed according to the type
 * its blob records, so bytes labelled anything else do not render as an image.
 */
function asImageBlob(blob: Blob, path: string): Blob {
	if (blob.type.startsWith('image/')) return blob;
	const type = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
	return new Blob([blob], { type });
}
