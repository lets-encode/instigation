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
 * `X-OAuth-Scopes` is the live source of truth for what the token can do.
 * Returns null if invalid.
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

/**
 * Fetch and decode a UTF-8 text file from a repo. Returns the file's content as
 * a string, or null if it doesn't exist yet (404).
 */
export async function getRepoFile(token, owner, repo, path, ref) {
	const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${path}${query}`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	if (res.status === 404) return null;
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.message || `Failed to fetch ${path}`);
	return Buffer.from(data.content ?? '', 'base64').toString('utf8');
}

/** Read a repo's default branch and its current head commit SHA. */
export async function getRepoHead(token, owner, repo) {
	const headers = { ...baseHeaders, Authorization: `Bearer ${token}` };
	const repoRes = await fetch(`${API}/repos/${owner}/${repo}`, { headers });
	const repoData = await repoRes.json().catch(() => ({}));
	if (!repoRes.ok) throw new Error(repoData.message || 'Failed to read repository');
	const branch = repoData.default_branch;
	const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers });
	const refData = await refRes.json().catch(() => ({}));
	if (!refRes.ok) throw new Error(refData.message || 'Failed to read branch ref');
	return { branch, sha: refData.object.sha };
}

/** List a pull request's changed files, including each file's unified-diff patch. */
export async function getPullRequestFiles(token, owner, repo, number) {
	const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	const data = await res.json().catch(() => []);
	if (!res.ok) throw new Error(data.message || 'Failed to list pull request files');
	return data.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch }));
}

/** Post a comment on a pull request and then close it (used to resolve claims). */
export async function commentAndClosePr(token, owner, repo, number, body) {
	const headers = { ...baseHeaders, Authorization: `Bearer ${token}` };
	await fetch(`${API}/repos/${owner}/${repo}/issues/${number}/comments`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ body })
	});
	const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
		method: 'PATCH',
		headers,
		body: JSON.stringify({ state: 'closed' })
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to close pull request');
	}
}

/**
 * Poll until a path appears in the repo, returning its content. The `generate`
 * endpoint returns before the new repo's contents are guaranteed present, so
 * the init commit must wait for them. Throws if the path never appears.
 */
export async function waitForRepoContents(token, owner, repo, path, { attempts = 10, delayMs = 1000 } = {}) {
	for (let i = 0; i < attempts; i++) {
		const content = await getRepoFile(token, owner, repo, path);
		if (content !== null) return content;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error(`Timed out waiting for ${path} to appear in ${owner}/${repo}.`);
}

/**
 * Commit several text files to a repo in a single commit via the Git Data API,
 * so files land atomically with one clean diff. `files` is an array of
 * { path, content } with UTF-8 string content. Returns the new commit SHA.
 *
 * Pass `opts.baseSha` to commit on a specific parent: the ref update is
 * non-forced, so if the branch has moved past `baseSha` (a concurrent change)
 * the update fails rather than clobbering it — optimistic concurrency for the
 * tracking tables. Omit it to commit on the current branch head.
 * https://docs.github.com/en/rest/git
 */
export async function commitFiles(token, owner, repo, files, message, { baseSha } = {}) {
	const headers = { ...baseHeaders, Authorization: `Bearer ${token}` };
	const api = `${API}/repos/${owner}/${repo}`;

	const gh = async (path, init) => {
		const res = await fetch(`${api}${path}`, { headers, ...init });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.message || `GitHub API error on ${path}`);
		return data;
	};

	// Resolve the default branch, and the parent commit to build on.
	const { default_branch: branch } = await gh('');
	let headSha = baseSha;
	if (!headSha) {
		const ref = await gh(`/git/ref/heads/${branch}`);
		headSha = ref.object.sha;
	}
	const headCommit = await gh(`/git/commits/${headSha}`);

	// Build a tree off the current one, with our files as inline blobs.
	const tree = await gh('/git/trees', {
		method: 'POST',
		body: JSON.stringify({
			base_tree: headCommit.tree.sha,
			tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }))
		})
	});

	const commit = await gh('/git/commits', {
		method: 'POST',
		body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] })
	});

	await gh(`/git/refs/heads/${branch}`, {
		method: 'PATCH',
		body: JSON.stringify({ sha: commit.sha })
	});

	return commit.sha;
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
 * Set the repo's default GITHUB_TOKEN permissions for workflows to read/write,
 * so the campaign Actions (which commit the tracking tables and resolve
 * claim/submission PRs) have the access they need. Requires admin on the repo.
 */
export async function setActionsWorkflowPermissions(token, owner, repo) {
	const res = await fetch(`${API}/repos/${owner}/${repo}/actions/permissions/workflow`, {
		method: 'PUT',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({ default_workflow_permissions: 'write' })
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to set workflow permissions');
	}
}

/**
 * List repos tagged with `topic`. With the user's `repo`-scoped token, GitHub's
 * search returns matching public repos plus the user's own private matches.
 * Visibility always reflects GitHub's current state.
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
