# instigation

The **Let's Encode!** instigation GUI: log in with GitHub, create a campaign
repository from a template, and drive its encoding/validation from a console.

It is a **static SPA** (SvelteKit) with **no backend** — the browser talks to the
GitHub API directly with the logged-in user's token. The only server-side piece is
a tiny stateless **OAuth broker** (`broker/`, Flask). Full architecture: `DESIGN.md`.

## How it works

- **Static SPA** (`adapter-static`). The UI runs entirely in the browser and calls
  the GitHub REST API with the user's token, behind a small forge abstraction
  (`src/lib/forge/` — GitHub today, another provider is a drop-in).
- **OAuth broker.** GitHub can't complete OAuth in the browser (no PKCE, and no
  CORS on its token endpoint), so the Flask service in `broker/` holds the client
  **secret** and only swaps the authorization code for a token. The token then
  lives in the browser's `sessionStorage` — there is no server session or cookie.
- **Campaign automation** (claim/submit/validate/reaper) runs as GitHub Actions in
  each campaign repo, not here.

## 1. Create the template repo (one-time)

1. On GitHub, create a repo with at least a README.
2. **Settings → Template repository** (tick it).
3. Note its `owner/name` for the config below.

## 2. Register a GitHub OAuth App (one-time)

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:5173/auth/callback`

Register, then **Generate a new client secret**. The **Client ID** is public (it
goes in the SPA); the **Client secret** goes *only* in the broker.

Login requests the full `repo` scope — the app needs admin on the repos it creates
(e.g. to give their Actions a read/write token).

## 3. Configure the SPA

```bash
cp .env.example .env
```

Fill in `.env` (all `PUBLIC_`, none secret — read at build/dev time by Vite):

```
PUBLIC_GITHUB_CLIENT_ID=...            # the OAuth app's Client ID
PUBLIC_OAUTH_BROKER_URL=http://localhost:8787
PUBLIC_TEMPLATE_OWNER=your-username
PUBLIC_TEMPLATE_REPO=your-template-repo
PUBLIC_REPO_TOPIC=created-with-instigation
PUBLIC_FORGE=github
PUBLIC_MEI_FRIEND_URL=https://mei-friend.mdw.ac.at
```

The OAuth redirect is derived from the SPA's own origin (`<origin>/auth/callback`),
so it must match the callback URL registered in step 2.

## 4. Run locally (two processes)

**Terminal 1 — the OAuth broker** (`broker/`, Flask):

```bash
cd broker
pip install -r requirements.txt
cp .env.example .env     # then fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
flask --app app run --port 8787
```

Plain `http://localhost` is fine for local dev (browsers treat localhost as a
secure context); production needs HTTPS — see `broker/README.md`.

**Terminal 2 — the SPA:**

```bash
npm install
npm run dev
```

Open <http://localhost:5173> → **Log in with GitHub** → create a campaign. On a
clean creation you land on its console at `/campaign/<owner>/<repo>`.

## 5. Build / preview / test

```bash
npm run build     # static site → ./build (SPA, index.html fallback)
npm run preview   # serve the built site locally
npm test          # pure campaign-logic unit tests (no network)
```

## 6. Deploy (production)

- **SPA:** host `./build` on any static host / CDN (GitHub Pages, Netlify, nginx,
  …). Set the `PUBLIC_*` vars for the real origin at build time, with
  `PUBLIC_OAUTH_BROKER_URL` pointing at the deployed broker.
- **Broker:** deploy `broker/` behind **HTTPS** (see `broker/README.md`); set its
  `GITHUB_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and `ALLOWED_ORIGIN=<your SPA origin>`.
- **OAuth App:** update its callback URL to `<your-origin>/auth/callback` (or
  register a second app for production).

`deploy/nginx.conf` is a worked example that serves `build/` and proxies the
broker under the same origin (`/oauth`), so the SPA and broker are same-origin.
