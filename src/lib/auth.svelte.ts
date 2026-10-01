// Client-side auth state for the static SPA. The OAuth flow and the GitHub
// token live entirely in the broker (see broker/): /login redirects to GitHub,
// /authorize stores the token in a server-side session, and the browser holds
// only an httpOnly session cookie. API calls authenticate by passing the
// SESSION sentinel, which routes them through the broker's /proxy — the token
// itself is never present in the browser.

import { provider } from "./forge/config.ts";
import { replaceState } from "$app/navigation";
import { createForge } from "./forge/index.ts";
import {
  onSessionRejected,
  routeSessionVia,
  SESSION,
} from "./forge/github-rest.ts";
import type { ForgeClient, GitHubUser } from "./forge/types.ts";

routeSessionVia(`${provider.brokerUrl}/proxy/api.github.com`);

// A session that ends while the app is open (the broker's session lifetime ran
// out, or the token was revoked) shows up as a 401 on the next proxied call.
onSessionRejected(() => {
  if (auth.status !== "authenticated") return;
  clear();
  auth.expired = true;
});

type Status = "loading" | "authenticated" | "anonymous";

/**
 * Reactive auth state, shared across the app. `token` is not a credential: it
 * is the SESSION sentinel when logged in (API calls then ride the broker
 * session cookie) and null when anonymous. `expired` is set when a session
 * that was active is rejected by the broker.
 */
export const auth = $state<{
  token: string | null;
  user: GitHubUser | null;
  scope: string;
  error: string | null;
  expired: boolean;
  status: Status;
}>({
  token: null,
  user: null,
  scope: "",
  error: null,
  expired: false,
  status: "loading",
});

function clear(): void {
  auth.token = null;
  auth.user = null;
  auth.scope = "";
  auth.status = "anonymous";
}

/**
 * On app start: ask the API (via the broker proxy) who the session belongs to.
 * A 401 from the proxy means there is no session — anonymous. Also surfaces
 * any ?auth_error the broker redirected back with after a failed login.
 */
export async function initAuth(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.has("auth_error")) {
    auth.error = params.get("auth_error");
    params.delete("auth_error");
    const query = params.toString();
    replaceState(location.pathname + (query ? `?${query}` : ""), {});
  }

  // Returning to a tab left open re-checks the session, so an expired one is
  // reported before the next action rather than by its failure.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkSession();
  });
  // The broker extends a session on every request it receives and ends it
  // after PERMANENT_SESSION_LIFETIME without one; a periodic check keeps it
  // alive while the app is open.
  setInterval(checkSession, SESSION_CHECK_INTERVAL_MS);

  let resolved;
  try {
    resolved = await createForge(SESSION).getAuthenticatedUser();
  } catch (e) {
    // A failed session check must not leave the app stuck on "loading":
    // continue anonymously and surface the error. A SyntaxError means the
    // response was not JSON: the broker mount is not served on this origin
    // and a page (the SPA fallback) came back instead of session data.
    clear();
    auth.error =
      e instanceof SyntaxError
        ? `the session service at ${provider.brokerUrl} is not answering on this server.`
        : (e as Error).message;
    return;
  }
  if (!resolved) {
    clear();
    return;
  }
  auth.token = SESSION;
  auth.user = resolved.user;
  auth.scope = resolved.scopes;
  auth.status = "authenticated";
  console.log(
    "[auth] logged in as",
    resolved.user.login,
    "scope:",
    resolved.scopes,
  );
}

const SESSION_CHECK_INTERVAL_MS = 30 * 60_000;

/** Ask the broker for the session's user; a rejection marks the session expired. */
function checkSession(): void {
  if (auth.status !== "authenticated") return;
  createForge(SESSION)
    .getAuthenticatedUser()
    .catch(() => {});
}

/** Begin the OAuth dance: the broker remembers `returnTo` and hands off to GitHub. */
export function login(
  returnTo: string = location.pathname + location.search,
): void {
  console.log("[auth] starting OAuth login, returning to", returnTo);
  location.assign(
    `${provider.brokerUrl}/login?return_to=${encodeURIComponent(returnTo)}`,
  );
}

/** Log out: clear local state and end the broker session (which revokes the token). */
export async function logout(): Promise<void> {
  console.log("[auth] logging out");
  clear();
  try {
    await fetch(`${provider.brokerUrl}/logout`, { method: "POST" });
  } catch {
    // best-effort; the local session is already cleared
  }
}

/** A ForgeClient bound to the current session, or null when anonymous. */
export function forge(): ForgeClient | null {
  return auth.token ? createForge(auth.token) : null;
}
