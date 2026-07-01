// Client-side OAuth for the static SPA. The browser can't hold the client secret
// or call GitHub's token endpoint (no CORS), so the code→token swap and revoke go
// through the stateless broker (see broker/). The token lives in sessionStorage
// (dies with the tab) plus an in-memory rune store; there is no server session.

import { provider } from './forge/config.ts';
import { createForge } from './forge/index.ts';
import type { ForgeClient, GitHubUser } from './forge/types.ts';

const TOKEN_KEY = 'forge_token';
const STATE_KEY = 'oauth_state';
const RETURN_KEY = 'oauth_return';

type Status = 'loading' | 'authenticated' | 'anonymous';

/** Reactive auth state, shared across the app. */
export const auth = $state<{
	token: string | null;
	user: GitHubUser | null;
	scope: string;
	status: Status;
}>({ token: null, user: null, scope: '', status: 'loading' });

/** The OAuth redirect target — derived from the origin; register it on the app. */
function redirectUri(): string {
	return `${location.origin}/auth/callback`;
}

/** Resolve the user behind a token; on success populate the store, else clear. */
async function adoptToken(token: string): Promise<boolean> {
	const resolved = await createForge(token).getAuthenticatedUser();
	if (!resolved) {
		clear();
		return false;
	}
	sessionStorage.setItem(TOKEN_KEY, token);
	auth.token = token;
	auth.user = resolved.user;
	auth.scope = resolved.scopes;
	auth.status = 'authenticated';
	return true;
}

function clear(): void {
	sessionStorage.removeItem(TOKEN_KEY);
	auth.token = null;
	auth.user = null;
	auth.scope = '';
	auth.status = 'anonymous';
}

/** On app start: adopt any token already in sessionStorage, else go anonymous. */
export async function initAuth(): Promise<void> {
	const token = sessionStorage.getItem(TOKEN_KEY);
	if (token) await adoptToken(token);
	else auth.status = 'anonymous';
}

/** Begin the OAuth dance: remember where we were, then hand off to the provider. */
export function login(returnTo: string = location.pathname + location.search): void {
	const state = crypto.randomUUID();
	sessionStorage.setItem(STATE_KEY, state);
	if (returnTo.startsWith('/')) sessionStorage.setItem(RETURN_KEY, returnTo);

	const authorize = new URL(provider.authorizeUrl);
	authorize.searchParams.set('client_id', provider.clientId);
	authorize.searchParams.set('redirect_uri', redirectUri());
	authorize.searchParams.set('scope', provider.scope);
	authorize.searchParams.set('state', state);
	location.assign(authorize.toString());
}

/**
 * Handle the provider's redirect back to /auth/callback: verify state, swap the
 * code for a token via the broker, adopt it. Returns the path to return to.
 * Throws on a denied grant, a bad state, or a failed exchange.
 */
export async function handleCallback(url: URL): Promise<string> {
	const returnTo = sessionStorage.getItem(RETURN_KEY) || '/';
	sessionStorage.removeItem(RETURN_KEY);

	if (url.searchParams.get('error')) {
		throw new Error(url.searchParams.get('error_description') || 'Authorization was denied.');
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const expected = sessionStorage.getItem(STATE_KEY);
	sessionStorage.removeItem(STATE_KEY);
	if (!code || !state || state !== expected) {
		throw new Error('Invalid OAuth state. Please try logging in again.');
	}

	const res = await fetch(`${provider.brokerUrl}/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ code, redirect_uri: redirectUri() })
	});
	const data: { access_token?: string; error?: string } = await res.json().catch(() => ({}));
	if (!res.ok || !data.access_token) {
		throw new Error(data.error || 'Login failed. Please try again.');
	}

	await adoptToken(data.access_token);
	return returnTo;
}

/** Log out: drop the token locally and best-effort revoke it at the broker. */
export async function logout(): Promise<void> {
	const token = auth.token;
	clear();
	if (token && provider.brokerUrl) {
		try {
			await fetch(`${provider.brokerUrl}/revoke`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token })
			});
		} catch {
			// best-effort; the local session is already cleared
		}
	}
}

/** A ForgeClient bound to the current token, or null when anonymous. */
export function forge(): ForgeClient | null {
	return auth.token ? createForge(auth.token) : null;
}
