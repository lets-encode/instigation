# instigation

The **Let's Encode!** instigation GUI: log in with GitHub, create a campaign
repository from a template, and drive its encoding/validation from a console.

It is a **static SPA** (SvelteKit); the only server-side piece is the **OAuth
session broker** (`broker/`, Flask), which keeps the user's GitHub token out of
the browser, relays the SPA's authenticated API calls, and carries the
**campaign name registry** (`broker/registry.py`) — the name → repo id map
behind every campaign address. Full architecture: `DESIGN.md`.

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
**Client secret** go *only* in the broker; the SPA needs neither.

Login requests the `public_repo` scope (plus `notifications` for muting campaign
repos) — enough to create and administer public campaign repos and forks (e.g. to
give their Actions a read/write token), without access to the user's private
repositories. Private campaigns would need the broader `repo` scope.

## 3. Configure the SPA

```bash
cp .env.example .env
```

Fill in `.env` (all `PUBLIC_`, none secret — read at build/dev time by Vite):

```
PUBLIC_TEMPLATE_OWNER=your-username
PUBLIC_TEMPLATE_REPO=your-template-repo
PUBLIC_REPO_TOPIC=created-with-instigation
PUBLIC_FORGE=github
PUBLIC_MEI_FRIEND_URL=https://mei-friend.mdw.ac.at
```

The OAuth credentials live only in the broker's env (next step). The SPA reaches
the broker at `PUBLIC_BROKER_URL` (default `/auth`, proxied to the broker
by the Vite dev server and by nginx in production).

## 4. Run locally (two processes)

**Terminal 1 — the OAuth session broker** (`broker/`, Flask):

```bash
cd broker
pip install -r requirements.txt
cp .env.example .env     # then fill in the values (see broker/README.md)
flask --app app run --port 8787
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

Open <http://localhost:5173> → pick a name on the landing page → **Log in with
GitHub** → create a campaign. On a clean creation you land on its console at
`/<campaign>` (the campaign name; the repo it addresses is resolved from it).

## 5. Build / preview / test

```bash
npm run build     # static site → ./build (SPA, index.html fallback)
npm run preview   # serve the built site locally
npm test          # pure campaign-logic unit tests (no network)
```

## 6. Deploy (production)

- **SPA + broker, one origin:** the broker's session cookie must be first-party,
  so serve the static `./build` and the broker from the same origin —
  `deploy/nginx.conf` is a worked example that serves `build/` and proxies
  `/auth/` and `/registry/` to the broker (gunicorn) behind **HTTPS**.
- **Broker env:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `FLASK_SECRET`,
  and `REDIRECT_URL=https://<your-origin>/auth/authorize` (see `broker/README.md`).
- **OAuth App:** update its callback URL to `<your-origin>/auth/authorize` (or
  register a second app for production).
