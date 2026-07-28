// Shared state for the campaign onboarding wizard. The wizard spans several
// screens but is one flow: a step index plus the values collected so far live
// here, so a step can read what earlier steps gathered without prop-threading.
//
// The flow has a pre-repo and a post-repo phase — the campaign repository is
// created at the end of the upload step, and everything after it is held in the
// browser until the final commit. `repo` records that crossing.
//
// What is collected is also mirrored into the browser's storage as a draft, so a
// setup that is interrupted can be continued; see wizard-draft.ts.

import type { EncodingSource, PageImage } from './prepare-images.ts';
import { emptySourceMetadata, type SourceMetadata } from './source-metadata.ts';
import type { Piece } from './pieces.ts';
import { DEFAULT_LICENSE } from './licenses.ts';
import {
	DRAFT_VERSION,
	discardDraft,
	writeDraft,
	type DraftEntries,
	type WizardDraft
} from './wizard-draft.ts';

/** The wizard's steps, in order. Drives navigation and the progress header. */
export const WIZARD_STEPS = [
	{ id: 'name', label: 'Name' },
	{ id: 'license', label: 'Licence' },
	{ id: 'upload', label: 'Upload' },
	{ id: 'source', label: 'Source' },
	{ id: 'pieces', label: 'Pieces' }
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

/** Character limit on the campaign description. */
export const MAX_DESCRIPTION_LENGTH = 300;

/**
 * The campaign's name, held in the slug registry from the name step onwards. It
 * is the single source of the name: the repository is created under it and it is
 * registered under the same value, so the repo name and the slug cannot diverge.
 */
export interface WizardClaim {
	name: string;
	/** The right to register this name, or to give it back. */
	token: string;
}

/** The campaign repository, once the upload step has created it. */
export interface WizardRepo {
	owner: string;
	name: string;
	full_name: string;
	html_url: string;
	id: number;
}

/**
 * What the organiser confirms before their upload is committed. Versioned so a
 * campaign can record which wording was agreed to.
 */
export const COPYRIGHT_ACKNOWLEDGEMENT = {
	version: '1',
	text: 'I have the right to publish these materials, or they are in the public domain.'
} as const;

export const wizard = $state<{
	step: WizardStepId;
	/**
	 * The campaign's name: repo name, registry slug and address at once. Editable
	 * until the name step holds it in the registry, after which `claim` carries it
	 * and this only mirrors it.
	 */
	handle: string;
	/** The held name, from the name step until the campaign is registered. */
	claim: WizardClaim | null;
	/** Human-readable label for the campaign. */
	title: string;
	/** Short statement of what the campaign sets out to encode. Optional. */
	description: string;
	/** SPDX id of the licence the encoding is published under. */
	license: string;
	/** Page images, PDFs and encodings picked in the upload step. */
	files: File[];
	/** A IIIF Presentation manifest whose canvases are fetched and committed. */
	iiifManifestUrl: string;
	copyrightAccepted: boolean;
	repo: WizardRepo | null;
	/**
	 * The page images committed by the upload step, kept with their bytes: later
	 * steps display them, and a PDF's rendered pages exist nowhere else in the
	 * browser once the upload step has run.
	 */
	images: PageImage[];
	/**
	 * Uploaded encodings, converted to MEI. Held in the browser until the final
	 * step, which writes them at their piece paths alongside config and tables.
	 */
	encodings: EncodingSource[];
	/** Whole-source metadata, copied into each piece's header at the end. */
	source: SourceMetadata;
	/** The works within the source; one MEI and one task group each. */
	pieces: Piece[];
}>({
	step: 'name',
	handle: '',
	claim: null,
	title: '',
	description: '',
	license: DEFAULT_LICENSE,
	files: [],
	iiifManifestUrl: '',
	copyrightAccepted: false,
	repo: null,
	images: [],
	encodings: [],
	source: emptySourceMetadata(),
	pieces: []
});

export const stepIndex = (id: WizardStepId) => WIZARD_STEPS.findIndex((s) => s.id === id);

/** Advance to the next step, if there is one. */
export function nextStep(): void {
	const next = WIZARD_STEPS[stepIndex(wizard.step) + 1];
	if (next) wizard.step = next.id;
}

/** Return to the previous step, if there is one. */
export function previousStep(): void {
	const previous = WIZARD_STEPS[stepIndex(wizard.step) - 1];
	if (previous) wizard.step = previous.id;
}

/** Discard everything collected and return to the first step. */
export function resetWizard(): void {
	savedHandle = null;
	wizard.step = 'name';
	wizard.handle = '';
	wizard.claim = null;
	wizard.title = '';
	wizard.description = '';
	wizard.license = DEFAULT_LICENSE;
	wizard.files = [];
	wizard.iiifManifestUrl = '';
	wizard.copyrightAccepted = false;
	wizard.repo = null;
	wizard.images = [];
	wizard.encodings = [];
	wizard.source = emptySourceMetadata();
	wizard.pieces = [];
}

// ---------------------------------------------------------------------------
// Drafts: the wizard's entries mirrored into the browser, so an interrupted
// setup can be continued. See wizard-draft.ts for what a record holds.

/** Whether the setup's draft could be stored. Surfaced by the wizard frame. */
export const draftStatus = $state<{ saveError: string | null }>({ saveError: null });

// The name the draft was last stored under. A campaign renamed before its
// repository exists would otherwise leave its earlier draft behind.
let savedHandle: string | null = null;

/** Everything a draft record carries, apart from the account it belongs to. */
export interface DraftSnapshot {
	handle: string;
	claim: WizardClaim | null;
	repo: WizardRepo | null;
	entries: DraftEntries;
}

/**
 * A draft's contents, read out of the wizard state. Every stored field is read
 * here and nowhere else, so a caller collecting this inside a reactive effect
 * depends on all of them, and can write the result on a debounce.
 */
export function draftSnapshot(): DraftSnapshot {
	return {
		handle: wizard.handle,
		claim: wizard.claim ? { ...wizard.claim } : null,
		repo: wizard.repo ? { ...wizard.repo } : null,
		entries: {
			step: wizard.step,
			title: wizard.title,
			description: wizard.description,
			license: wizard.license,
			iiifManifestUrl: wizard.iiifManifestUrl,
			copyrightAccepted: wizard.copyrightAccepted,
			imagePaths: wizard.images.map((image) => image.path),
			encodings: wizard.encodings.map((encoding) => ({ ...encoding })),
			source: $state.snapshot(wizard.source),
			pieces: $state.snapshot(wizard.pieces)
		}
	};
}

/**
 * Store what has been entered, under the campaign's name. Nothing is stored
 * while the name step is open, so a draft always has a name to be listed and
 * continued under.
 */
export function saveDraft(owner: string, snapshot: DraftSnapshot): void {
	const name = snapshot.handle.trim();
	if (!owner || !name || snapshot.entries.step === 'name') return;
	if (savedHandle && savedHandle !== name) discardDraft(savedHandle);
	savedHandle = name;
	draftStatus.saveError = writeDraft({
		version: DRAFT_VERSION,
		owner,
		handle: name,
		updatedAt: new Date().toISOString(),
		claim: snapshot.claim,
		repo: snapshot.repo,
		entries: snapshot.entries
	});
}

/**
 * Put a draft's entries back into the wizard and open the step it was left on.
 * The page images are passed in rather than read here: their bytes come from the
 * campaign repository, which this module does not talk to.
 */
export function applyDraft(draft: WizardDraft, images: PageImage[]): void {
	const entries = draft.entries;
	if (!entries) return;
	wizard.handle = draft.handle;
	wizard.claim = draft.claim ?? null;
	wizard.title = entries.title;
	wizard.description = entries.description;
	wizard.license = entries.license;
	wizard.iiifManifestUrl = entries.iiifManifestUrl;
	wizard.copyrightAccepted = entries.copyrightAccepted;
	wizard.repo = draft.repo;
	wizard.source = entries.source;
	wizard.pieces = entries.pieces;
	wizard.encodings = entries.encodings;
	wizard.images = images;
	// Picked files are not part of a draft; the upload step collects them again.
	wizard.files = [];
	savedHandle = draft.handle;
	draftStatus.saveError = null;
	wizard.step = stepIndex(entries.step) < 0 ? 'name' : entries.step;
}

/**
 * Clear a setup that has completed: its draft is dropped, since there is a
 * campaign now and nothing left to continue, and the wizard is emptied for the
 * next one. Emptying it is also what stops a later save from storing the finished
 * setup again — saveDraft keeps nothing without a name.
 */
export function clearFinishedSetup(): void {
	discardDraft(wizard.handle.trim());
	resetWizard();
}
