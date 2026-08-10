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
PUBLIC_REPO_TOPIC=created-with-lets-encode-instigation-platform
PUBLIC_FORGE=github
PUBLIC_MEI_FRIEND_URL=https://mei-friend.mdw.ac.at
PUBLIC_MEASURE_DETECTOR_URL=https://measure-detector.edirom.de
#PUBLIC_BROKER_URL=/auth
#PUBLIC_REGISTRY_URL=/registry
#PUBLIC_AUTOMATION_REPO=lets-encode/instigation
#PUBLIC_AUTOMATION_REF=main
#PUBLIC_AUTOMATION_PATH=scripts/coordinator.ts
```

The OAuth credentials live only in the broker's env (next step). The SPA reaches
the broker at `PUBLIC_BROKER_URL` (default `/auth`) and the name registry at
`PUBLIC_REGISTRY_URL` (default `/registry`) — both proxied to the broker by the
Vite dev server, and by Apache in production. `PUBLIC_AUTOMATION_*` is the
central automation pointer written into each new campaign's `config.yaml`; pin
`PUBLIC_AUTOMATION_REF` to a commit SHA for production releases. See
`.env.example` for the full commentary.

Vite loads `.env` in every mode and overlays `.env.<mode>` (`development`,
`production`, `staging`, `testing`) on top, so a mode file holds only the
variables whose values differ for that deployment. `svelte.config.js` reads the
same files (via `VITE_CONFIG_MODE`, passed through in `vite.config.js`) to
build the CSP.

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

- `/` — the landing: the full campaign list (search, sort, pagination and an
  open-tasks filter) alongside the start card, unfinished setups and the
  viewer's claimed work.
- `/new` — the six-step campaign creation wizard (name, licence, upload,
  pages, source, pieces). On a clean creation you land on the new campaign's
  console.
- `/dashboard` — the logged-in user's personal dashboard.
- `/<campaign>` — the campaign console (the campaign name; the repo it
  addresses is resolved via the registry).
- `/<campaign>/zones/<task>` — the measure-zone editor for one pre-task.

## 5. Build / preview / test

```bash
npm run build     # static site → ./build (SPA, spa.html fallback; website/ owns index.html)
npm run preview   # serve the built site locally
npm test          # pure campaign-logic unit tests (no network)
```

## 6. Deploy (production / staging / testing)

Three instances run side by side, each deployed from its own branch and fully
isolated from the others (own origin, own broker, own OAuth App, own campaign
repos via `PUBLIC_REPO_TOPIC`):

| Instance   | Branch    | Origin                            | Broker port | Build mode |
|------------|-----------|-----------------------------------|-------------|------------|
| production | `main`    | `lets-encode.mdw.ac.at`           | 7777        | production |
| staging    | `staging` | `staging.lets-encode.mdw.ac.at`   | 7778        | staging    |
| testing    | `testing` | `testing.lets-encode.mdw.ac.at`   | 7779        | testing    |

Local development is the fourth world: the Vite dev server + a local Flask
broker (section 4), with its own OAuth App whose callback is
`http://localhost:5173/auth/authorize`.

- **SPA + broker, one origin:** the broker's session cookie must be
  first-party, so each instance serves its static build and its broker from
  the same origin. The vhosts in `deploy/` (`apache.conf` for production —
  the fully annotated one — plus `apache-staging.conf` and
  `apache-testing.conf`) each serve `/opt/lets-encode/<instance>/current` and
  proxy `/auth/` and `/registry/` to that instance's broker port, behind
  **HTTPS**. They are name-based vhosts on one listen port, so the F5 must
  forward all three hostnames.
- **Server layout:** one git checkout per instance, kept on that instance's
  branch. Each checkout runs its own broker (`PORT=<port> gunicorn -c
  gunicorn_config.py wsgi:app` in `broker/`), so sessions and the slug DB
  (`broker/instance/`) are naturally separate.
- **Deploying the SPA:** from the instance's checkout, on its branch:

  ```bash
  deploy/deploy.sh staging   # or production / testing
  ```

  The script refuses to build from the wrong branch, runs `npm ci` and the
  mode's build, writes it to a fresh directory under
  `/opt/lets-encode/<instance>/releases/`, and atomically repoints the
  `current` symlink the vhost serves. It keeps the five newest releases;
  rolling back is repointing `current` at an older one. Every `PUBLIC_*`
  value — and the CSP in `svelte.config.js` — is baked in at build time, so a
  config change needs a rebuild, not just a re-copy. The broker is not
  touched: restart it separately when `broker/` changed.
- **Broker env, per instance:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
  `FLASK_SECRET`, `PORT`, and
  `REDIRECT_URL=https://<instance-origin>/auth/authorize` (see
  `broker/README.md`). Never share a `FLASK_SECRET` between instances.
- **One OAuth App per instance:** a GitHub OAuth App has a single callback
  URL, so each origin needs its own app registered with
  `https://<instance-origin>/auth/authorize` as the callback (plus the
  localhost one for development).
