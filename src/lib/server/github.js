// Thin wrapper around the GitHub REST API. Server-only: never import this
// into client code, since it deals with access tokens.

const API = 'https://api.github.com';

const baseHeaders = {
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2022-11-28'
};

/** Exchange an OAuth authorization code for an access token. */
export async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri }) {
	const res = await fetch('https://github.com/login/oauth/access_token', {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
		body: JSON.stringify({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: redirectUri
		})
	});
	const data = await res.json();
	if (data.error || !data.access_token) {
		throw new Error(data.error_description || data.error || 'Token exchange failed');
	}
	return data.access_token;
}

/**
 * Revoke an OAuth access token so it stops working after logout.
 * Authenticated with the app's client_id/client_secret (Basic auth), not the
 * user token itself. Returns true on success (204) or if already invalid (404).
 * https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token
 */
export async function revokeToken({ clientId, clientSecret, token }) {
	const res = await fetch(`${API}/applications/${clientId}/token`, {
		method: 'DELETE',
		headers: {
			...baseHeaders,
			Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`
		},
		body: JSON.stringify({ access_token: token })
	});
	return res.ok || res.status === 404;
}

/**
 * Fetch the authenticated user along with the scopes the token actually holds.
 * `X-OAuth-Scopes` is the live source of truth for what the token can do (it
 * reflects scopes added via step-up authorization). Returns null if invalid.
 */
export async function getAuthenticatedUser(token) {
	const res = await fetch(`${API}/user`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	if (!res.ok) return null;
	const user = await res.json();
	const scopes = res.headers.get('X-OAuth-Scopes') ?? '';
	return { user, scopes };
}

/**
 * Create a new repo from a template via the "generate" endpoint.
 * https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template
 */
export async function createRepoFromTemplate(token, { templateOwner, templateRepo, name, description, isPrivate, owner }) {
	const res = await fetch(`${API}/repos/${templateOwner}/${templateRepo}/generate`, {
		method: 'POST',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({
			owner, // account/org the new repo is created under
			name,
			description,
			private: isPrivate,
			include_all_branches: false
		})
	});
	const data = await res.json();
	if (!res.ok) {
		const message = data.message || 'Failed to create repository';
		const detail = Array.isArray(data.errors) ? `: ${data.errors.map((e) => e.message || e.code).join(', ')}` : '';
		throw new Error(message + detail);
	}
	return data; // includes html_url, full_name, etc.
}

/** Replace a repo's topics — used to tag repos created through this app. */
export async function setRepoTopics(token, owner, repo, names) {
	const res = await fetch(`${API}/repos/${owner}/${repo}/topics`, {
		method: 'PUT',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({ names })
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to set topics');
	}
	return res.json();
}

/**
 * List repos tagged with `topic`. With a token, GitHub's search returns all
 * matching PUBLIC repos plus the calling user's own PRIVATE matches; without a
 * token, only public ones. Visibility always reflects GitHub's current state.
 */
export async function searchReposByTopic(topic, token) {
	const q = encodeURIComponent(`topic:${topic}`);
	const headers = { ...baseHeaders };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${API}/search/repositories?q=${q}&sort=updated&order=desc&per_page=100`, {
		headers
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Repo search failed');
	}
	const data = await res.json();
	return (data.items || []).map((r) => ({
		full_name: r.full_name,
		name: r.name,
		owner: r.owner?.login,
		html_url: r.html_url,
		private: r.private,
		description: r.description,
		updated_at: r.updated_at
	}));
}
