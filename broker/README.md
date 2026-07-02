# OAuth token broker (Flask)

A tiny stateless service that lets the backend-less SPA complete GitHub OAuth.
It holds the OAuth **client secret** and does the two things a browser can't:

- `POST /token` `{ code, redirect_uri }` → `{ access_token, scope }` — swaps an
  authorization code for a token (GitHub's token endpoint has no CORS and needs
  the secret).
- `POST /revoke` `{ token }` → `{ ok }` — revokes a token on logout.

No storage, no sessions, no user data. It is the *only* server-side piece of the
system; everything else runs in the browser or in the campaign repo's CI.

## Configure

Environment variables:

| Name | Value |
|---|---|
| `GITHUB_CLIENT_ID` | the OAuth app's client id (also public, in the SPA) |
| `GITHUB_CLIENT_SECRET` | the OAuth app's client secret (**secret**, only here) |
| `ALLOWED_ORIGIN` | the SPA's origin, e.g. `https://lets-encode.example` (or `*`) |

The SPA points at this service via `PUBLIC_OAUTH_BROKER_URL` (its base URL).

## Run

```sh
pip install -r requirements.txt

# development
GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… ALLOWED_ORIGIN=http://localhost:5173 \
  flask --app app run --port 8787

# production (behind an HTTPS reverse proxy — see below)
gunicorn --bind 127.0.0.1:8787 app:app
```

## Deployment notes

- **HTTPS is required** — the OAuth `code` is sent over this connection. Put the
  app behind a TLS-terminating reverse proxy (nginx, Caddy, …) and point
  `PUBLIC_OAUTH_BROKER_URL` at the `https://` URL.
- **CORS** — the app sets `Access-Control-Allow-Origin: $ALLOWED_ORIGIN` and
  answers the `OPTIONS` preflight. Set `ALLOWED_ORIGIN` to your SPA's exact origin
  in production (`*` is for local testing only). It allows one origin; widen it or
  run another instance if the SPA is served from several origins.
- **Keep the secret only here** — never in the SPA build.

## Provider note

This broker exists because GitHub offers no PKCE and no CORS on its token
endpoint. A GitLab deployment can use PKCE directly in the browser and skip the
broker — auth is a provider trait (see `src/lib/forge/config.ts`).
