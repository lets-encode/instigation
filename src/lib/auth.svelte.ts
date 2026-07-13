// Client-side auth state for the static SPA. The OAuth flow and the GitHub
// token live entirely in the broker (see broker/): /login redirects to GitHub,
// /authorize stores the token in a server-side session, and the browser holds
// only an httpOnly session cookie. API calls authenticate by passing the
// SESSION sentinel, which routes them through the broker's /proxy — the token
// itself is never present in the browser.

import { provider } from './forge/config.ts';
import { createForge } from './forge/index.ts';
import { routeSessionVia, SESSION } from './forge/github-rest.ts';
import type { ForgeClient, GitHubUser } from './forge/types.ts';

routeSessionVia(`${provider.brokerUrl}/proxy/api.github.com`);

type Status = 'loading' | 'authenticated' | 'anonymous';

/**
 * Reactive auth state, shared across the app. `token` is not a credential: it
 * is the SESSION sentinel when logged in (API calls then ride the broker
 * session cookie) and null when anonymous.
 */
export const auth = $state<{
	token: string | null;
	user: GitHubUser | null;
	scope: string;
	error: string | null;
	status: Status;
}>({ token: null, user: null, scope: '', error: null, status: 'loading' });

function clear(): void {
	auth.token = null;
	auth.user = null;
	auth.scope = '';
	auth.status = 'anonymous';
}

/**
 * On app start: ask the API (via the broker proxy) who the session belongs to.
 * A 401 from the proxy means there is no session — anonymous. Also surfaces
 * any ?auth_error the broker redirected back with after a failed login.
 */
export async function initAuth(): Promise<void> {
	const params = new URLSearchParams(location.search);
	if (params.has('auth_error')) {
		auth.error = params.get('auth_error');
		params.delete('auth_error');
		const query = params.toString();
		history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
	}

	const resolved = await createForge(SESSION).getAuthenticatedUser();
	if (!resolved) {
		clear();
		return;
	}
	auth.token = SESSION;
	auth.user = resolved.user;
	auth.scope = resolved.scopes;
	auth.status = 'authenticated';
	console.log('[auth] logged in as', resolved.user.login, 'scope:', resolved.scopes);
}

/** Begin the OAuth dance: the broker remembers `returnTo` and hands off to GitHub. */
export function login(returnTo: string = location.pathname + location.search): void {
	console.log('[auth] starting OAuth login, returning to', returnTo);
	location.assign(`${provider.brokerUrl}/login?return_to=${encodeURIComponent(returnTo)}`);
}

/** Log out: clear local state and end the broker session (which revokes the token). */
export async function logout(): Promise<void> {
	console.log('[auth] logging out');
	clear();
	try {
		await fetch(`${provider.brokerUrl}/logout`, { method: 'POST' });
	} catch {
		// best-effort; the local session is already cleared
	}
}

/** A ForgeClient bound to the current session, or null when anonymous. */
export function forge(): ForgeClient | null {
	return auth.token ? createForge(auth.token) : null;
}
