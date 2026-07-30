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
- `/registry/…` — the campaign name registry blueprint: the name → (forge,
  repo id) mapping behind every campaign address, with the claim/register
  lifecycle around it. Claiming and registering are login-gated; resolving a
  name is public. Routes, lifecycle and admin: `registry.py`.

Sessions are files under `instance/sessions` (gitignored, `0700`), shared
between gunicorn workers on the same host; set `SESSION_DIR` to override. The
session ID is rotated after OAuth login and server-side sessions expire after
12 hours.

## Same-origin requirement

The broker **must share the SPA's origin** — the session cookie
(`HttpOnly; Secure; SameSite=Lax`) has to be first-party. Mount it under a path
of the SPA's origin:

- production: nginx proxies `/auth/` and `/registry/` to the broker (see
  `deploy/nginx.conf`),
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
| `ADMIN_TOKEN` | bearer token for `/registry/admin/` (dev fallback and defence in depth; production gates these routes at the reverse proxy — see `deploy/nginx.conf`). Unset ⇒ admin routes answer 503 |

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
flask --app app run --port 8787

# production (behind the TLS-terminating nginx — see deploy/nginx.conf)
gunicorn --bind 127.0.0.1:8787 app:app
```

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
  development, and the OAuth code travels over this connection.
- **Keep the secrets only here** — the client secret and `FLASK_SECRET` never
  appear in the SPA build.
- **Bandwidth** — every authenticated GitHub API call is relayed through this
  service; that is the price of keeping the token out of the browser.
  Anonymous reads (the public campaign listing) still go to GitHub directly.

## Provider note

This broker exists because holding the token server-side keeps it out of reach
of any script running in the page. PKCE protects the authorization-code exchange
as well. Auth remains a provider trait (see `src/lib/forge/config.ts`).
