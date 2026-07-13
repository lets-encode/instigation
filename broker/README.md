# OAuth session broker (Flask)

The server-side piece of the SPA's GitHub auth. The OAuth token **never reaches
the browser**: the whole flow runs here, the token is kept in a server-side
session, and the browser holds only an opaque httpOnly session cookie.

- `GET /login?return_to=/path` — starts the OAuth flow (redirects to GitHub).
- `GET /authorize` — GitHub's callback: exchanges the code, stores the token in
  the session, redirects back to the SPA (`?auth_error=…` on failure).
- `POST /logout` — revokes the token at GitHub and clears the session.
- `/proxy/<url>` — relays the SPA's GitHub API calls (`api.github.com` only),
  attaching the session's token server-side. Login-gated and rate-limited.

Sessions are files under `instance/sessions` (gitignored, `0700`), shared
between gunicorn workers on the same host; set `SESSION_DIR` to override.

## Same-origin requirement

The broker **must share the SPA's origin** — the session cookie
(`HttpOnly; Secure; SameSite=Lax`) has to be first-party. Mount it under a path
of the SPA's origin:

- production: nginx proxies `/oauth/` to the broker (see `deploy/nginx.conf`),
- development: the Vite dev server proxies `/oauth` (see `vite.config.js`).

The SPA reaches it via `PUBLIC_OAUTH_BROKER_URL`, which defaults to `/oauth`.

## Configure

Environment variables:

| Name | Value |
|---|---|
| `GITHUB_CLIENT_ID` | the OAuth app's client id |
| `GITHUB_CLIENT_SECRET` | the OAuth app's client secret (**secret**, only here) |
| `FLASK_SECRET` | signs the session cookie (**secret**; e.g. `python3 -c "import secrets; print(secrets.token_hex(32))"`) |
| `REDIRECT_URL` | the OAuth callback as the browser reaches it, e.g. `https://your-domain.example/oauth/authorize` — must match the OAuth app's registered callback |
| `FLASK_ENV` | set to `development` locally to allow the cookie over plain HTTP |
| `SESSION_DIR` | optional: session file directory |

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

## Deployment notes

- **HTTPS is required** — the session cookie is marked `Secure` outside
  development, and the OAuth code travels over this connection.
- **Keep the secrets only here** — the client secret and `FLASK_SECRET` never
  appear in the SPA build.
- **Bandwidth** — every authenticated GitHub API call is relayed through this
  service; that is the price of keeping the token out of the browser.
  Anonymous reads (the public campaign listing) still go to GitHub directly.

## Provider note

This broker exists because GitHub offers no PKCE and no CORS on its token
endpoint — and holding the token server-side keeps it out of reach of any
script running in the page. A GitLab deployment could use PKCE directly in the
browser, trading that protection for a serverless setup — auth is a provider
trait (see `src/lib/forge/config.ts`).
