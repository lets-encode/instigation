# instigation

The **Let's Encode!** instigation GUI: log in with GitHub, create a campaign
repository from a template, and drive its encoding/validation from a console.

It is a **static SPA** (SvelteKit); the only server-side piece is the **OAuth
session broker** (`broker/`, Flask), which keeps the user's GitHub token out of
the browser, relays the SPA's authenticated API calls, and carries the
**campaign name registry** (`broker/registry.py`) — the name → repo id map
behind every campaign address.

## How it works

- **Static SPA** (`adapter-static`). The UI runs entirely in the browser and
  drives the GitHub REST API behind a small forge abstraction (`src/lib/forge/`
  — GitHub today, another provider is a drop-in). Authenticated calls are
  relayed through the broker; anonymous reads (the public campaign listing) go
  to the API directly.
- **OAuth session broker.** The Flask service in `broker/` runs the whole OAuth
  flow server-side, holds the client **secret** and the user's **token** in a
  server-side session, and proxies the SPA's API calls with that token. The
  browser only ever holds an httpOnly session cookie, so no script in the page
  can read the token. It must be mounted under the SPA's own origin (`/auth`)
  — see `broker/README.md`.
- **Campaign name registry.** A campaign's address is `/<name>` on this origin.
  The broker's `/registry` blueprint owns the name → (forge, repo id) mapping
  and the claim/register lifecycle around it: the wizard holds a chosen name
  while the setup runs and registers it against the created repo's stable
  numeric id at the end, so the address survives repo renames and transfers.
  Claiming and registering require the GitHub session; resolving a name is
  public. State is one SQLite file (see `broker/registry.py`).
- **Campaign automation** (claim/submit/validate/reaper) runs as GitHub Actions in
  each campaign repo, not here.

## 1. Create the template repo (one-time)

1. On GitHub, create a repo with at least a README.
2. **Settings → Template repository** (tick it).
3. Note its `owner/name` for the config below.

## 2. Register a GitHub OAuth App (one-time)

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:5173/auth/authorize`

Register, then **Generate a new client secret**. Both the **Client ID** and the
**Client secret** go _only_ in the broker; the SPA needs neither.

Login requests the `public_repo` scope (plus `notifications` for muting campaign
repos) — enough to create and administer public campaign repos and forks (e.g. to
give their Actions a read/write token), without access to the user's private
repositories. Private campaigns would need the broader `repo` scope.

## 3. Configure the SPA

All SPA configuration lives in `instances-config/`, committed and public — nothing in it
is secret; the OAuth credentials live only in the broker's env (next step).

- `instances-config/.env` — the values shared by every deployment: the campaign template
  repo (`PUBLIC_TEMPLATE_OWNER`, `PUBLIC_TEMPLATE_REPO`), the forge, and the
  optional mount paths and automation pointer. Vite loads it in every mode.
- `instances-config/.env.production`, `.env.staging`, `.env.testing`,
  `.env.development` — the overlay for one deployment, holding only what
  differs: today the `PUBLIC_REPO_TOPIC` that isolates each instance's campaign
  repos. For builds, `vite.config.js` picks the overlay from the checked-out
  branch (section 6); `npm run dev` uses `.env.development`.
- `instances-config/services.json` — the external services the app talks to (the
  mei-friend instance volunteers are handed off to, the measure detector that
  scaffolds scores). Read by the app and by `svelte.config.js`, which lists
  the detector in the CSP.
- `instances-config/.env.local` and `instances-config/.env.<mode>.local` — personal overrides,
  gitignored, loaded on top of the committed files.

Every value is baked in at build time (`$env/dynamic/public`), so a change
needs a rebuild. The SPA reaches the broker at `PUBLIC_BROKER_URL` (default
`/auth`) and the name registry at `PUBLIC_REGISTRY_URL` (default `/registry`) —
both proxied to the broker by the Vite dev server, and by Apache in production.
`PUBLIC_AUTOMATION_*` is the central automation pointer written into each new
campaign's `config.yaml`; pin `PUBLIC_AUTOMATION_REF` to a commit SHA for
production releases. See the comments in `instances-config/.env` for the full commentary.

## 4. Run locally (two processes)

**Terminal 1 — the OAuth session broker** (`broker/`, Flask):

```bash
cd broker
pip install -r requirements.txt
cp .env.example .env     # then fill in the values (see broker/README.md)
flask --app app run --port 7777
```

The Vite dev server proxies `/auth` and `/registry` to it, so SPA, broker and
registry share an origin. Plain `http://localhost` is fine for local dev
(`FLASK_ENV=development` relaxes the cookie's HTTPS requirement); production
needs HTTPS — see `broker/README.md`.

**Terminal 2 — the SPA:**

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The routes:

- `/` — the project website (`static/index.html` and its files).
- `/campaigns` — the SPA's landing: the full campaign list (search, sort,
  pagination and an open-tasks filter) alongside the start card, unfinished
  setups and the viewer's claimed work.
- `/new` — the six-step campaign creation wizard (name, licence, upload,
  pages, source, pieces). On a clean creation you land on the new campaign's
  console.
- `/<campaign>` — the campaign console (the campaign name; the repo it
  addresses is resolved via the registry).
- `/<campaign>/zones/<task>`, `/<campaign>/review/<task>`,
  `/<campaign>/setup/<task>` — the zone editor, the review view and the score
  setup view for one task.

## 5. Build / preview / test

```bash
npm run build     # static site → ./website (the document root: website index.html at /, SPA fallback spa.html)
npm run preview   # serve the built site locally
npm test          # pure campaign-logic unit tests (no network)
```

Formatting is Prettier (`.prettierrc`) for the app and Black (`broker/pyproject.toml`)
for the broker. `npm run format` applies both; a pre-commit hook rejects
unformatted staged files. One-time setup per clone:

```bash
uv pip install --python broker/.venv/bin/python -r broker/requirements-dev.txt
git config core.hooksPath .githooks
```

## 6. Deploy (production / staging / testing)

Three instances run side by side, each deployed from its own branch and fully
isolated from the others (own origin, own broker, own OAuth App, own campaign
repos via `PUBLIC_REPO_TOPIC`):

| Instance   | Branch    | Origin                          | Broker port | Build mode |
| ---------- | --------- | ------------------------------- | ----------- | ---------- |
| production | `main`    | `lets-encode.mdw.ac.at`         | 7777        | production |
| staging    | `staging` | `staging.lets-encode.mdw.ac.at` | 7778        | staging    |
| testing    | `testing` | `testing.lets-encode.mdw.ac.at` | 7779        | testing    |

Local development is the fourth world: the Vite dev server + a local Flask
broker (section 4), with its own OAuth App whose callback is
`http://localhost:5173/auth/authorize`.

- **Server layout:** one git checkout of this repository per instance, kept on
  that instance's branch. The web server's document root for the instance is
  the checkout's `website/` directory. Each checkout runs its own broker
  (`PORT=<port> gunicorn -c gunicorn_config.py wsgi:app` in `broker/`), so
  sessions and the slug DB (`broker/instance/`) are naturally separate.
- **Deploying:** in the instance's checkout, on its branch:

  ```bash
  git pull
  npm ci
  npm run build
  ```

  The same commands on every instance: `vite.config.js` reads the checked-out
  branch and builds `main` in production mode, `staging` in staging mode and
  `testing` in testing mode, loading that `instances-config/.env.<mode>` overlay (section 3).
  Any other branch builds in development mode; a detached HEAD refuses to
  build without an explicit `--mode`, which always wins over the branch. The
  build empties `website/` and writes the SPA (`_app/`, `spa.html`) and the
  project website (everything in `static/`) into it; requests arriving during
  the build's few seconds get 404s. Every `PUBLIC_*` value — and the CSP in
  `svelte.config.js` — is baked in at build time, so a config change needs a
  rebuild. The broker is a separate process: restart it when `broker/`
  changed.

- **Web server requirements (institution-managed):** the SPA and its broker
  must share one origin, because the broker's session cookie is first-party.
  Each instance's virtual host therefore needs, behind **HTTPS**. The SPA
  fallback ships in `static/.htaccess`, which the mdw server honours; the
  `Header` directive in an `.htaccess` there made Apache answer 500 for the
  whole site, so everything else below is virtual-host configuration:
  - document root `<checkout>/website`, with `index.html` as the directory
    index so the project website answers `/`;
  - a fallback to `/spa.html` for every path that is not an existing file
    (Apache: `FallbackResource /spa.html`, provided by `static/.htaccess`),
    so `/campaigns`, `/new` and `/<campaign>` load the SPA shell;
  - `/auth/` reverse-proxied to `http://127.0.0.1:<broker port>/` with the
    `/auth` prefix stripped (`/auth/login` → `/login`), and `/registry/`
    reverse-proxied to `http://127.0.0.1:<broker port>/registry/` with the
    path unchanged. These must be matched before the document root, so the
    SPA fallback cannot swallow them. `/registry/admin/` must be restricted to
    institutional auth at the proxy (see `broker/README.md`);
  - MIME types `application/wasm` for `.wasm` and `text/javascript` for
    `.mjs` (the score renderer and the PDF worker refuse to load otherwise);
  - `Cache-Control: no-cache` on `.html` files (the shell names hashed
    bundles that a later build replaces) and
    `Cache-Control: public, max-age=31536000, immutable` under
    `/_app/immutable/`;
  - the `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`
    headers on proxied requests (Apache's `mod_proxy` adds the first two by
    default; `X-Forwarded-Proto` needs
    `RequestHeader set X-Forwarded-Proto "https"`), with `PROXY_FIX_X_FOR` in
    the broker's environment set to the number of proxies in front (`1` when
    Apache is the only one). Without `X-Forwarded-Host` the broker sees its
    loopback address as the host and rejects every write with 403
    "cross-origin request rejected" (see `broker/README.md`).
- **Broker env, per instance:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
  `FLASK_SECRET`, `PORT`, and
  `REDIRECT_URL=https://<instance-origin>/auth/authorize` (see
  `broker/README.md`). Never share a `FLASK_SECRET` between instances.
- **One OAuth App per instance:** a GitHub OAuth App has a single callback
  URL, so each origin needs its own app registered with
  `https://<instance-origin>/auth/authorize` as the callback (plus the
  localhost one for development).
