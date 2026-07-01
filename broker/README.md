# OAuth token broker

A tiny stateless function that lets the backend-less SPA complete GitHub OAuth.
It holds the OAuth **client secret** and does the two things a browser can't:

- `POST /token` `{ code, redirect_uri }` → `{ access_token, scope }` — swaps an
  authorization code for a token (GitHub's token endpoint has no CORS and needs
  the secret).
- `POST /revoke` `{ token }` → `{ ok }` — revokes a token on logout.

No storage, no sessions, no user data. It is the *only* server-side piece of the
system; everything else runs in the browser or in the campaign repo's CI.

## Configure

Set these as the function's environment (Worker secrets/vars):

| Name | Value |
|---|---|
| `GITHUB_CLIENT_ID` | the OAuth app's client id (also public, in the SPA) |
| `GITHUB_CLIENT_SECRET` | the OAuth app's client secret (**secret**, only here) |
| `ALLOWED_ORIGIN` | the SPA's origin, e.g. `https://lets-encode.example` (or `*`) |

The SPA points at this function via `PUBLIC_OAUTH_BROKER_URL` (its base URL).

## Deploy (Cloudflare Workers example)

```
wrangler deploy broker/worker.js --name lets-encode-broker
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_CLIENT_ID
# ALLOWED_ORIGIN can be a plain var in wrangler.toml
```

`worker.js` is a standard `export default { fetch }` module, so it also runs on
Deno Deploy or any equivalent with minimal changes.

## Provider note

This broker exists because GitHub offers no PKCE and no CORS on its token
endpoint. A GitLab deployment can use PKCE directly in the browser and skip the
broker — auth is a provider trait (see `src/lib/forge/config.ts`).
