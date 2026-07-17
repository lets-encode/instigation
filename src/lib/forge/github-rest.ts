// GitHub REST adapter — the raw calls behind the ForgeClient interface (and the
// scripts run by the campaign automation). Every function takes an access token
// explicitly; no client secret lives here. In the browser the real OAuth token
// never exists: pass the SESSION sentinel instead and calls are routed through
// the broker's /proxy, which attaches the token server-side from the session
// cookie. A real token (CI scripts) or no token (anonymous public reads) goes
// straight to the API. Browser- and Node-safe (fetch / atob / TextDecoder).

const API = 'https://api.github.com';

/**
 * Token sentinel: authenticate via the broker session instead of a bearer
 * token. Requests are sent to the base registered with routeSessionVia() and
 * carry the (same-origin, httpOnly) session cookie; no Authorization header.
 */
export const SESSION = '@session';

let sessionApiBase: string | null = null;

/** Register the broker proxy base (e.g. `/oauth/proxy/api.github.com`) that SESSION calls go to. */
export function routeSessionVia(base: string): void {
	sessionApiBase = base;
}

function apiRoot(token?: string): string {
	if (token === SESSION) {
		if (!sessionApiBase) throw new Error('SESSION used before routeSessionVia() was called.');
		return sessionApiBase;
	}
	return API;
}

function authHeaders(token?: string): Record<string, string> {
	return token && token !== SESSION ? { Authorization: `Bearer ${token}` } : {};
}

const baseHeaders: Record<string, string> = {
	Accept: 'application/vnd.github+json',
	'X-GitHub-Api-Version': '2022-11-28'
};

// All GETs pass `cache: 'no-store'`: the API responds with
// `Cache-Control: max-age=60`, which would otherwise let the browser serve a
// stale cached response (e.g. an early 404 right after a ref was created, or
// an open PR that has since closed) to the polls and retries this app relies
// on. In runtimes without an HTTP cache (Node) the option is a no-op.
//
// Freshness is instead kept by conditional requests: ghGet() remembers each
// URL's ETag and sends `If-None-Match` on the next read. An unchanged resource
// answers 304 Not Modified — served from the remembered body, and NOT counted
// against the API rate limit — so repeated reads and "nothing changed yet"
// polls are free. The store lives in the app, not in any HTTP cache, so
// `no-store` still holds and no shared cache is involved.

/**
 * Thrown when GitHub reports the request rate limit is exhausted (HTTP 403/429
 * with no remaining quota). Carries the reset time so callers can tell the user
 * when to retry.
 */
export class RateLimitError extends Error {
	/** Unix epoch seconds when the limit resets, or null if not reported. */
	readonly resetAt: number | null;
	readonly retryAfterSeconds: number | null;
	constructor(resetAt: number | null, retryAfterSeconds: number | null) {
		const when = retryAfterSeconds
			? `in about ${retryAfterSeconds} seconds`
			: resetAt
				? `at ${new Date(resetAt * 1000).toLocaleTimeString()}`
				: 'shortly';
		super(`GitHub API rate limit exceeded — retry ${when}.`);
		this.name = 'RateLimitError';
		this.resetAt = resetAt;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

async function githubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const res = await fetch(input, init);
	if (res.status !== 403 && res.status !== 429) return res;
	const remaining = res.headers.get('X-RateLimit-Remaining');
	const retryAfterHeader = res.headers.get('Retry-After');
	const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
	const message = await res.clone().text().catch(() => '');
	const limited =
		remaining === '0' ||
		Number.isFinite(retryAfter) ||
		/secondary rate limit|rate limit exceeded|abuse detection/i.test(message);
	if (!limited) return res;
	const resetHeader = res.headers.get('X-RateLimit-Reset');
	const reset = resetHeader == null ? Number.NaN : Number(resetHeader);
	throw new RateLimitError(
		Number.isFinite(reset) && reset > 0 ? reset : null,
		Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null
	);
}

// ETag store for conditional GETs, keyed by full request URL. Only cacheable
// JSON GETs add entries; it grows with the number of distinct URLs read in a
// session. Never used for responses whose bodies carry short-lived tokens (see
// getRepoFileDownloadUrl / getDirDownloadUrls), which pass `cache: false`.
const etagCache = new Map<string, { etag: string; body: string }>();

/**
 * A GitHub JSON GET with ETag conditional-request caching and rate-limit
 * detection. On 304 the remembered body is returned (status normalised to 200);
 * on a fresh 200 the response ETag and body are stored. Throws RateLimitError
 * when the quota is exhausted. Returns the HTTP status and parsed JSON (null on
 * an empty or non-JSON body). Pass `cache: false` to skip the ETag store while
 * keeping the rate-limit guard.
 */
async function ghGet<T>(
	url: string,
	token?: string,
	{ cache = true }: { cache?: boolean } = {}
): Promise<{ status: number; ok: boolean; data: T }> {
	const cached = cache ? etagCache.get(url) : undefined;
	const headers: Record<string, string> = { ...baseHeaders, ...authHeaders(token) };
	if (cached) headers['If-None-Match'] = cached.etag;
	const res = await githubFetch(url, { headers, cache: 'no-store' });
	if (res.status === 304 && cached) return { status: 200, ok: true, data: JSON.parse(cached.body) as T };
	const text = await res.text();
	const etag = res.headers.get('ETag');
	if (cache && res.ok && etag) etagCache.set(url, { etag, body: text });
	else if (res.status === 404) etagCache.delete(url);
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = null;
	}
	return { status: res.status, ok: res.ok, data: data as T };
}

// Decode GitHub's base64 file content to a UTF-8 string without Node's Buffer, so
// this runs in the browser too. GitHub wraps the base64 in newlines — strip
// whitespace before decoding.
function decodeBase64Utf8(b64: string): string {
	const binary = atob(b64.replace(/\s/g, ''));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/**
 * A file to commit at a repo-relative path. Provide `content` for UTF-8 text, or
 * `contentBase64` for binary (e.g. images) — binary files are uploaded as blobs
 * first, since the tree API only takes text inline. Exactly one must be set.
 */
export interface FileChange {
	path: string;
	content?: string;
	contentBase64?: string;
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
	const res = await githubFetch(`${apiRoot(token)}/user`, {
		headers: { ...baseHeaders, ...authHeaders(token) },
		cache: 'no-store'
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
	const res = await githubFetch(`${apiRoot(token)}/repos/${templateOwner}/${templateRepo}/generate`, {
		method: 'POST',
		headers: { ...baseHeaders, ...authHeaders(token) },
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
	const { status, ok, data } = await ghGet<{ content?: string; message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/contents/${path}${query}`,
		token
	);
	if (status === 404) return null;
	if (!ok) throw new Error(data?.message || `Failed to fetch ${path}`);
	return decodeBase64Utf8(data?.content ?? '');
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
	// Not ETag-cached: for private repos the download_url carries a short-lived
	// token, so a 304-served body would hand back an expired URL.
	const { status, ok, data } = await ghGet<{ download_url?: string | null; message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/contents/${path}${query}`,
		token,
		{ cache: false }
	);
	if (status === 404) {
		console.log('[getRepoFileDownloadUrl] path or ref absent', { owner, repo, path, ref });
		return null;
	}
	if (!ok) throw new Error(data?.message || `Failed to fetch ${path}`);
	console.log('[getRepoFileDownloadUrl] temporary URL available', { path, ref: ref ?? '(default)', status });
	return data?.download_url ?? null;
}

/**
 * List a repo directory's files with each file's temporary download URL, in a
 * single Contents API call — so a facsimile's page images resolve with one
 * request instead of one per image. URLs are tokenised for private repos (see
 * getRepoFileDownloadUrl); use them promptly. Returns a map of file name →
 * download URL (files without one are omitted); empty if the directory is
 * absent.
 */
export async function getDirDownloadUrls(
	token: string,
	owner: string,
	repo: string,
	dir: string,
	ref?: string
): Promise<Record<string, string>> {
	const cleanDir = dir.replace(/\/+$/, '');
	const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	// Not ETag-cached: the per-file download_url values carry short-lived tokens.
	const { status, ok, data } = await ghGet<Array<{ name: string; download_url?: string | null }> & ErrorResponse>(
		`${apiRoot(token)}/repos/${owner}/${repo}/contents/${cleanDir}${query}`,
		token,
		{ cache: false }
	);
	if (status === 404) return {};
	if (!ok) throw new Error(data?.message || `Failed to list ${dir}`);
	const urls: Record<string, string> = {};
	for (const file of Array.isArray(data) ? data : []) {
		if (file.download_url) urls[file.name] = file.download_url;
	}
	return urls;
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
	const headers = { ...baseHeaders, ...authHeaders(token) };
	const repoRes = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}`, { headers, cache: 'no-store' });
	const repoData: RepoData = await repoRes.json().catch(() => ({}));
	if (!repoRes.ok) throw new Error(`${repoData.message || 'Failed to read repository'} (${repoRes.status} GET repo)`);
	const branch = repoData.default_branch;
	const refRes = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/git/ref/heads/${branch}`, { headers, cache: 'no-store' });
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
	const headers = { ...baseHeaders, ...authHeaders(token) };
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/forks`, {
		method: 'POST',
		headers,
		// Only the default branch — the fork doesn't need copies of upstream's
		// in-flight claim branches.
		body: JSON.stringify({ default_branch_only: true })
	});
	const data: { full_name: string; default_branch: string; message?: string } = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${data.message || 'Failed to fork repository'} (${res.status} POST forks)`);
	if (!data.full_name?.includes('/') || !data.default_branch) {
		throw new Error('GitHub returned an invalid fork description.');
	}

	const [forkOwner, forkRepo] = data.full_name.split('/');
	// Poll until the fork's default branch ref exists (the fork is populated).
	for (let i = 0; i < attempts; i++) {
		const r = await githubFetch(`${apiRoot(token)}/repos/${forkOwner}/${forkRepo}/git/ref/heads/${data.default_branch}`, { headers, cache: 'no-store' });
		if (r.ok) {
			const sync = await githubFetch(`${apiRoot(token)}/repos/${forkOwner}/${forkRepo}/merge-upstream`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ branch: data.default_branch })
			});
			if (!sync.ok) {
				const error: ErrorResponse = await sync.json().catch(() => ({}));
				throw new Error(`${error.message || 'Failed to sync fork'} (${sync.status} POST merge-upstream)`);
			}
			return { owner: forkOwner, repo: forkRepo };
		}
		if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error(`Fork ${forkOwner}/${forkRepo} was not ready in time.`);
}

/** Whether a repo named `repo` exists under `owner` (any visibility the token can see). */
export async function repoExists(owner: string, repo: string, token?: string): Promise<boolean> {
	const headers: Record<string, string> = { ...baseHeaders, ...authHeaders(token) };
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}`, { headers, cache: 'no-store' });
	if (res.status === 404) return false;
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to check repository name');
	}
	return true;
}

/** Repository visibility and whether the current authenticated user can push. */
export async function getRepoAccess(
	token: string,
	owner: string,
	repo: string
): Promise<{ isPrivate: boolean; canPush: boolean }> {
	const { ok, data } = await ghGet<RepoData>(`${apiRoot(token)}/repos/${owner}/${repo}`, token);
	if (!ok) throw new Error(data?.message || 'Failed to read repository');
	return { isPrivate: Boolean(data?.private), canPush: Boolean(data?.permissions?.push) };
}

/** Read the PR fields needed before its complete changed-file list is fetched. */
export async function getPullRequestDetails(
	token: string,
	owner: string,
	repo: string,
	number: number
): Promise<{ body: string | null; changedFiles: number }> {
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/pulls/${number}`, {
		headers: { ...baseHeaders, ...authHeaders(token) },
		cache: 'no-store'
	});
	const data: { body?: string | null; changed_files?: number; message?: string } = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.message || 'Failed to read pull request');
	return { body: data.body ?? null, changedFiles: data.changed_files ?? 0 };
}

/**
 * List every changed file in a pull request, including each file's unified-diff
 * patch. GitHub paginates this endpoint at 100 files and exposes at most 3,000;
 * a mismatch is rejected so the coordinator never validates a partial view.
 */
export async function getPullRequestFiles(
	token: string,
	owner: string,
	repo: string,
	number: number,
	expectedChangedFiles: number
): Promise<Array<{ filename: string; status: string; patch?: string }>> {
	if (!Number.isInteger(expectedChangedFiles) || expectedChangedFiles < 0) {
		throw new Error('Pull request reported an invalid changed-file count.');
	}
	if (expectedChangedFiles > 3000) {
		throw new Error('Pull request changes more than GitHub’s 3,000-file inspection limit.');
	}

	const files: Array<{ filename: string; status: string; patch?: string }> = [];
	const pages = Math.max(1, Math.ceil(expectedChangedFiles / 100));
	for (let page = 1; page <= pages; page++) {
		const res = await githubFetch(
			`${apiRoot(token)}/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
			{ headers: { ...baseHeaders, ...authHeaders(token) }, cache: 'no-store' }
		);
		const data = await res.json().catch(() => []);
		if (!res.ok) throw new Error((data as ErrorResponse).message || 'Failed to list pull request files');
		if (!Array.isArray(data)) throw new Error('GitHub returned an invalid pull-request file list.');
		files.push(...(data as Array<{ filename: string; status: string; patch?: string }>));
	}
	if (files.length !== expectedChangedFiles) {
		throw new Error(`Incomplete pull-request file list: expected ${expectedChangedFiles}, received ${files.length}.`);
	}
	return files.map((f) => ({
		filename: f.filename,
		status: f.status,
		patch: f.patch
	}));
}

/** A pull request's current state: 'open' or 'closed'. */
export async function getPullRequestState(
	token: string,
	owner: string,
	repo: string,
	number: number
): Promise<string> {
	const { ok, data } = await ghGet<{ state?: string; message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/pulls/${number}`,
		token
	);
	if (!ok) throw new Error(data?.message || 'Failed to read pull request');
	return data?.state ?? 'open';
}

/** The body of a pull request's most recent comment, or null if none. */
export async function getLastIssueComment(
	token: string,
	owner: string,
	repo: string,
	number: number
): Promise<string | null> {
	const { ok, data } = await ghGet<Array<{ body?: string }>>(
		`${apiRoot(token)}/repos/${owner}/${repo}/issues/${number}/comments?per_page=1&sort=created&direction=desc`,
		token
	);
	if (!ok) throw new Error((data as unknown as ErrorResponse)?.message || 'Failed to read comments');
	return (Array.isArray(data) ? data : [])[0]?.body ?? null;
}

/** The most recent run of `workflow` for `event`, or null if none yet. */
export async function getLatestWorkflowRun(
	token: string,
	owner: string,
	repo: string,
	workflow: string,
	event: string
): Promise<{ status: string; conclusion: string | null; created_at: string } | null> {
	const { ok, data } = await ghGet<{
		workflow_runs?: Array<{ status: string; conclusion: string | null; created_at: string }>;
		message?: string;
	}>(
		`${apiRoot(token)}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?event=${encodeURIComponent(event)}&per_page=1`,
		token
	);
	if (!ok) throw new Error(data?.message || 'Failed to read workflow runs');
	const run = data?.workflow_runs?.[0];
	return run ? { status: run.status, conclusion: run.conclusion ?? null, created_at: run.created_at } : null;
}

/** Post a comment on a pull request and then close it (used to resolve claims). */
export async function commentAndClosePr(
	token: string,
	owner: string,
	repo: string,
	number: number,
	body: string
): Promise<void> {
	const headers = { ...baseHeaders, ...authHeaders(token) };
	const commentRes = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/issues/${number}/comments`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ body })
	});
	if (!commentRes.ok) {
		const data: ErrorResponse = await commentRes.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to comment on pull request');
	}
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/pulls/${number}`, {
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
	for (const file of files) {
		const hasText = file.content != null;
		const hasBinary = file.contentBase64 != null;
		if (hasText === hasBinary) {
			throw new Error(`File ${file.path} must provide exactly one of content or contentBase64.`);
		}
	}

	const headers = { ...baseHeaders, ...authHeaders(token) };
	const api = `${apiRoot(token)}/repos/${owner}/${repo}`;

	const gh = async <T>(path: string, init?: RequestInit): Promise<T> => {
		const res = await githubFetch(`${api}${path}`, { headers, cache: 'no-store', ...init });
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

	// Text files go inline in the tree; binary files are uploaded as base64 blobs
	// first (the tree API only accepts text inline) and referenced by SHA.
	const treeEntries: Array<
		{ path: string; mode: '100644'; type: 'blob'; sha: string } |
		{ path: string; mode: '100644'; type: 'blob'; content: string }
	> = [];
	for (const f of files) {
			const base = { path: f.path, mode: '100644' as const, type: 'blob' as const };
			if (f.contentBase64 != null) {
				const blob = await gh<{ sha: string }>('/git/blobs', {
					method: 'POST',
					body: JSON.stringify({ content: f.contentBase64, encoding: 'base64' })
				});
				treeEntries.push({ ...base, sha: blob.sha });
				continue;
			}
			treeEntries.push({ ...base, content: f.content ?? '' });
	}

	// Build a tree off the current one, with our files added.
	const tree = await gh<{ sha: string }>('/git/trees', {
		method: 'POST',
		body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: treeEntries })
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
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/git/refs`, {
		method: 'POST',
		headers: { ...baseHeaders, ...authHeaders(token) },
		body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha })
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(`${data.message || 'Failed to create branch'} (${res.status} POST git/refs)`);
	}
}

/**
 * Point an existing branch at `sha`. Non-forced, so it succeeds only when the
 * move is a fast-forward — a branch carrying its own commits is never rolled
 * back. Returns whether the update was applied.
 */
export async function fastForwardBranch(
	token: string,
	owner: string,
	repo: string,
	branch: string,
	sha: string
): Promise<boolean> {
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
		method: 'PATCH',
		headers: { ...baseHeaders, ...authHeaders(token) },
		body: JSON.stringify({ sha })
	});
	if (res.ok) return true;
	const data: ErrorResponse = await res.json().catch(() => ({}));
	if (res.status === 409 || (res.status === 422 && /fast.?forward/i.test(data.message ?? ''))) {
		return false;
	}
	throw new Error(`${data.message || 'Failed to fast-forward branch'} (${res.status} PATCH ref heads/${branch})`);
}

/** Delete a branch. An already-gone ref counts as success. */
export async function deleteBranch(token: string, owner: string, repo: string, branch: string): Promise<void> {
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
		method: 'DELETE',
		headers: { ...baseHeaders, ...authHeaders(token) }
	});
	if (res.ok || res.status === 404) return;
	const data: ErrorResponse = await res.json().catch(() => ({}));
	if (res.status === 422 && /reference does not exist/i.test(data.message ?? '')) return;
	throw new Error(`${data.message || 'Failed to delete branch'} (${res.status} DELETE ref heads/${branch})`);
}

/** Open a pull request. Returns { number, html_url }. */
export async function createPullRequest(
	token: string,
	owner: string,
	repo: string,
	{ title, head, base, body }: { title: string; head: string; base: string; body: string }
): Promise<{ number: number; html_url: string }> {
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/pulls`, {
		method: 'POST',
		headers: { ...baseHeaders, ...authHeaders(token) },
		body: JSON.stringify({ title, head, base, body })
	});
	const data: {
		number: number;
		html_url: string;
		message?: string;
		errors?: Array<{ message?: string }>;
	} = await res.json().catch(() => ({}));
	if (!res.ok) {
		// A 422's `message` is just "Validation Failed" — the actual reason (e.g.
		// "No commits between X and Y") is in the errors array.
		const detail = data.errors?.map((e) => e.message).filter(Boolean).join('; ');
		throw new Error(
			`${data.message || 'Failed to open pull request'}${detail ? `: ${detail}` : ''} (${res.status} POST pulls)`
		);
	}
	return { number: data.number, html_url: data.html_url };
}

/**
 * Commit `files` onto a fresh branch and open a pull request to `owner/repo`
 * from it — the way the campaign console stands in for a volunteer client (its
 * PR triggers the claim/submission Actions). Returns { number, html_url } plus
 * `head`, the repo and branch the PR's head was created in, so the caller can
 * delete the branch once the PR is resolved.
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
): Promise<{ number: number; html_url: string; head: { owner: string; repo: string; branch: string } }> {
	const { branch: base, sha, canPush } = await getRepoHead(token, owner, repo);
	const target = canPush ? { owner, repo } : await ensureFork(token, owner, repo);

	let branchCreated = false;
	try {
		await createBranch(token, target.owner, target.repo, branch, sha);
		branchCreated = true;
		await commitFiles(token, target.owner, target.repo, files, message, { baseSha: sha, branch });

		const head = canPush ? branch : `${target.owner}:${branch}`;
		const pr = await createPullRequest(token, owner, repo, { title, head, base, body });
		return { ...pr, head: { owner: target.owner, repo: target.repo, branch } };
	} catch (error) {
		if (branchCreated) {
			try {
				await deleteBranch(token, target.owner, target.repo, branch);
			} catch (cleanupError) {
				console.warn(`Could not clean up branch ${target.owner}/${target.repo}:${branch}: ${(cleanupError as Error).message}`);
			}
		}
		throw error;
	}
}

/** Manually trigger a workflow_dispatch run of `workflow` (a filename) on `ref`. */
export async function dispatchWorkflow(
	token: string,
	owner: string,
	repo: string,
	workflow: string,
	ref: string
): Promise<void> {
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
		method: 'POST',
		headers: { ...baseHeaders, ...authHeaders(token) },
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
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/topics`, {
		method: 'PUT',
		headers: { ...baseHeaders, ...authHeaders(token) },
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
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/actions/permissions/workflow`, {
		method: 'PUT',
		headers: { ...baseHeaders, ...authHeaders(token) },
		body: JSON.stringify({ default_workflow_permissions: 'write' })
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to set workflow permissions');
	}
}

/**
 * The authenticated user's notification subscription for a repo, or null when
 * they have none set (the default "participating and @mentions" level).
 * `ignored` true means the repo is muted; `subscribed` true means watching.
 */
export async function getRepoSubscription(
	token: string,
	owner: string,
	repo: string
): Promise<{ subscribed: boolean; ignored: boolean } | null> {
	const { status, ok, data } = await ghGet<{ subscribed?: boolean; ignored?: boolean; message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/subscription`,
		token,
		{ cache: false }
	);
	if (status === 404) return null;
	if (!ok) throw new Error(data?.message || 'Failed to read repository subscription');
	return { subscribed: Boolean(data?.subscribed), ignored: Boolean(data?.ignored) };
}

/**
 * Set the authenticated user's subscription for a repo to "ignored": no web or
 * email notifications from it, including participating threads (own PRs,
 * mentions). Requires the OAuth 'notifications' scope; affects only the token's
 * own user.
 */
export async function ignoreRepoNotifications(token: string, owner: string, repo: string): Promise<void> {
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/subscription`, {
		method: 'PUT',
		headers: { ...baseHeaders, ...authHeaders(token) },
		body: JSON.stringify({ subscribed: false, ignored: true })
	});
	if (!res.ok) {
		const data: ErrorResponse = await res.json().catch(() => ({}));
		throw new Error(data.message || 'Failed to set repository subscription');
	}
}

/**
 * List repos tagged with `topic`. With the user's `repo`-scoped token, GitHub's
 * search returns matching public repos plus the user's own private matches.
 * Visibility always reflects GitHub's current state.
 */
export async function searchReposByTopic(topic: string, token?: string): Promise<RepoSummary[]> {
	const q = encodeURIComponent(`topic:${topic}`);
	const { ok, data } = await ghGet<{
		items?: Array<{
			full_name: string;
			name: string;
			owner?: { login: string };
			html_url: string;
			private: boolean;
			description: string | null;
			updated_at: string;
		}>;
		message?: string;
	}>(`${apiRoot(token)}/search/repositories?q=${q}&sort=updated&order=desc&per_page=100`, token);
	if (!ok) throw new Error(data?.message || 'Repo search failed');
	return (data?.items || []).map((r) => ({
		full_name: r.full_name,
		name: r.name,
		owner: r.owner?.login,
		html_url: r.html_url,
		private: r.private,
		description: r.description,
		updated_at: r.updated_at
	}));
}
