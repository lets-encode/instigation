import { redirect, fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	searchReposByTopic,
	createRepoFromTemplate,
	setRepoTopics,
	setActionsWorkflowPermissions,
	waitForRepoContents,
	commitFiles
} from '$lib/server/github.js';
import {
	buildCampaignConfig,
	configToYaml,
	stampTemplate,
	buildStateCsv,
	buildLocksCsv
} from '$lib/server/campaign-init.js';

const REPO_TOPIC = env.REPO_TOPIC || 'created-with-instigation';

export async function load({ locals, url }) {
	const template = `${env.TEMPLATE_OWNER}/${env.TEMPLATE_REPO}`;
	// 'login' = the user declined the GitHub authorization. null otherwise.
	const denied = url.searchParams.get('denied');

	try {
		// The token holds the `repo` scope, so this returns the user's matching
		// public and private repositories.
		const repos = await searchReposByTopic(REPO_TOPIC, locals.token);
		return { repos, listError: null, template, denied };
	} catch (e) {
		console.error('Repo listing failed:', e.message);
		return {
			repos: [],
			listError: 'Could not load the repository list right now.',
			template,
			denied
		};
	}
}

export const actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(302, '/');

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const title = String(form.get('title') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		const license = String(form.get('license') ?? '').trim();
		const composer = String(form.get('composer') ?? '').trim();
		const isPrivate = form.get('visibility') === 'private';

		// Echoed back on any early return so the form keeps what was typed.
		const fields = { name, title, description, license, composer, isPrivate };

		// GitHub repo name rules: letters, digits, -, _.
		if (!name) return fail(400, { ...fields, error: 'Repository name is required.' });
		if (!/^[A-Za-z0-9_-]+$/.test(name)) {
			return fail(400, {
				...fields,
				error: 'Name may only contain letters, numbers, hyphens and underscores.'
			});
		}
		if (!title) return fail(400, { ...fields, error: 'Campaign title is required.' });

		try {
			const repo = await createRepoFromTemplate(locals.token, {
				templateOwner: env.TEMPLATE_OWNER,
				templateRepo: env.TEMPLATE_REPO,
				owner: locals.user.login,
				name,
				description,
				isPrivate
			});

			// Tag it so it shows up in the listing. Non-fatal: the repo already
			// exists; without the topic it just won't appear in the list.
			try {
				await setRepoTopics(locals.token, repo.owner.login, repo.name, [REPO_TOPIC]);
			} catch (e) {
				console.warn('Could not tag new repo with topic:', e.message);
			}

			// Give the campaign's Actions a read/write GITHUB_TOKEN so the claim
			// and submission workflows can maintain the tracking tables. We log in
			// with the full `repo` scope, so this succeeds for repos the user owns;
			// kept non-fatal (warn and continue) in case of org-level restrictions.
			try {
				await setActionsWorkflowPermissions(locals.token, repo.owner.login, repo.name);
			} catch (e) {
				console.warn('Could not set Actions workflow permissions:', e.message);
			}

			// Initialise the campaign (Action A): stamp the score and write the
			// tracking tables into the new repo, in one commit. The repo already
			// exists by now, so if this fails we still report success — flagged so
			// the user knows to retry initialisation rather than re-creating.
			let initWarning = false;
			try {
				const owner = repo.owner.login;
				const template = await waitForRepoContents(
					locals.token,
					owner,
					repo.name,
					'templates/score.template.mei'
				);
				const config = buildCampaignConfig(
					{ title, description, license: license || undefined, composer },
					locals.user.login
				);
				const mei = stampTemplate(template, {
					title: config.campaign.title,
					composer: config.sources[0].header.composer,
					license: config.campaign.license
				});
				await commitFiles(
					locals.token,
					owner,
					repo.name,
					[
						{ path: 'config.yaml', content: configToYaml(config) },
						{ path: 'sources/score.mei', content: mei },
						{ path: 'tracking/state.csv', content: buildStateCsv(config) },
						{ path: 'tracking/locks.csv', content: buildLocksCsv() }
					],
					'Initialise campaign (Action A)'
				);
			} catch (e) {
				console.error('Campaign initialisation failed:', e.message);
				initWarning = true;
			}

			return { success: true, html_url: repo.html_url, full_name: repo.full_name, initWarning };
		} catch (e) {
			console.error('Repo creation failed:', e.message);
			return fail(502, {
				...fields,
				error: 'Could not create the repository. Check the name isn’t already taken, then try again.'
			});
		}
	}
};
