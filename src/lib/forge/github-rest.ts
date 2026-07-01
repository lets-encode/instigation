// GitHub REST adapter — the raw calls behind the ForgeClient interface (and the
// scripts run by the campaign automation). Every function takes an access token
// explicitly; no client secret lives here — the OAuth code→token exchange is the
// broker's job. Browser- and Node-safe (fetch / atob / TextDecoder, no Buffer).

const API = 'https://api.github.com';

const baseHeaders: Record<string, string> = {
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2022-11-28'
};

// Decode GitHub's base64 file content to a UTF-8 string without Node's Buffer, so
// this runs in the browser too. GitHub wraps the base64 in newlines — strip
// whitespace before decoding.
function decodeBase64Utf8(b64: string): string {
	const binary = atob(b64.replace(/\s/g, ''));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/** A text file to commit: a repo-relative path and its UTF-8 string content. */
export interface FileChange {
	path: string;
	content: string;
}

/** The authenticated GitHub user, as far as this app reads it. */
export interface GitHubUser {
	login: string;
	name: string | null;
	avatar_url: string;
}

/** A repo as returned by the create/read endpoints (fields this app reads). */
export interface RepoData {
	html_url: string;
	full_name: string;
	name: string;
	owner: { login: string };
	default_branch: string;
	permissions?: { push?: boolean };
	private: boolean;
	message?: string;
	errors?: Array<{ message?: string; code?: string }>;
}

/** A repo summary for the listing page. */
export interface RepoSummary {
	full_name: string;
	name: string;
	owner: string | undefined;
	html_url: string;
	private: boolean;
	description: string | null;
	updated_at: string;
}

interface ErrorResponse {
	message?: string;
}

/**
 * Fetch the authenticated user along with the scopes the token actually holds.
 * `X-OAuth-Scopes` is the live source of truth for what the token can do.
 * Returns null if invalid.
 */
export async function getAuthenticatedUser(
	token: string
): Promise<{ user: GitHubUser; scopes: string } | null> {
	const res = await fetch(`${API}/user`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	if (!res.ok) return null;
	const user: GitHubUser = await res.json();
	const scopes = res.headers.get('X-OAuth-Scopes') ?? '';
	return { user, scopes };
}

/**
 * Create a new repo from a template via the "generate" endpoint.
 * https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template
 */
export async function createRepoFromTemplate(
	token: string,
	{
		templateOwner,
		templateRepo,
		name,
		description,
		isPrivate,
		owner
	}: {
		templateOwner: string;
		templateRepo: string;
		name: string;
		description: string;
		isPrivate: boolean;
		owner: string;
	}
): Promise<RepoData> {
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
	const data: RepoData = await res.json();
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
export async function getRepoFile(
	token: string,
	owner: string,
	repo: string,
	path: string,
	ref?: string
): Promise<string | null> {
	const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${path}${query}`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	if (res.status === 404) return null;
	const data: { content?: string; message?: string } = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.message || `Failed to fetch ${path}`);
	return decodeBase64Utf8(data.content ?? '');
}

/**
 * Get a temporary direct-download URL for a repo file (the Contents API's
 * `download_url`). For PRIVATE repos this is a raw.githubusercontent.com URL
 * with a short-lived `token` embedded, so it can be fetched without auth headers
 * — e.g. handed to an external viewer like mei-friend via `?file=`. The token
 * expires within minutes, so use it promptly. Returns null if absent.
 */
export async function getRepoFileDownloadUrl(
	token: string,
	owner: string,
	repo: string,
	path: string,
	ref?: string
): Promise<string | null> {
	const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${path}${query}`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	if (res.status === 404) return null;
	const data: { download_url?: string | null; message?: string } = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.message || `Failed to fetch ${path}`);
	return data.download_url ?? null;
}

/**
 * Read a repo's default branch, its current head commit SHA, and whether the
 * authenticated user can push to it (drives the same-repo vs. fork PR path).
 */
export async function getRepoHead(
	token: string,
	owner: string,
	repo: string
): Promise<{ branch: string; sha: string; canPush: boolean }> {
	const headers = { ...baseHeaders, Authorization: `Bearer ${token}` };
	const repoRes = await fetch(`${API}/repos/${owner}/${repo}`, { headers });
	const repoData: RepoData = await repoRes.json().catch(() => ({}));
	if (!repoRes.ok) throw new Error(`${repoData.message || 'Failed to read repository'} (${repoRes.status} GET repo)`);
	const branch = repoData.default_branch;
	const refRes = await fetch(`${API}/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers });
	const refData: { object: { sha: string }; message?: string } = await refRes.json().catch(() => ({}));
	if (!refRes.ok) throw new Error(`${refData.message || 'Failed to read branch ref'} (${refRes.status} GET ref heads/${branch})`);
	return { branch, sha: refData.object.sha, canPush: Boolean(repoData.permissions?.push) };
}

/**
 * Ensure the authenticated user has a fork of `owner/repo`, waiting until it's
 * ready (forking is async). Returns the fork's { owner, repo }. Used when a
 * volunteer without push access proposes work — they fork and PR upstream.
 */
export async function ensureFork(
	token: string,
	owner: string,
	repo: string,
	{ attempts = 20, delayMs = 1500 }: { attempts?: number; delayMs?: number } = {}
): Promise<{ owner: string; repo: string }> {
	const headers = { ...baseHeaders, Authorization: `Bearer ${token}` };
	const res = await fetch(`${API}/repos/${owner}/${repo}/forks`, { method: 'POST', headers });
	const data: { full_name: string; default_branch: string; message?: string } = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${data.message || 'Failed to fork repository'} (${res.status} POST forks)`);

	const [forkOwner, forkRepo] = data.full_name.split('/');
	// Poll until the fork's default branch ref exists (the fork is populated).
	for (let i = 0; i < attempts; i++) {
		const r = await fetch(`${API}/repos/${forkOwner}/${forkRepo}/git/ref/heads/${data.default_branch}`, { headers });
		if (r.ok) return { owner: forkOwner, repo: forkRepo };
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error(`Fork ${forkOwner}/${forkRepo} was not ready in time.`);
}

/** Whether the repo is private (its raw download URLs then carry a short-lived token). */
export async function getRepoIsPrivate(token: string, owner: string, repo: string): Promise<boolean> {
	const res = await fetch(`${API}/repos/${owner}/${repo}`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	const data: RepoData = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.message || 'Failed to read repository');
	return Boolean(data.private);
}

/** List a pull request's changed files, including each file's unified-diff patch. */
export async function getPullRequestFiles(
	token: string,
	owner: string,
	repo: string,
	number: number
): Promise<Array<{ filename: string; status: string; patch?: string }>> {
	const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`, {
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	const data = await res.json().catch(() => []);
	if (!res.ok) throw new Error((data as ErrorResponse).message || 'Failed to list pull request files');
	return (data as Array<{ filename: string; status: string; patch?: string }>).map((f) => ({
		filename: f.filename,
		status: f.status,
		patch: f.patch
	}));
}

/** Post a comment on a pull request and then close it (used to resolve claims). */
export async function commentAndClosePr(
	token: string,
	owner: string,
	repo: string,
	number: number,
	body: string
): Promise<void> {
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
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to close pull request');
	}
}

/**
 * Poll until a path appears in the repo, returning its content. The `generate`
 * endpoint returns before the new repo's contents are guaranteed present, so
 * the init commit must wait for them. Throws if the path never appears.
 */
export async function waitForRepoContents(
	token: string,
	owner: string,
	repo: string,
	path: string,
	{ attempts = 10, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {}
): Promise<string> {
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
 * tracking tables. Omit it to commit on the current branch head. Pass
 * `opts.branch` to target a branch other than the repo default (e.g. a feature
 * branch being prepared for a pull request).
 * https://docs.github.com/en/rest/git
 */
export async function commitFiles(
	token: string,
	owner: string,
	repo: string,
	files: FileChange[],
	message: string,
	{ baseSha, branch }: { baseSha?: string; branch?: string } = {}
): Promise<string> {
	const headers = { ...baseHeaders, Authorization: `Bearer ${token}` };
	const api = `${API}/repos/${owner}/${repo}`;

	const gh = async <T>(path: string, init?: RequestInit): Promise<T> => {
		const res = await fetch(`${api}${path}`, { headers, ...init });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`${(data as ErrorResponse).message || 'GitHub API error'} (${res.status} ${init?.method ?? 'GET'} ${path})`);
		return data as T;
	};

	// Resolve the target branch and the parent commit to build on.
	const targetBranch = branch ?? (await gh<{ default_branch: string }>('')).default_branch;
	let headSha = baseSha;
	if (!headSha) {
		const ref = await gh<{ object: { sha: string } }>(`/git/ref/heads/${targetBranch}`);
		headSha = ref.object.sha;
	}
	const headCommit = await gh<{ tree: { sha: string } }>(`/git/commits/${headSha}`);

	// Build a tree off the current one, with our files as inline blobs.
	const tree = await gh<{ sha: string }>('/git/trees', {
		method: 'POST',
		body: JSON.stringify({
			base_tree: headCommit.tree.sha,
			tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content }))
		})
	});

	const commit = await gh<{ sha: string }>('/git/commits', {
		method: 'POST',
		body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] })
	});

	await gh(`/git/refs/heads/${targetBranch}`, {
		method: 'PATCH',
		body: JSON.stringify({ sha: commit.sha })
	});

	return commit.sha;
}

/** Create a new branch `branch` pointing at `fromSha`. */
export async function createBranch(
	token: string,
	owner: string,
	repo: string,
	branch: string,
	fromSha: string
): Promise<void> {
	const res = await fetch(`${API}/repos/${owner}/${repo}/git/refs`, {
		method: 'POST',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha })
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(`${data.message || 'Failed to create branch'} (${res.status} POST git/refs)`);
	}
}

/** Delete a branch. Treats an already-gone ref (404/422) as success. */
export async function deleteBranch(token: string, owner: string, repo: string, branch: string): Promise<void> {
	const res = await fetch(`${API}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
		method: 'DELETE',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` }
	});
	if (!res.ok && res.status !== 404 && res.status !== 422) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(`${data.message || 'Failed to delete branch'} (${res.status} DELETE ref heads/${branch})`);
	}
}

/** Open a pull request. Returns { number, html_url }. */
export async function createPullRequest(
	token: string,
	owner: string,
	repo: string,
	{ title, head, base, body }: { title: string; head: string; base: string; body: string }
): Promise<{ number: number; html_url: string }> {
	const res = await fetch(`${API}/repos/${owner}/${repo}/pulls`, {
		method: 'POST',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({ title, head, base, body })
	});
	const data: { number: number; html_url: string; message?: string } = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${data.message || 'Failed to open pull request'} (${res.status} POST pulls)`);
	return { number: data.number, html_url: data.html_url };
}

/**
 * Commit `files` onto a fresh branch and open a pull request to `owner/repo`
 * from it — the way the campaign console stands in for a volunteer client (its
 * PR triggers the claim/submission Actions). Returns { number, html_url }.
 *
 * If the user can push to the repo (owner/collaborator) the branch is made in
 * the repo itself. Otherwise the user's fork is used and a cross-repo PR is
 * opened upstream — the real volunteer model. Either way the branch is based on
 * the upstream head, so the PR diff is only the change in `files`.
 */
export async function openChangePr(
	token: string,
	owner: string,
	repo: string,
	{ branch, files, message, title, body }: { branch: string; files: FileChange[]; message: string; title: string; body: string }
): Promise<{ number: number; html_url: string }> {
	const { branch: base, sha, canPush } = await getRepoHead(token, owner, repo);
	const target = canPush ? { owner, repo } : await ensureFork(token, owner, repo);

	await createBranch(token, target.owner, target.repo, branch, sha);
	await commitFiles(token, target.owner, target.repo, files, message, { baseSha: sha, branch });

	const head = canPush ? branch : `${target.owner}:${branch}`;
	return createPullRequest(token, owner, repo, { title, head, base, body });
}

/** Manually trigger a workflow_dispatch run of `workflow` (a filename) on `ref`. */
export async function dispatchWorkflow(
	token: string,
	owner: string,
	repo: string,
	workflow: string,
	ref: string
): Promise<void> {
	const res = await fetch(`${API}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
		method: 'POST',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({ ref })
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to dispatch workflow');
	}
}

/** Replace a repo's topics — used to tag repos created through this app. */
export async function setRepoTopics(
	token: string,
	owner: string,
	repo: string,
	names: string[]
): Promise<unknown> {
	const res = await fetch(`${API}/repos/${owner}/${repo}/topics`, {
		method: 'PUT',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({ names })
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to set topics');
	}
	return res.json();
}

/**
 * Set the repo's default GITHUB_TOKEN permissions for workflows to read/write,
 * so the campaign Actions (which commit the tracking tables and resolve
 * claim/submission PRs) have the access they need. Requires admin on the repo.
 */
export async function setActionsWorkflowPermissions(token: string, owner: string, repo: string): Promise<void> {
	const res = await fetch(`${API}/repos/${owner}/${repo}/actions/permissions/workflow`, {
		method: 'PUT',
		headers: { ...baseHeaders, Authorization: `Bearer ${token}` },
		body: JSON.stringify({ default_workflow_permissions: 'write' })
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to set workflow permissions');
	}
}

/**
 * List repos tagged with `topic`. With the user's `repo`-scoped token, GitHub's
 * search returns matching public repos plus the user's own private matches.
 * Visibility always reflects GitHub's current state.
 */
export async function searchReposByTopic(topic: string, token?: string): Promise<RepoSummary[]> {
	const q = encodeURIComponent(`topic:${topic}`);
	const headers: Record<string, string> = { ...baseHeaders };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(`${API}/search/repositories?q=${q}&sort=updated&order=desc&per_page=100`, {
		headers
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Repo search failed');
	}
	const data: {
		items?: Array<{
			full_name: string;
			name: string;
			owner?: { login: string };
			html_url: string;
			private: boolean;
			description: string | null;
			updated_at: string;
		}>;
	} = await res.json();
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
