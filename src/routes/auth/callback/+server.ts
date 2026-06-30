import { redirect, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { exchangeCodeForToken } from '$lib/server/github.js';
import type { RequestHandler } from './$types';

// GitHub redirects back here with ?code & ?state. We verify state, swap the
// code for an access token, and stash the token in an httpOnly cookie.
export const GET: RequestHandler = async ({ url, cookies }) => {
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const errorParam = url.searchParams.get('error');
	const expectedState = cookies.get('oauth_state');

	cookies.delete('oauth_state', { path: '/' });

	// User clicked "Cancel" on GitHub's consent screen (or GitHub returned an
	// error) instead of authorizing. Send them back with a reason.
	if (errorParam) {
		throw redirect(303, '/?denied=login');
	}

	if (!code || !state || state !== expectedState) {
		throw error(400, 'Invalid OAuth state. Please try logging in again.');
	}

	let token: string;
	try {
		token = await exchangeCodeForToken({
			clientId: env.GITHUB_CLIENT_ID,
			clientSecret: env.GITHUB_CLIENT_SECRET,
			code,
			redirectUri: env.GITHUB_OAUTH_REDIRECT_URI
		});
	} catch (e) {
		console.error('GitHub token exchange failed:', (e as Error).message);
		throw error(502, 'GitHub login failed. Please try again.');
	}

	cookies.set('gh_token', token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 60 * 60 * 8
	});

	throw redirect(302, '/');
};
