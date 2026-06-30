// Short-lived in-memory cache of the GitHub user behind a token, so we don't
// hit GitHub's /user endpoint (and its rate limit) on every single request.
// In-memory cache is local to a single process.

import { getAuthenticatedUser } from './github.js';
import type { GitHubUser } from './github.js';

interface ResolvedUser {
	user: GitHubUser;
	scopes: string;
}

const TTL_MS = 60_000; // 1 minute
const cache = new Map<string, { value: ResolvedUser; expires: number }>(); // token -> { value, expires }

/**
 * Resolve `{ user, scopes }` for a token, using a cached value when fresh.
 * Keyed by token, so a fresh login (which mints a new token) misses the cache
 * and resolves against GitHub immediately.
 */
export async function resolveUser(token: string): Promise<ResolvedUser | null> {
	const hit = cache.get(token);
	if (hit && hit.expires > Date.now()) return hit.value;

	const value = await getAuthenticatedUser(token);
	if (value) cache.set(token, { value, expires: Date.now() + TTL_MS });
	else cache.delete(token);
	return value;
}

/** Drop a token from the cache (e.g. on logout). */
export function invalidateUser(token: string): void {
	cache.delete(token);
}
