import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { revokeToken } from '$lib/server/github.js';
import { invalidateUser } from '$lib/server/session.js';

export async function POST({ cookies }) {
	const token = cookies.get('gh_token');
	cookies.delete('gh_token', { path: '/' });

	if (token) {
		invalidateUser(token);
		// Best-effort: revoke the token at GitHub so it can't be reused even if
		// it leaked. Don't block logout if this fails.
		try {
			await revokeToken({
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
				token
			});
		} catch (e) {
			console.warn('Token revocation failed:', e.message);
		}
	}

	throw redirect(303, '/');
}
