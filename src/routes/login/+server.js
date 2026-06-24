import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// Scopes the app may request. We default to the narrowest (`public_repo`) and
// only ask for `repo` via step-up authorization when a private repo is created.
const ALLOWED_SCOPES = ['public_repo', 'repo'];

// Kicks off the OAuth dance: redirect the browser to GitHub's authorize page
// with a random `state` we store in a cookie to defend against CSRF. The scope
// comes from the caller (validated here) — minimal by default.
export function GET({ cookies, url }) {
	const requestedScope = url.searchParams.get('scope');
	const scope = ALLOWED_SCOPES.includes(requestedScope) ? requestedScope : 'public_repo';

	const state = crypto.randomUUID();
	cookies.set('oauth_state', state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600
	});

	const authorize = new URL('https://github.com/login/oauth/authorize');
	authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
	authorize.searchParams.set('redirect_uri', env.GITHUB_OAUTH_REDIRECT_URI);
	authorize.searchParams.set('scope', scope);
	authorize.searchParams.set('state', state);

	throw redirect(302, authorize.toString());
}
