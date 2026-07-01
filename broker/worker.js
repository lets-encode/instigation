// Stateless OAuth token broker for the instigation SPA.
//
// The browser can't complete GitHub's OAuth flow itself: the code→token exchange
// needs the client secret, and GitHub's token endpoint sends no CORS headers. This
// worker does only those two things — swap a code for a token, and revoke a token
// on logout — holding the client secret. No storage, no sessions, no user data.
//
// Deploy anywhere that runs a fetch handler (Cloudflare Workers, Deno Deploy, …).
// Config (as secrets/vars): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_ORIGIN
// (the SPA's origin, or * to allow any).

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API = 'https://api.github.com';

export default {
	async fetch(request, env) {
		const headers = {
			'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
			Vary: 'Origin',
			'Content-Type': 'application/json'
		};
		if (request.method === 'OPTIONS') return new Response(null, { headers });

		const { pathname } = new URL(request.url);
		const body = await request.json().catch(() => ({}));

		if (request.method === 'POST' && pathname === '/token') {
			if (!body.code) return json({ error: 'missing_code' }, 400, headers);
			const res = await fetch(GITHUB_TOKEN_URL, {
				method: 'POST',
				headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
				body: JSON.stringify({
					client_id: env.GITHUB_CLIENT_ID,
					client_secret: env.GITHUB_CLIENT_SECRET,
					code: body.code,
					redirect_uri: body.redirect_uri
				})
			});
			const data = await res.json().catch(() => ({}));
			if (data.error || !data.access_token) {
				return json({ error: data.error_description || data.error || 'exchange_failed' }, 502, headers);
			}
			return json({ access_token: data.access_token, scope: data.scope ?? '' }, 200, headers);
		}

		if (request.method === 'POST' && pathname === '/revoke') {
			if (!body.token) return json({ error: 'missing_token' }, 400, headers);
			const basic = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
			const res = await fetch(`${GITHUB_API}/applications/${env.GITHUB_CLIENT_ID}/token`, {
				method: 'DELETE',
				headers: {
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
					Authorization: `Basic ${basic}`
				},
				body: JSON.stringify({ access_token: body.token })
			});
			return json({ ok: res.ok || res.status === 404 }, 200, headers);
		}

		return json({ error: 'not_found' }, 404, headers);
	}
};

function json(payload, status, headers) {
	return new Response(JSON.stringify(payload), { status, headers });
}
