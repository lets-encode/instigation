import { resolveUser } from '$lib/server/session.js';

// On every request, resolve the logged-in user from the session cookie so
// that pages and actions can read `event.locals.user`. Backed by a short-lived
// cache so we don't call GitHub's /user endpoint on every request.
export async function handle({ event, resolve }) {
	const token = event.cookies.get('gh_token');
	if (token) {
		const resolved = await resolveUser(token);
		if (resolved) {
			const { user, scopes } = resolved;
			event.locals.token = token;
			event.locals.scope = scopes;
			event.locals.user = { login: user.login, name: user.name, avatar_url: user.avatar_url };
		} else {
			// Token no longer valid — clear it.
			event.cookies.delete('gh_token', { path: '/' });
		}
	}
	return resolve(event);
}
