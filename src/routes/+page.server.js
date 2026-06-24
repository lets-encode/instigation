import { redirect, fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { searchReposByTopic, createRepoFromTemplate, setRepoTopics } from '$lib/server/github.js';

const REPO_TOPIC = env.REPO_TOPIC || 'created-with-instigation';
const PENDING_COOKIE = 'pending_repo';

// `repo` (full access) is needed for private repos; `public_repo` is not enough.
const hasRepoScope = (scope) => (scope ?? '').split(/[,\s]+/).includes('repo');

export async function load({ locals, cookies, url }) {
	const template = `${env.TEMPLATE_OWNER}/${env.TEMPLATE_REPO}`;
	const canPrivate = hasRepoScope(locals.scope);

	// 'private' = declined the extra access needed for a private repo;
	// 'login'   = declined the initial login. null otherwise.
	const denied = url.searchParams.get('denied');

	// Restore the repo the user was creating before we sent them to GitHub —
	// either to finish (resume) or to retry/switch after declining (denied).
	let pending = null;
	const stash = cookies.get(PENDING_COOKIE);
	if ((url.searchParams.get('resume') || denied === 'private') && stash) {
		try {
			pending = JSON.parse(stash);
		} catch {
			pending = null;
		}
	}

	try {
		// With a token: all public matches + the user's own private matches.
		// Without: public matches only.
		const repos = await searchReposByTopic(REPO_TOPIC, locals.token);
		return { repos, listError: null, template, canPrivate, pending, denied };
	} catch (e) {
		console.error('Repo listing failed:', e.message);
		return {
			repos: [],
			listError: 'Could not load the repository list right now.',
			template,
			canPrivate,
			pending,
			denied
		};
	}
}

export const actions = {
	create: async ({ request, locals, cookies, url }) => {
		if (!locals.user) throw redirect(302, '/');

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const description = String(form.get('description') ?? '').trim();
		const isPrivate = form.get('visibility') === 'private';

		// GitHub repo name rules: letters, digits, -, _.
		if (!name) return fail(400, { name, description, isPrivate, error: 'Repository name is required.' });
		if (!/^[A-Za-z0-9_-]+$/.test(name)) {
			return fail(400, {
				name,
				description,
				isPrivate,
				error: 'Name may only contain letters, numbers, hyphens and underscores.'
			});
		}

		// Least privilege: only ask GitHub for private-repo access at the moment
		// it's actually needed. Stash the form and tell the client to send the
		// user through a step-up authorization; we'll resume on the way back.
		if (isPrivate && !hasRepoScope(locals.scope)) {
			cookies.set(PENDING_COOKIE, JSON.stringify({ name, description, isPrivate }), {
				path: '/',
				httpOnly: true,
				sameSite: 'lax',
				secure: url.protocol === 'https:',
				maxAge: 600
			});
			return { escalate: true };
		}

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

			cookies.delete(PENDING_COOKIE, { path: '/' });
			return { success: true, html_url: repo.html_url, full_name: repo.full_name };
		} catch (e) {
			console.error('Repo creation failed:', e.message);
			return fail(502, {
				name,
				description,
				isPrivate,
				error: 'Could not create the repository. Check the name is available and that you granted enough access, then try again.'
			});
		}
	}
};
