// Creating the campaign repository, shared by the upload and pages steps: the
// pages step creates it when there are pages to commit, the upload step when
// there are none (the pages step is skipped then). Creation is idempotent —
// a repository left behind by an attempt whose response never arrived (a
// network drop after GitHub created it) is adopted on the next try instead of
// failing on the name, and a transient network error is retried once before
// being surfaced.

import type { ForgeClient, RepoData } from './forge/types.ts';
import { provider } from './forge/config.ts';
import { wizard, draftSnapshot, saveDraft, type WizardRepo } from './wizard.svelte.ts';
import type { ProgressUpdate } from './run-watch.ts';

/** The template file whose presence marks a repository generated for a campaign. */
const TEMPLATE_MARKER = 'templates/score.template.mei';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A fetch that never reached the server (connection drop, DNS, CORS block)
// surfaces as a TypeError with a browser-worded message, not an API error.
const isNetworkError = (err: unknown): boolean =>
	err instanceof TypeError || /networkerror|failed to fetch|load failed/i.test((err as Error)?.message ?? '');

async function createOrAdoptRepo(
	f: ForgeClient,
	owner: string,
	name: string,
	description: string
): Promise<RepoData> {
	const create = () =>
		f.createRepoFromTemplate({
			templateOwner: provider.template.owner,
			templateRepo: provider.template.repo,
			owner,
			name,
			description,
			isPrivate: false
		});
	let error: Error;
	try {
		return await create();
	} catch (err) {
		error = err as Error;
		// The request may have failed on the way back after the repository was
		// created; fall through to look for it. A transient network error with
		// no repository behind it gets one more try below.
	}

	const existing = await f.getRepoInfo(owner, name).catch(() => null);
	if (existing) {
		// Adopt it only if it came from the campaign template (its marker file may
		// still be materialising — generation is asynchronous — so wait briefly);
		// an unrelated repository of the same name must not be committed into.
		const marker = await f
			.waitForRepoContents(owner, name, TEMPLATE_MARKER, { attempts: 5, delayMs: 1000 })
			.catch(() => null);
		if (marker !== null) return existing;
		throw new Error(
			`A repository called ${owner}/${name} already exists but is not this campaign's. ` +
				`Remove or rename it, or restart the setup under another name.`
		);
	}

	if (isNetworkError(error)) {
		await sleep(1500);
		return create();
	}
	throw error;
}

/**
 * Ensure the campaign repository exists and is ready to be committed to,
 * recording it on the wizard (and its draft) as soon as it does. Reuses the
 * repository a retry or a continued setup already created. Throws with a
 * user-readable message; progress goes to `log`.
 */
export async function ensureCampaignRepo(
	f: ForgeClient,
	userLogin: string,
	log: (update: ProgressUpdate) => void
): Promise<WizardRepo> {
	// The held name is the campaign's name, for the repository and the registry
	// alike. Without it there is nothing to create the repository under.
	const claim = wizard.claim;
	if (!claim) {
		throw new Error(
			'This campaign has no name reserved yet. Go back to the first step and continue from there.'
		);
	}

	// The repository may already exist from an earlier attempt that failed
	// after creating it; reuse it rather than creating a second one.
	let repo = wizard.repo;
	if (!repo) {
		// The repository's "About" carries the campaign's title and description
		// together. GitHub rejects a description longer than 350 characters.
		const about = [wizard.title.trim(), wizard.description.trim()]
			.filter(Boolean)
			.join(' — ')
			.slice(0, 350);
		log({ step: 'Creating the repository' });
		const created = await createOrAdoptRepo(f, userLogin, claim.name, about);
		repo = {
			owner: created.owner.login,
			name: created.name,
			full_name: created.full_name,
			html_url: created.html_url,
			id: created.id
		};
		wizard.repo = repo;
		// The repository exists from here on, whatever happens next. The draft is
		// stored on a debounce as entries change, which is too late for this: a
		// setup continued without it would try to create a second repository
		// under a name this one already has.
		saveDraft(userLogin, draftSnapshot());

		// The listing topic is not stamped here: it marks a campaign, and this
		// repository is not one until the final step has set it up.
		// Give the campaign's Actions a read/write token (non-fatal for org limits).
		try {
			await f.setActionsWorkflowPermissions(repo.owner, repo.name);
		} catch (err) {
			console.warn('Could not set Actions workflow permissions:', (err as Error).message);
		}
	}

	// Generating from a template is asynchronous — wait until the repo has
	// contents before anything commits onto it.
	log({ step: 'Waiting for the repository' });
	await f.waitForRepoContents(repo.owner, repo.name, TEMPLATE_MARKER);
	return repo;
}
