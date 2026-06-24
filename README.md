# instigation

A small SvelteKit app: log in with GitHub (OAuth) and create a new repository from a template, choosing its name, description and visibility.

## How it works

- **SvelteKit full-stack.** The Svelte UI and the server logic live in one app. Server routes (`+server.js`, server `actions`) hold the OAuth `client_secret` and call the GitHub API — the secret never reaches the browser.
- The access token is stored in an **httpOnly cookie** (`gh_token`); the browser JS can't read it.
- In **dev** you just run Vite. In **production** you run the Node build behind **nginx** (see `deploy/nginx.conf`).

## 1. Create the template repo (one-time, you do this)

1. On GitHub, create a new repository with at least a README.
2. Open its **Settings** and tick **"Template repository"**.
3. Note its `owner/name` — you'll put it in `.env`.

## 2. Register a GitHub OAuth App (one-time)

GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:

- **Application name:** anything (e.g. "instigation dev")
- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:5173/auth/callback`

Click **Register**, then **Generate a new client secret**. Copy the **Client ID** and **Client secret**.

## 3. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_OAUTH_REDIRECT_URI=http://localhost:5173/auth/callback
TEMPLATE_OWNER=your-username
TEMPLATE_REPO=your-template-repo
```

**Permissions (least privilege).** Login requests only the minimal `public_repo`
scope. The first time someone creates a **private** repo, the app sends them
through GitHub once more to approve the broader `repo` scope (step-up
authorization), then returns and finishes creating the repo.

## 4. Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173 → "Log in with GitHub" → create a repo.

## Deploying later (web)

```bash
npm run build          # outputs ./build (Node server)

# IMPORTANT behind a TLS-terminating proxy (nginx): the Node app sees plain
# HTTP, so it must be told the real origin/protocol. Without this, session
# cookies won't get the `Secure` flag and form POSTs (create/logout) are
# rejected by SvelteKit's CSRF check.
ORIGIN=https://your-domain \
PROTOCOL_HEADER=x-forwarded-proto \
HOST_HEADER=x-forwarded-host \
HOST=127.0.0.1 PORT=3000 node build
```

Then:

- register a **second** OAuth App (or update the callback URL) for your real domain, and set `GITHUB_OAUTH_REDIRECT_URI=https://your-domain/auth/callback`,
- put nginx in front (`deploy/nginx.conf`), add TLS. With `PROTOCOL_HEADER` set as above, the app sees the request as https and the cookies get the `Secure` flag automatically.
