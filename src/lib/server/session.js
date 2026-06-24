// Short-lived in-memory cache of the GitHub user behind a token, so we don't
// hit GitHub's /user endpoint (and its rate limit) on every single request.
// Single-node only — fine for this app's deployment.

import { getAuthenticatedUser } from './github.js';

const TTL_MS = 60_000; // 1 minute
const cache = new Map(); // token -> { value: { user, scopes }, expires }

/**
 * Resolve `{ user, scopes }` for a token, using a cached value when fresh.
 * Keyed by token, so a step-up authorization (which mints a new token) misses
 * the cache and picks up the upgraded scopes immediately.
 */
export async function resolveUser(token) {
	const hit = cache.get(token);
	if (hit && hit.expires > Date.now()) return hit.value;

	const value = await getAuthenticatedUser(token);
	if (value) cache.set(token, { value, expires: Date.now() + TTL_MS });
	else cache.delete(token);
	return value;
}

/** Drop a token from the cache (e.g. on logout). */
export function invalidateUser(token) {
	cache.delete(token);
}
