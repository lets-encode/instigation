# OAuth session broker (Flask)

The server-side piece of the SPA's GitHub auth. The OAuth token **never reaches
the browser**: the whole flow runs here, the token is kept in a server-side
session, and the browser holds only an opaque httpOnly session cookie.
The authorization-code exchange also uses PKCE (S256) and requests the
`public_repo` and `notifications` scopes used by repository mutations and
notification muting.

- `GET /login?return_to=/path` — starts the OAuth flow (redirects to GitHub).
- `GET /authorize` — GitHub's callback: exchanges the code, stores the token in
  the session, redirects back to the SPA (`?auth_error=…` on failure).
- `POST /logout` — revokes the token at GitHub and clears the session.
- `/proxy/<url>` — relays the SPA's GitHub API calls (`api.github.com` only),
  attaching the session's token server-side. Login-gated and rate-limited.
- `GET /iiif?url=…` — relays IIIF manifests and canvas images for the
  onboarding wizard. Campaign sources come from arbitrary institutions, which
  rules out both a CSP host allowlist and direct browser fetches (many IIIF
  servers send no CORS headers); relaying same-origin solves both. Login-gated
  and rate-limited; no credentials are attached upstream.
- `/registry/…` — the campaign name registry blueprint: the name → (forge,
  repo id) mapping behind every campaign address, with the claim/register
  lifecycle around it. Claiming and registering are login-gated; resolving a
  name is public. Routes, lifecycle and admin: `registry.py`.

## The registry's lifecycle

A registry row is in one of three statuses: `pending` (a claim held for a
setup in progress), `active` (a registered campaign) or `tombstoned` (a
retired name that stays occupied). A name is taken in two steps because a
campaign's setup takes a while and the name must be safe for the whole of it:
`POST /registry/claim` holds it against a claim token from the moment the
organiser picks it, and `POST /registry/register` presents that token when the
setup is finished. Registration happens at the *end* of setup, not when the
repository is created — a repository is not yet a campaign, and an abandoned
setup must never be published as one. A claim is a short lease: one that
nobody promotes occupies nothing once it has run out (reads report the name
free and the next write drops the row), so there is no sweeper.

The admin surface is two routes: `GET /registry/admin/slugs` (list everything)
and `DELETE /registry/admin/slugs/<name>` (tombstone a name; the row is kept,
so the name stays occupied).

**`/registry/admin/` must be protected by institutional auth at the reverse
proxy** before requests reach the broker (see `deploy/apache.conf`). The
built-in `ADMIN_TOKEN` bearer check is defence in depth and a dev/local
fallback, not the primary control: one shared secret, no rotation, no audit
trail. With `ADMIN_TOKEN` unset, admin routes answer 503 (fail closed).

Sessions are files under `instance/sessions` (gitignored, `0700`), shared
between gunicorn workers on the same host; set `SESSION_DIR` to override. The
session ID is rotated after OAuth login and server-side sessions expire after
12 hours.

## Same-origin requirement

The broker **must share the SPA's origin** — the session cookie
(`HttpOnly; Secure; SameSite=Lax`) has to be first-party. Mount it under a path
of the SPA's origin:

- production: Apache proxies `/auth/` and `/registry/` to the broker (see
  `deploy/apache.conf`),
- development: the Vite dev server proxies `/auth` and `/registry` (see
  `vite.config.js`).

The SPA reaches it via `PUBLIC_BROKER_URL` (default `/auth`) and
`PUBLIC_REGISTRY_URL` (default `/registry`).

## Configure

Environment variables:

| Name | Value |
|---|---|
| `GITHUB_CLIENT_ID` | the OAuth app's client id |
| `GITHUB_CLIENT_SECRET` | the OAuth app's client secret (**secret**, only here) |
| `FLASK_SECRET` | signs the session cookie (**secret**; e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`) |
| `REDIRECT_URL` | the OAuth callback as the browser reaches it, e.g. `https://your-domain.example/auth/authorize` — required outside development and must match the OAuth app's registered callback |
| `FLASK_ENV` | set to `development` locally to allow the cookie over plain HTTP |
| `SESSION_DIR` | optional: session file directory |
| `DB_PATH` | optional: the registry's SQLite file (default `instance/slugs.db`) — the registry's entire state, back it up by copying it |
| `ADMIN_TOKEN` | bearer token for `/registry/admin/` (dev fallback and defence in depth; production gates these routes at the reverse proxy — see `deploy/apache.conf`). Unset ⇒ admin routes answer 503 |

The broker loads these from its process environment. The simplest way locally is a
`broker/.env` file (auto-loaded via python-dotenv, and gitignored):

```sh
cp .env.example .env    # then fill in the values
```

Real environment variables take precedence over `.env`, so in production you can
set them through your service manager instead (systemd `EnvironmentFile=`,
container env, …) and skip the file.

## Run

```sh
pip install -r requirements.txt

# development (reads broker/.env; the Vite proxy makes it same-origin)
flask --app app run --port 7777

# deployed (behind the reverse proxy — see deploy/)
PORT=7777 gunicorn -c gunicorn_config.py wsgi:app
```

`wsgi.py` is a thin shim re-exporting `app`, so service managers can point at the
conventional `wsgi:app` target. `gunicorn_config.py` binds to loopback on
`PORT` (default 7777); each deployed instance runs its own broker on its own
port — production 7777, staging 7778, testing 7779, matching the Apache
ProxyPass targets in `deploy/`. Only the proxy needs to reach the bind
address, so it stays on loopback.

## Test

From the repository root, with the broker requirements installed:

```sh
python -m unittest broker.test_app broker.test_registry -v
```

## GitHub API telemetry

The proxy writes one structured `github_api` log entry for every authenticated
GitHub request. It includes the method, endpoint path, status, duration,
GitHub rate-limit bucket, limit, remaining/used counts, reset time and GitHub
request ID. Query strings, request bodies and OAuth tokens are not logged.

The shared forge client emits the same rate-limit fields in browser developer
tools and GitHub Actions logs. Its in-process counters are available through
`getGitHubRequestTelemetry()` for a browser tab or one coordinator run.
Broker-generated `429` responses carry `X-Lets-Encode-Upstream: broker`, so
they are reported separately from GitHub primary or secondary limits.

## Deployment notes

- **HTTPS is required** — the session cookie is marked `Secure` outside
  development, and the OAuth code travels over this connection. It is the scheme
  the *browser* used that matters, so TLS terminating at a proxy or appliance in
  front is fine.
- **Trust the forwarded client IP** — behind a proxy every request appears to
  come from that proxy, which would turn the rate limits into one bucket shared
  by all users. `ProxyFix` is **not wired in the code**: wrapping the app in it
  (`x_for` set to the number of proxies in front) is a deployer TODO, and until
  it is done the per-client rate limits collapse into that single shared
  bucket. Confirm `request.remote_addr` resolves to a real client.
- **Nothing may rewrite the session cookie** — the production cookie name uses
  the `__Host-` prefix, which browsers reject outright unless the cookie is
  `Secure`, scoped to `Path=/`, and carries no `Domain` attribute. A proxy that
  rewrites cookies will break login with no error in any log.
- **Keep the secrets only here** — the client secret and `FLASK_SECRET` never
  appear in the SPA build.
- **Bandwidth** — every authenticated GitHub API call is relayed through this
  service; that is the price of keeping the token out of the browser.
  Anonymous reads (the public campaign listing) still go to GitHub directly.

## Provider note

This broker exists because holding the token server-side keeps it out of reach
of any script running in the page. PKCE protects the authorization-code exchange
as well. Auth remains a provider trait (see `src/lib/forge/config.ts`).
