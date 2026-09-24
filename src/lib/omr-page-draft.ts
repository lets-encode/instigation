// The draft an OMR-prepared piece's page task starts from. Run when the
// encoding task's branch has just been created: the page's staff boxes are
// cropped from the committed image, each staff is transcribed by the staff
// pipeline, the transcriptions are stitched into a page score (each staff on
// the score staff suggested for it from its clef, the instrument label OCR
// reads in front of it and the staff spacing, since a system may print fewer
// staves than the score has), converted to MEI by
// verovio and put into the page's measures of the piece's score, which is
// then committed to the task branch mei-friend opens. Browser only:
// canvas crops and the verovio WASM module.

import type { ForgeClient } from './forge/types.ts';
import { createOmrClient, type OmrPipeline } from './omr-client.ts';
import { parseFacsimileMei } from './mei-facsimile.ts';
import { pageSystems, staffCrops } from './omr-layout.ts';
import { cropStaves, transcribeStaves } from './omr-transcribe.ts';
import { stitchPage } from './omr-stitch.ts';
import { suggestStaffAssignment } from './omr-staff-assign.ts';
import { readStaffLabels } from './ocr.ts';
import { clefToken } from './omr-musicxml.ts';
import { insertPageDraft } from './omr-draft.ts';
import { recordApplications } from './mei-provenance.ts';
import { addXmlIds } from './mei-ids.ts';
import { checkMei } from './mei-check.ts';
import { resolveRepoRelativeTarget } from './facsimile-images.ts';
import { getVerovio } from './verovio-render.ts';

/** The Musibot models the OMR preparation runs, pinned by version. */
export interface OmrModels {
	layoutModel: OmrPipeline;
	staffPipeline: OmrPipeline;
}

export interface PageDraftOptions {
	forge: ForgeClient;
	/** The campaign repo and the head the branch was created at. */
	owner: string;
	repo: string;
	headSha: string;
	/** Where the task branch lives (the campaign repo or the volunteer's fork). */
	workRepo: { owner: string; repo: string };
	branch: string;
	/** The piece's score path and the page (1-based) the task covers. */
	fragment: string;
	page: number;
	brokerUrl: string;
	models: OmrModels;
	progress: (step: string) => void;
}

export interface PageDraftResult {
	/** What was done, for the hand-off message; names every mismatch. */
	note: string;
	/** Whether anything did not line up or failed. */
	warn: boolean;
}

/** The application names the header records for a transcription. */
export const applicationNames = (models: OmrModels): string[] =>
	[models.layoutModel, models.staffPipeline].map((m) => `Musibot ${m.name} ${m.version}`);

export async function draftPage(o: PageDraftOptions): Promise<PageDraftResult> {
	const { forge, owner, repo, fragment, page } = o;
	const score = await forge.getRepoFile(owner, repo, fragment, o.headSha);
	if (score == null) throw new Error(`Could not read ${fragment}.`);
	const parsed = parseFacsimileMei(score);
	const pg = parsed.pages[page - 1];
	if (!pg) throw new Error(`${fragment} has no page ${page}.`);
	const staves = pg.staves ?? [];
	if (!staves.length) {
		return { note: `Page ${page} has no staff boxes, so nothing was transcribed.`, warn: true };
	}

	const client = createOmrClient(o.brokerUrl);
	o.progress('Checking the recognition service');
	await client.requirePipelines([o.models.staffPipeline]);

	o.progress(`Cropping ${staves.length} staves of page ${page}`);
	const path = resolveRepoRelativeTarget(fragment, pg.image);
	const image = path ? await forge.getRepoFileBytes(owner, repo, path, o.headSha) : null;
	if (!image) throw new Error(`The image of page ${page} (${pg.image}) could not be read.`);
	const { systems, unplaced } = pageSystems(pg);
	const flat = systems.flat();
	if (!flat.length) {
		return {
			note: `Page ${page}: no staff box lies on a system of measure boxes, so nothing was transcribed.`,
			warn: true
		};
	}
	const crops = await cropStaves(image, staffCrops(flat, pg));

	o.progress(`Transcribing ${flat.length} staves`);
	const xmls = await transcribeStaves(client, o.models.staffPipeline, crops);
	let k = 0;
	const perSystem = systems.map((system) => system.map(() => xmls[k++]));
	const failed = xmls.filter((x) => x === null).length;

	o.progress('Reading the instrument labels');
	// The labels only refine the placement, so a failed reading leaves it to
	// the clefs and the spacing, with a warning.
	let labelError = '';
	const labels = await readStaffLabels(image, systems).catch((e: Error) => {
		labelError = e.message;
		return systems.map((system) => system.map(() => ''));
	});

	o.progress('Assembling the page');
	const parts = parsed.scoreDef.staves.map((s) => ({
		clef: s.clefShape === 'perc' || s.clefShape === 'TAB' ? s.clefShape : `${s.clefShape}${s.clefLine}`,
		label: s.label
	}));
	const partClefs = parts.map((part) => part.clef);
	// The score staff of each staff box (1-based, 0 for none), measured
	// against a system of the piece that shows every staff.
	const reference = parsed.pages
		.flatMap((p) => pageSystems(p).systems)
		.find((system) => system.length === parts.length);
	const assigned = systems.map((system, s) =>
		suggestStaffAssignment(
			system.map((box, i) => ({ box, clef: clefToken(perSystem[s][i]), label: labels[s][i] })),
			parts,
			reference
		)
	);
	const printed = systems.map((system, s) => {
		const map = new Map<number, string>();
		system.forEach((box, i) => {
			if (assigned[s][i] > 0) map.set(assigned[s][i], `staff-zone-${page}-${staves.indexOf(box) + 1}`);
		});
		return map;
	});
	const left = assigned.flat().filter((n) => n === 0).length;
	const stitched = stitchPage(
		perSystem,
		partClefs,
		assigned.map((system) => system.map((n) => n - 1))
	);
	const tk = await getVerovio();
	if (!tk.loadData(stitched.musicxml)) throw new Error('Verovio could not read the transcription.');
	const draft = insertPageDraft(score, `surface-${page}`, tk.getMEI({}), stitched.measuresPerSystem, printed);
	const content = addXmlIds(recordApplications(draft.mei, applicationNames(o.models)));
	const meiError = await checkMei(content);
	if (meiError) throw new Error(`The draft fails the MEI schema check (${meiError}).`);

	o.progress('Committing the draft to the task branch');
	await forge.commitFiles(
		o.workRepo.owner,
		o.workRepo.repo,
		[{ path: fragment, content }],
		`Transcription draft of page ${page} (${o.models.staffPipeline.name} ${o.models.staffPipeline.version})`,
		{ branch: o.branch }
	);

	const warnings = [
		...(unplaced ? [`${unplaced} staff box(es) lie on no system of measure boxes and were left out.`] : []),
		...(failed ? [`${failed} of ${flat.length} staves could not be transcribed and stay empty.`] : []),
		...(left ? [`${left} staff box(es) are more than the score has staves and were left out.`] : []),
		...(labelError ? [`The instrument labels could not be read (${labelError}); the staves were placed by clef and spacing.`] : []),
		...draft.warnings
	];
	return {
		note:
			`Page ${page} was transcribed into ${draft.filled} measure(s).` +
			(warnings.length ? ` ${warnings.join(' ')}` : ''),
		warn: warnings.length > 0
	};
}
