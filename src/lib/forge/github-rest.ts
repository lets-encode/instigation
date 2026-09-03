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
	readonly source: 'github' | 'broker';
	readonly resource: string | null;
	readonly limit: number | null;
	readonly remaining: number | null;
	readonly used: number | null;
	/** Unix epoch seconds when the limit resets, or null if not reported. */
	readonly resetAt: number | null;
	readonly retryAfterSeconds: number | null;
	constructor({
		source,
		resource,
		limit,
		remaining,
		used,
		resetAt,
		retryAfterSeconds
	}: {
		source: 'github' | 'broker';
		resource: string | null;
		limit: number | null;
		remaining: number | null;
		used: number | null;
		resetAt: number | null;
		retryAfterSeconds: number | null;
	}) {
		const when = retryAfterSeconds
			? `in about ${retryAfterSeconds} seconds`
			: resetAt
				? `at ${new Date(resetAt * 1000).toLocaleTimeString()}`
				: 'shortly';
		const service = source === 'broker' ? 'OAuth broker request' : 'GitHub API';
		const bucket = resource ? ` (${resource})` : '';
		super(`${service} rate limit exceeded${bucket} — retry ${when}.`);
		this.name = 'RateLimitError';
		this.source = source;
		this.resource = resource;
		this.limit = limit;
		this.remaining = remaining;
		this.used = used;
		this.resetAt = resetAt;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export interface GitHubRequestTelemetry {
	total: number;
	conditional: number;
	notModified: number;
	rateLimited: number;
	byMethod: Record<string, number>;
	byResource: Record<string, number>;
	last: {
		request: number;
		method: string;
		endpoint: string;
		status: number | null;
		durationMs: number;
		source: 'github' | 'broker';
		resource: string | null;
		limit: number | null;
		remaining: number | null;
		used: number | null;
		resetAt: number | null;
		retryAfterSeconds: number | null;
		conditional: boolean;
	} | null;
}

const requestTelemetry: GitHubRequestTelemetry = {
	total: 0,
	conditional: 0,
	notModified: 0,
	rateLimited: 0,
	byMethod: {},
	byResource: {},
	last: null
};

/** Cumulative GitHub request counters for this browser tab or coordinator run. */
export function getGitHubRequestTelemetry(): GitHubRequestTelemetry {
	return {
		...requestTelemetry,
		byMethod: { ...requestTelemetry.byMethod },
		byResource: { ...requestTelemetry.byResource },
		last: requestTelemetry.last ? { ...requestTelemetry.last } : null
	};
}

/** Reset the current process's counters (primarily useful for diagnostics and tests). */
export function resetGitHubRequestTelemetry(): void {
	requestTelemetry.total = 0;
	requestTelemetry.conditional = 0;
	requestTelemetry.notModified = 0;
	requestTelemetry.rateLimited = 0;
	requestTelemetry.byMethod = {};
	requestTelemetry.byResource = {};
	requestTelemetry.last = null;
}

function numberHeader(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw == null) return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

function endpointFrom(input: RequestInfo | URL): string {
	try {
		const path = new URL(String(input), 'https://local.invalid').pathname;
		const proxyMarker = '/proxy/api.github.com';
		const proxyIndex = path.indexOf(proxyMarker);
		return proxyIndex >= 0 ? path.slice(proxyIndex + proxyMarker.length) || '/' : path;
	} catch {
		return '(invalid URL)';
	}
}

function recordRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	startedAt: number,
	res: Response | null
): GitHubRequestTelemetry['last'] {
	const headers = res?.headers ?? new Headers();
	const method = (init?.method ?? 'GET').toUpperCase();
	const conditional = new Headers(init?.headers).has('If-None-Match');
	const source: 'github' | 'broker' =
		headers.get('X-Lets-Encode-Upstream') === 'broker' ? 'broker' : 'github';
	const resource = headers.get('X-RateLimit-Resource');
	const entry = {
		request: ++requestTelemetry.total,
		method,
		endpoint: endpointFrom(input),
		status: res?.status ?? null,
		durationMs: Date.now() - startedAt,
		source,
		resource,
		limit: numberHeader(headers, 'X-RateLimit-Limit'),
		remaining: numberHeader(headers, 'X-RateLimit-Remaining'),
		used: numberHeader(headers, 'X-RateLimit-Used'),
		resetAt: numberHeader(headers, 'X-RateLimit-Reset'),
		retryAfterSeconds: numberHeader(headers, 'Retry-After'),
		conditional
	};
	if (conditional) requestTelemetry.conditional++;
	if (res?.status === 304) requestTelemetry.notModified++;
	requestTelemetry.byMethod[method] = (requestTelemetry.byMethod[method] ?? 0) + 1;
	const bucket = resource ?? 'unknown';
	requestTelemetry.byResource[bucket] = (requestTelemetry.byResource[bucket] ?? 0) + 1;
	requestTelemetry.last = entry;
	if (resource || res == null || source === 'broker') {
		console.info('[github-api]', entry);
	}
	return entry;
}

async function githubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const startedAt = Date.now();
	let res: Response;
	try {
		res = await fetch(input, init);
	} catch (error) {
		recordRequest(input, init, startedAt, null);
		throw error;
	}
	const telemetry = recordRequest(input, init, startedAt, res);
	if (res.status !== 403 && res.status !== 429) return res;
	const remaining = res.headers.get('X-RateLimit-Remaining');
	const retryAfterHeader = res.headers.get('Retry-After');
	const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
	const message = await res.clone().text().catch(() => '');
	// Only genuine rate-limit signals classify: HTTP 429, an exhausted quota
	// header, a Retry-After header, or GitHub's rate-limit message. Other 403s
	// (permissions, the broker's CSRF/origin/session rejections) surface
	// through the normal error path with their own message.
	const limited =
		res.status === 429 ||
		remaining === '0' ||
		Number.isFinite(retryAfter) ||
		/secondary rate limit|rate limit exceeded|abuse detection/i.test(message);
	if (!limited) return res;
	requestTelemetry.rateLimited++;
	throw new RateLimitError({
		source: telemetry?.source ?? 'github',
		resource: telemetry?.resource ?? null,
		limit: telemetry?.limit ?? null,
		remaining: telemetry?.remaining ?? null,
		used: telemetry?.used ?? null,
		resetAt: telemetry?.resetAt ?? null,
		retryAfterSeconds: telemetry?.retryAfterSeconds ?? null
	});
}

// ETag store for conditional GETs, keyed by full request URL. Only cacheable
// JSON GETs add entries; it grows with the number of distinct URLs read in a
// session. Never used for responses whose bodies carry short-lived tokens (see
// getRepoFileDownloadUrl / getDirDownloadUrls), which pass `cache: false`.
const etagCache = new Map<string, { etag: string; body: string; link: string | null }>();

/**
 * A GitHub JSON GET with ETag conditional-request caching and rate-limit
 * detection. On 304 the remembered body is returned (status normalised to 200);
 * on a fresh 200 the response ETag and body are stored. Throws RateLimitError
 * when the quota is exhausted. Returns the HTTP status, parsed JSON (null on
 * an empty or non-JSON body), and the pagination `Link` header (remembered
 * alongside the ETag). Pass `cache: false` to skip the ETag store while
 * keeping the rate-limit guard.
 */
async function ghGet<T>(
	url: string,
	token?: string,
	{ cache = true }: { cache?: boolean } = {}
): Promise<{ status: number; ok: boolean; data: T; link: string | null }> {
	const cached = cache ? etagCache.get(url) : undefined;
	const headers: Record<string, string> = { ...baseHeaders, ...authHeaders(token) };
	if (cached) headers['If-None-Match'] = cached.etag;
	const res = await githubFetch(url, { headers, cache: 'no-store' });
	if (res.status === 304 && cached) {
		return { status: 200, ok: true, data: JSON.parse(cached.body) as T, link: cached.link };
	}
	const text = await res.text();
	const etag = res.headers.get('ETag');
	const link = res.headers.get('Link');
	if (cache && res.ok && etag) etagCache.set(url, { etag, body: text, link });
	else if (res.status === 404) etagCache.delete(url);
	let data: unknown = null;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = null;
	}
	return { status: res.status, ok: res.ok, data: data as T, link };
}

/**
 * A GitHub JSON request without ETag caching — the write path, plus reads that
 * treat any non-2xx as failure. `path` is API-root-relative (e.g.
 * `/repos/o/r/pulls`); `body` is sent as JSON when given. Throws on a non-2xx
 * response with the body's `message` (or the broker's `error`) suffixed
 * `(status METHOD path)`. Returns the parsed JSON body ({} when empty).
 */
async function ghSend<T>(method: string, path: string, token?: string, body?: unknown): Promise<T> {
	const res = await githubFetch(`${apiRoot(token)}${path}`, {
		method,
		headers: { ...baseHeaders, ...authHeaders(token) },
		cache: 'no-store',
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const detail = data as { message?: string; error?: string };
		throw new Error(`${detail.message || detail.error || 'GitHub API error'} (${res.status} ${method} ${path})`);
	}
	return data as T;
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
	/** Numeric account id — stable across username (login) changes. */
	id: number;
	login: string;
	name: string | null;
	avatar_url: string;
}

/** A repo as returned by the create/read endpoints (fields this app reads). */
export interface RepoData {
	/** Numeric repo id — stable across rename/transfer. */
	id: number;
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
	/** Numeric repo id — stable across rename/transfer. */
	id: number;
	full_name: string;
	name: string;
	owner: string | undefined;
	html_url: string;
	private: boolean;
	description: string | null;
	updated_at: string;
	created_at: string;
}

/** A repo's stable numeric id resolved to its current owner/name. */
export interface RepoRef {
	id: number;
	owner: string;
	repo: string;
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

// Value cache for the id→login and id→repo resolvers, on top of ghGet's ETag
// conditional caching (a 304 is free of the rate limit, but still a round trip).
// This memo skips the network entirely for a repeat lookup within TTL_MS. Logins
// and repo names change rarely; the TTL bounds how long a rename stays hidden
// behind a display lookup — acceptable, since these values are display-only.
const RESOLVE_TTL_MS = 5 * 60_000;
const loginCache = new Map<number, { value: string; expires: number }>();
const repoRefCache = new Map<number, { value: RepoRef; expires: number }>();
// Default branch + push permission per repo. Both change rarely; the TTL
// bounds how long a change stays hidden. Skips one round trip on every
// getRepoHead call after the first.
const repoHeadInfoCache = new Map<string, { value: { branch: string; canPush: boolean }; expires: number }>();

function memoGet<K, T>(cache: Map<K, { value: T; expires: number }>, key: K): T | undefined {
	const hit = cache.get(key);
	if (hit && hit.expires > Date.now()) return hit.value;
	if (hit) cache.delete(key);
	return undefined;
}

/**
 * Resolve a numeric account id to its current login (username). Used to display
 * the people referenced by the tracking tables, which store the stable numeric
 * id. Memoised for RESOLVE_TTL_MS. Returns null if the account can't be read.
 */
export async function getUserLogin(token: string | undefined, id: number): Promise<string | null> {
	const memo = memoGet(loginCache, id);
	if (memo !== undefined) return memo;
	const { status, ok, data } = await ghGet<{ login?: string; message?: string }>(
		`${apiRoot(token)}/user/${id}`,
		token
	);
	if (status === 404) return null;
	if (!ok) throw new Error(data?.message || `Failed to resolve user ${id}`);
	const login = data?.login ?? null;
	if (login) loginCache.set(id, { value: login, expires: Date.now() + RESOLVE_TTL_MS });
	return login;
}

/**
 * Resolve a numeric repo id to its current owner/name via `GET /repositories/{id}`
 * — the id is stable across rename/transfer, so this is the authoritative way to
 * reach a repo the app tracks by id. Memoised for RESOLVE_TTL_MS. Returns null if
 * the repo can't be read (deleted, or not visible to this token).
 */
export async function getRepoById(token: string | undefined, id: number): Promise<RepoRef | null> {
	const memo = memoGet(repoRefCache, id);
	if (memo !== undefined) return memo;
	const { status, ok, data } = await ghGet<{ name?: string; owner?: { login?: string }; message?: string }>(
		`${apiRoot(token)}/repositories/${id}`,
		token
	);
	if (status === 404) return null;
	if (!ok) throw new Error(data?.message || `Failed to resolve repository ${id}`);
	const owner = data?.owner?.login;
	const repo = data?.name;
	if (!owner || !repo) return null;
	const ref: RepoRef = { id, owner, repo };
	repoRefCache.set(id, { value: ref, expires: Date.now() + RESOLVE_TTL_MS });
	return ref;
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
	const { status, ok, data } = await ghGet<
		{ content?: string; encoding?: string; message?: string } | Array<unknown>
	>(`${apiRoot(token)}/repos/${owner}/${repo}/contents/${path}${query}`, token);
	if (status === 404) return null;
	if (Array.isArray(data)) throw new Error(`Failed to fetch ${path}: the path is a directory`);
	if (!ok) throw new Error(data?.message || `Failed to fetch ${path}`);
	if (data?.encoding === 'base64' && data.content != null) return decodeBase64Utf8(data.content);
	// Files over the Contents API's 1 MB inline limit come back with
	// `encoding: "none"` and no content; read the bytes via the raw media type.
	const blob = await getRepoFileBytes(token, owner, repo, path, ref);
	if (blob === null) throw new Error(`Failed to fetch ${path}: content unavailable`);
	return await blob.text();
}

/**
 * A repo file's bytes, read through the API rather than from a download URL, so
 * the request goes to a host the browser is allowed to connect to and carries
 * the session's credentials. The `raw` media type returns the file inline for
 * anything up to 100 MB. Returns null if the path or ref is absent.
 */
export async function getRepoFileBytes(
	token: string,
	owner: string,
	repo: string,
	path: string,
	ref?: string
): Promise<Blob | null> {
	const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/contents/${path}${query}`, {
		headers: {
			...baseHeaders,
			...authHeaders(token),
			Accept: 'application/vnd.github.raw'
		},
		cache: 'no-store'
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
	return await res.blob();
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
 * Read a repo's default branch, its current head commit SHA and that commit's
 * tree SHA, and whether the authenticated user can push to it (drives the
 * same-repo vs. fork PR path). The tree SHA is what a commit built on this
 * head starts from (`commitFiles`'s `baseTreeSha`).
 */
export async function getRepoHead(
	token: string,
	owner: string,
	repo: string
): Promise<{ branch: string; sha: string; treeSha: string; canPush: boolean }> {
	// The branch name and push permission are memoised; the head SHA is read
	// fresh on every call — callers rely on it for optimistic concurrency.
	const key = `${owner}/${repo}`;
	let info = memoGet(repoHeadInfoCache, key);
	if (!info) {
		const repoRes = await ghGet<RepoData>(`${apiRoot(token)}/repos/${owner}/${repo}`, token);
		if (!repoRes.ok)
			throw new Error(`${repoRes.data?.message || 'Failed to read repository'} (${repoRes.status} GET repo)`);
		info = { branch: repoRes.data.default_branch, canPush: Boolean(repoRes.data.permissions?.push) };
		repoHeadInfoCache.set(key, { value: info, expires: Date.now() + RESOLVE_TTL_MS });
	}
	// The branch endpoint carries the head commit together with its tree, so
	// one read serves both the optimistic-concurrency parent and the tree a
	// commit on it is built from.
	const branchRes = await ghGet<{ commit: { sha: string; commit: { tree: { sha: string } } }; message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/branches/${info.branch}`,
		token
	);
	if (!branchRes.ok)
		throw new Error(`${branchRes.data?.message || 'Failed to read branch'} (${branchRes.status} GET branches/${info.branch})`);
	const head = branchRes.data.commit;
	return { branch: info.branch, sha: head.sha, treeSha: head.commit.tree.sha, canPush: info.canPush };
}

/** A commit's message, or null when the commit cannot be read. */
export async function getCommitMessage(
	token: string,
	owner: string,
	repo: string,
	sha: string
): Promise<string | null> {
	const res = await ghGet<{ message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/git/commits/${sha}`,
		token
	);
	if (!res.ok) return null;
	return res.data.message ?? null;
}

// Fork identities already ensured this session, keyed by upstream owner/repo.
// Only the create + readiness poll is skipped for a known fork — the upstream
// sync still runs on every call, since callers create branches at upstream
// commits the fork must contain.
const knownForks = new Map<string, { owner: string; repo: string; branch: string }>();

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
	const known = knownForks.get(`${owner}/${repo}`);
	if (known) {
		await ghSend('POST', `/repos/${known.owner}/${known.repo}/merge-upstream`, token, { branch: known.branch });
		return { owner: known.owner, repo: known.repo };
	}
	// Only the default branch — the fork doesn't need copies of upstream's
	// in-flight claim branches.
	const data = await ghSend<{ full_name: string; default_branch: string }>(
		'POST',
		`/repos/${owner}/${repo}/forks`,
		token,
		{ default_branch_only: true }
	);
	if (!data.full_name?.includes('/') || !data.default_branch) {
		throw new Error('GitHub returned an invalid fork description.');
	}

	const [forkOwner, forkRepo] = data.full_name.split('/');
	// Poll until the fork's default branch ref exists (the fork is populated).
	for (let i = 0; i < attempts; i++) {
		const r = await githubFetch(`${apiRoot(token)}/repos/${forkOwner}/${forkRepo}/git/ref/heads/${data.default_branch}`, { headers, cache: 'no-store' });
		if (r.ok) {
			await ghSend('POST', `/repos/${forkOwner}/${forkRepo}/merge-upstream`, token, {
				branch: data.default_branch
			});
			knownForks.set(`${owner}/${repo}`, { owner: forkOwner, repo: forkRepo, branch: data.default_branch });
			return { owner: forkOwner, repo: forkRepo };
		}
		if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
	throw new Error(`Fork ${forkOwner}/${forkRepo} was not ready in time.`);
}

/** Whether a repo named `repo` exists under `owner` (any visibility the token can see). */
export async function repoExists(owner: string, repo: string, token?: string): Promise<boolean> {
	const { status, ok, data } = await ghGet<ErrorResponse>(`${apiRoot(token)}/repos/${owner}/${repo}`, token);
	if (status === 404) return false;
	if (!ok) throw new Error(data?.message || 'Failed to check repository name');
	return true;
}

/** A repository's data by owner/name, or null if it doesn't exist (404). */
export async function getRepoInfo(
	token: string,
	owner: string,
	repo: string
): Promise<RepoData | null> {
	const { status, ok, data } = await ghGet<RepoData>(`${apiRoot(token)}/repos/${owner}/${repo}`, token);
	if (status === 404) return null;
	if (!ok) throw new Error(data?.message || 'Failed to read repository');
	return data;
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

/**
 * Whether `username` can push to the repo, via the collaborator-permission
 * lookup. Returns false when the user is not a collaborator or the lookup
 * fails — callers treat push access as a privilege to be proven.
 */
export async function getCollaboratorCanPush(
	token: string,
	owner: string,
	repo: string,
	username: string
): Promise<boolean> {
	const { ok, data } = await ghGet<{ permission?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`,
		token
	);
	if (!ok) return false;
	return data?.permission === 'admin' || data?.permission === 'write';
}

/** Read the PR fields needed before its complete changed-file list is fetched. */
export async function getPullRequestDetails(
	token: string,
	owner: string,
	repo: string,
	number: number
): Promise<{ body: string | null; changedFiles: number; createdAt: string }> {
	const data = await ghSend<{ body?: string | null; changed_files?: number; created_at?: string }>(
		'GET',
		`/repos/${owner}/${repo}/pulls/${number}`,
		token
	);
	return { body: data.body ?? null, changedFiles: data.changed_files ?? 0, createdAt: data.created_at ?? '' };
}

/** One changed file of a pull request, with its unified-diff patch when GitHub supplies one. */
export interface PullRequestFile {
	filename: string;
	status: string;
	patch?: string;
}

const PR_FILES_PER_PAGE = 100;

async function pullRequestFilesPage(
	token: string,
	owner: string,
	repo: string,
	number: number,
	page: number
): Promise<PullRequestFile[]> {
	const data = await ghSend<unknown>(
		'GET',
		`/repos/${owner}/${repo}/pulls/${number}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`,
		token
	);
	if (!Array.isArray(data)) throw new Error('GitHub returned an invalid pull-request file list.');
	return (data as PullRequestFile[]).map((f) => ({ filename: f.filename, status: f.status, patch: f.patch }));
}

/**
 * List every changed file in a pull request, including each file's unified-diff
 * patch. GitHub paginates this endpoint at 100 files and exposes at most 3,000;
 * a mismatch is rejected so the coordinator never validates a partial view.
 * `firstPage` is the already-read first page, when the caller fetched it
 * alongside the pull request itself.
 */
export async function getPullRequestFiles(
	token: string,
	owner: string,
	repo: string,
	number: number,
	expectedChangedFiles: number,
	firstPage?: PullRequestFile[]
): Promise<PullRequestFile[]> {
	if (!Number.isInteger(expectedChangedFiles) || expectedChangedFiles < 0) {
		throw new Error('Pull request reported an invalid changed-file count.');
	}
	if (expectedChangedFiles > 3000) {
		throw new Error('Pull request changes more than GitHub’s 3,000-file inspection limit.');
	}

	const pages = Math.max(1, Math.ceil(expectedChangedFiles / PR_FILES_PER_PAGE));
	const files = firstPage ? [...firstPage] : await pullRequestFilesPage(token, owner, repo, number, 1);
	for (let page = 2; page <= pages; page++) {
		files.push(...(await pullRequestFilesPage(token, owner, repo, number, page)));
	}
	if (files.length !== expectedChangedFiles) {
		throw new Error(`Incomplete pull-request file list: expected ${expectedChangedFiles}, received ${files.length}.`);
	}
	return files;
}

/**
 * A pull request's body, creation time and complete changed-file list. The
 * first page of files is read alongside the pull request itself; the
 * request's changed-file count then says whether further pages follow.
 */
export async function getPullRequest(
	token: string,
	owner: string,
	repo: string,
	number: number
): Promise<{ body: string | null; changedFiles: number; createdAt: string; files: PullRequestFile[] }> {
	const [details, firstPage] = await Promise.all([
		getPullRequestDetails(token, owner, repo, number),
		pullRequestFilesPage(token, owner, repo, number, 1)
	]);
	const files = await getPullRequestFiles(token, owner, repo, number, details.changedFiles, firstPage);
	return { ...details, files };
}

/** One open pull request, as the campaign automation reads it. */
export interface OpenPullRequest {
	number: number;
	created_at: string;
	draft: boolean;
	/** GitHub account type: 'User', 'Bot' or 'Organization'. */
	user: { id: number; login: string; type: string };
	head: { sha: string; ref: string; repo: { full_name: string } | null };
}

/** The repository's newest open pull requests, newest first; 100 at most. */
export async function listOpenPullRequests(token: string, owner: string, repo: string): Promise<OpenPullRequest[]> {
	const { ok, data } = await ghGet<Array<OpenPullRequest> | { message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/pulls?state=open&per_page=100&sort=created&direction=desc`,
		token
	);
	if (!ok || !Array.isArray(data)) {
		throw new Error((data as { message?: string })?.message || 'Failed to list pull requests');
	}
	return data.map((pr) => ({
		number: pr.number,
		created_at: pr.created_at,
		draft: Boolean(pr.draft),
		user: { id: pr.user.id, login: pr.user.login, type: pr.user.type },
		head: { sha: pr.head.sha, ref: pr.head.ref, repo: pr.head.repo ? { full_name: pr.head.repo.full_name } : null }
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
	// The per-issue comments endpoint serves oldest-first and has no sort
	// parameter, so with per_page=1 the newest comment is the single item on
	// the last page: probe page 1, then follow the Link header's rel="last".
	// No Link header means there are 0 or 1 comments and the probe already
	// holds the answer.
	const url = `${apiRoot(token)}/repos/${owner}/${repo}/issues/${number}/comments?per_page=1`;
	const probe = await ghGet<Array<{ body?: string }>>(url, token);
	if (!probe.ok) throw new Error((probe.data as unknown as ErrorResponse)?.message || 'Failed to read comments');
	const lastPage = probe.link?.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/)?.[1];
	if (!lastPage) return (Array.isArray(probe.data) ? probe.data : [])[0]?.body ?? null;
	const { ok, data } = await ghGet<Array<{ body?: string }>>(`${url}&page=${lastPage}`, token);
	if (!ok) throw new Error((data as unknown as ErrorResponse)?.message || 'Failed to read comments');
	return (Array.isArray(data) ? data : [])[0]?.body ?? null;
}

/** A workflow run, as far as the console follows it. */
export interface WorkflowRunInfo {
	id: number;
	/** queued | in_progress | completed (GitHub also has waiting/pending states). */
	status: string;
	conclusion: string | null;
	created_at: string;
	html_url: string;
}

/** One job of a workflow run, with its steps in execution order. */
export interface WorkflowJobInfo {
	name: string;
	status: string;
	conclusion: string | null;
	steps: Array<{ name: string; status: string; conclusion: string | null }>;
}

const pickRun = (r: WorkflowRunInfo): WorkflowRunInfo => ({
	id: r.id,
	status: r.status,
	conclusion: r.conclusion ?? null,
	created_at: r.created_at,
	html_url: r.html_url
});

/**
 * The most recent runs of `workflow`, newest first. `event` narrows to one
 * trigger (e.g. workflow_dispatch), `headSha` to runs of one head commit —
 * which is how the run a PR triggered is found.
 */
export async function listWorkflowRuns(
	token: string,
	owner: string,
	repo: string,
	workflow: string,
	filter: { event?: string; headSha?: string } = {}
): Promise<WorkflowRunInfo[]> {
	// Wide enough that the run being searched for is on the first page even
	// when other runs of the same workflow land in between.
	const params = new URLSearchParams({ per_page: '30' });
	if (filter.event) params.set('event', filter.event);
	if (filter.headSha) params.set('head_sha', filter.headSha);
	const { ok, data } = await ghGet<{ workflow_runs?: WorkflowRunInfo[]; message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?${params}`,
		token
	);
	if (!ok) throw new Error(data?.message || 'Failed to read workflow runs');
	return (data?.workflow_runs ?? []).map(pickRun);
}

/** One workflow run by id. */
export async function getWorkflowRun(
	token: string,
	owner: string,
	repo: string,
	runId: number
): Promise<WorkflowRunInfo> {
	const { ok, data } = await ghGet<WorkflowRunInfo & { message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/actions/runs/${runId}`,
		token
	);
	if (!ok) throw new Error(data?.message || 'Failed to read workflow run');
	return pickRun(data);
}

/** A workflow run's jobs with their steps, in execution order. */
export async function getWorkflowRunJobs(
	token: string,
	owner: string,
	repo: string,
	runId: number
): Promise<WorkflowJobInfo[]> {
	const { ok, data } = await ghGet<{ jobs?: WorkflowJobInfo[]; message?: string }>(
		`${apiRoot(token)}/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=100`,
		token
	);
	if (!ok) throw new Error(data?.message || 'Failed to read workflow run jobs');
	return (data?.jobs ?? []).map((j) => ({
		name: j.name,
		status: j.status,
		conclusion: j.conclusion ?? null,
		steps: (j.steps ?? []).map((s) => ({
			name: s.name,
			status: s.status,
			conclusion: s.conclusion ?? null
		}))
	}));
}

/** Close a pull request without merging it. */
export async function closePullRequest(token: string, owner: string, repo: string, number: number): Promise<void> {
	await ghSend('PATCH', `/repos/${owner}/${repo}/pulls/${number}`, token, { state: 'closed' });
}

/** Post a comment on a pull request and then close it (used to resolve claims). */
export async function commentAndClosePr(
	token: string,
	owner: string,
	repo: string,
	number: number,
	body: string
): Promise<void> {
	await ghSend('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, token, { body });
	await closePullRequest(token, owner, repo, number);
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
 * Pass `opts.deletePaths` to remove files in the same commit, so a set of files
 * can be replaced by a smaller set without leaving the extra ones behind.
 *
 * Pass `opts.baseSha` to commit on a specific parent: the ref update is
 * non-forced, so if the branch has moved past `baseSha` (a concurrent change)
 * the update fails rather than clobbering it — optimistic concurrency for the
 * tracking tables. Omit it to commit on the current branch head. Pass
 * `opts.branch` to target a branch other than the repo default (e.g. a feature
 * branch being prepared for a pull request).
 *
 * Pass `opts.newBranch` (with `baseSha`) to create that branch at the new
 * commit instead of updating an existing ref — one call replaces the
 * create-branch/fast-forward pair, and no ref exists until the commit does.
 *
 * Binary files are uploaded one at a time, which for images is the long part of
 * the commit; `opts.onUpload` is called after each one with how many of them are
 * done, so a caller can report progress through them.
 * https://docs.github.com/en/rest/git
 */
export async function commitFiles(
	token: string,
	owner: string,
	repo: string,
	files: FileChange[],
	message: string,
	{
		baseSha,
		baseTreeSha,
		branch,
		newBranch,
		deletePaths = [],
		onUpload
	}: {
		baseSha?: string;
		/** The tree of `baseSha`, when already known; saves reading the commit. */
		baseTreeSha?: string;
		branch?: string;
		newBranch?: string;
		deletePaths?: string[];
		onUpload?: (uploaded: number, total: number) => void;
	} = {}
): Promise<string> {
	if (newBranch && !baseSha) throw new Error('newBranch requires baseSha (the commit to branch from).');
	if (baseTreeSha && !baseSha) throw new Error('baseTreeSha requires baseSha (the commit it belongs to).');
	for (const file of files) {
		const hasText = file.content != null;
		const hasBinary = file.contentBase64 != null;
		if (hasText === hasBinary) {
			throw new Error(`File ${file.path} must provide exactly one of content or contentBase64.`);
		}
	}

	const api = `/repos/${owner}/${repo}`;

	// Resolve the target branch and the parent commit to build on. A new
	// branch's parent is always the given baseSha; no ref exists to resolve.
	const targetBranch =
		newBranch ?? branch ?? (await ghSend<{ default_branch: string }>('GET', api, token)).default_branch;
	let headSha = baseSha;
	if (!headSha) {
		const ref = await ghSend<{ object: { sha: string } }>('GET', `${api}/git/ref/heads/${targetBranch}`, token);
		headSha = ref.object.sha;
	}
	const baseTree =
		baseTreeSha ?? (await ghSend<{ tree: { sha: string } }>('GET', `${api}/git/commits/${headSha}`, token)).tree.sha;

	// Text files go inline in the tree; binary files are uploaded as base64 blobs
	// first (the tree API only accepts text inline) and referenced by SHA. An
	// entry with a null SHA takes its path out of the tree the commit is built on.
	const treeEntries: Array<
		{ path: string; mode: '100644'; type: 'blob'; sha: string | null } |
		{ path: string; mode: '100644'; type: 'blob'; content: string }
	> = [];
	const binaryCount = files.filter((f) => f.contentBase64 != null).length;
	let uploaded = 0;
	for (const f of files) {
			const base = { path: f.path, mode: '100644' as const, type: 'blob' as const };
			if (f.contentBase64 != null) {
				const blob = await ghSend<{ sha: string }>('POST', `${api}/git/blobs`, token, {
					content: f.contentBase64,
					encoding: 'base64'
				});
				treeEntries.push({ ...base, sha: blob.sha });
				onUpload?.(++uploaded, binaryCount);
				continue;
			}
			treeEntries.push({ ...base, content: f.content ?? '' });
	}
	for (const path of deletePaths) {
		treeEntries.push({ path, mode: '100644', type: 'blob', sha: null });
	}

	// Build a tree off the current one, with our files added.
	const tree = await ghSend<{ sha: string }>('POST', `${api}/git/trees`, token, {
		base_tree: baseTree,
		tree: treeEntries
	});

	const commit = await ghSend<{ sha: string }>('POST', `${api}/git/commits`, token, {
		message,
		tree: tree.sha,
		parents: [headSha]
	});

	if (newBranch) {
		await ghSend('POST', `${api}/git/refs`, token, { ref: `refs/heads/${newBranch}`, sha: commit.sha });
	} else {
		await ghSend('PATCH', `${api}/git/refs/heads/${targetBranch}`, token, { sha: commit.sha });
	}

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
	await ghSend('POST', `/repos/${owner}/${repo}/git/refs`, token, {
		ref: `refs/heads/${branch}`,
		sha: fromSha
	});
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

/**
 * Open a pull request. Returns { number, html_url, headSha } — the head commit
 * SHA is what identifies the workflow run the PR triggers.
 */
export async function createPullRequest(
	token: string,
	owner: string,
	repo: string,
	{ title, head, base, body }: { title: string; head: string; base: string; body: string }
): Promise<{ number: number; html_url: string; headSha: string }> {
	const res = await githubFetch(`${apiRoot(token)}/repos/${owner}/${repo}/pulls`, {
		method: 'POST',
		headers: { ...baseHeaders, ...authHeaders(token) },
		body: JSON.stringify({ title, head, base, body })
	});
	const data: {
		number: number;
		html_url: string;
		head?: { sha?: string };
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
	return { number: data.number, html_url: data.html_url, headSha: data.head?.sha ?? '' };
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
): Promise<{
	number: number;
	html_url: string;
	headSha: string;
	head: { owner: string; repo: string; branch: string };
}> {
	const { branch: base, sha, canPush } = await getRepoHead(token, owner, repo);
	const target = canPush ? { owner, repo } : await ensureFork(token, owner, repo);

	// The commit is built first and the branch created at it in one step; no
	// ref exists until the commit does, so only a failed PR needs cleanup.
	let branchCreated = false;
	try {
		await commitFiles(token, target.owner, target.repo, files, message, { baseSha: sha, newBranch: branch });
		branchCreated = true;

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
	await ghSend('POST', `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, token, { ref });
}

/** Replace a repo's topics — used to tag repos created through this app. */
export async function setRepoTopics(
	token: string,
	owner: string,
	repo: string,
	names: string[]
): Promise<unknown> {
	return ghSend<unknown>('PUT', `/repos/${owner}/${repo}/topics`, token, { names });
}

/**
 * Set the repo's default GITHUB_TOKEN permissions for workflows to read/write,
 * so the campaign Actions (which commit the tracking tables and resolve
 * claim/submission PRs) have the access they need. Requires admin on the repo.
 */
export async function setActionsWorkflowPermissions(token: string, owner: string, repo: string): Promise<void> {
	await ghSend('PUT', `/repos/${owner}/${repo}/actions/permissions/workflow`, token, {
		default_workflow_permissions: 'write'
	});
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
	await ghSend('PUT', `/repos/${owner}/${repo}/subscription`, token, { subscribed: false, ignored: true });
}

/**
 * List repos tagged with `topic`. With the user's `repo`-scoped token, GitHub's
 * search returns matching public repos plus the user's own private matches.
 * Visibility always reflects GitHub's current state.
 */
export async function searchReposByTopic(topic: string, token?: string): Promise<RepoSummary[]> {
	const q = encodeURIComponent(`topic:${topic}`);
	type SearchItem = {
		id: number;
		full_name: string;
		name: string;
		owner?: { login: string };
		html_url: string;
		private: boolean;
		description: string | null;
		updated_at: string;
		created_at: string;
	};
	const items: SearchItem[] = [];
	// The search API pages at 100 results and serves at most 1,000 (10 pages).
	for (let page = 1; page <= 10; page++) {
		const { ok, data } = await ghGet<{ items?: SearchItem[]; message?: string }>(
			`${apiRoot(token)}/search/repositories?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`,
			token
		);
		if (!ok) throw new Error(data?.message || 'Repo search failed');
		const batch = data?.items ?? [];
		items.push(...batch);
		if (batch.length < 100) break;
	}
	return items.map((r) => ({
		id: r.id,
		full_name: r.full_name,
		name: r.name,
		owner: r.owner?.login,
		html_url: r.html_url,
		private: r.private,
		description: r.description,
		updated_at: r.updated_at,
		created_at: r.created_at
	}));
}
