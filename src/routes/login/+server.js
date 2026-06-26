import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

// We request the full `repo` scope: the app needs admin on the repos it creates,
// e.g. to set Actions workflow permissions so the campaign automation
// (claim/submission workflows) can run.
const SCOPE = 'repo';

// Kicks off the OAuth dance: redirect the browser to GitHub's authorize page
// with a random `state` we store in a cookie to defend against CSRF.
export function GET({ cookies, url }) {
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
	authorize.searchParams.set('scope', SCOPE);
	authorize.searchParams.set('state', state);

	throw redirect(302, authorize.toString());
}
