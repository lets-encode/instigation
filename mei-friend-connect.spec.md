# mei-friend change: a `connect` URL parameter (open + bind to GitHub, no fork)

Spec for a change to **mei-friend** (`mei-friend/mei-friend`), to be applied in that
repository. Written against `main` as read on 2026-06-30. The instigation side that
consumes this parameter is already wired (see `src/routes/campaign/[owner]/[repo]/+page.server.ts`).

## Why

mei-friend has two GitHub-open entry points via URL parameters today:

| URL | mei-friend behaviour | Can the user commit back? |
|---|---|---|
| `?file=<rawUrl>` | Loads the file as a **plain URL** (`fileLocationType='url'`). No repo binding (`gm.repo`/`branch`/`filepath` stay empty). | **No** — not bound to GitHub; the GitHub commit UI has no repo/branch/file to commit to. |
| `?file=<rawUrl>&fork=true` | **Forks** the repo, binds `gm` to the fork, clones, loads. | Yes — but only into a **fork**. |

Let's Encode needs a third mode for users who **can push to the repo** (owners /
collaborators): open the file **and bind `gm` to that same repo without forking**, so
they can commit directly to a branch in it. You cannot fork a repo you own, so
`fork=true` is not an option for them; and plain `?file=` does not bind, so they cannot
commit at all. This is the gap.

## The new parameter

`?file=<rawGitHubUrl>&connect=true`

- `<rawGitHubUrl>` is a fully-qualified `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>` URL (the same shape `fork=true` already requires).
- When `connect=true` **and** a `file` URL is present, mei-friend binds `gm` to
  `<owner>/<repo>` on `<branch>` at `<path>`, clones and loads the file — **without
  forking**. The user then commits/pushes with mei-friend's normal GitHub commit UI,
  straight to `<branch>` of `<owner>/<repo>`.
- It is the caller's responsibility to use `connect=true` only for users who have push
  access; if they don't, the bind still succeeds but the eventual push fails (a 403 from
  GitHub, surfaced by the existing commit error handling).

`connect` and `fork` are mutually exclusive; if both are `true`, prefer `fork` (or treat
it as an error). Everything `fork=true` already does for not-logged-in users (stash the
request, send through GitHub login, resume on return) should be mirrored for `connect`.

## Implementation

This is deliberately small: `connect=true` is `forkAndOpen` **minus the `gm.fork()` call**.
The post-fork "switch to the branch and open the file" logic already exists in
`forkRepoClicked()` and can be reused directly.

### 1. `app/static/lib/fork-repository.js`

`forkAndOpen(gm, url)` already parses the raw URL into `components` (owner, repo, branch,
file path) by matching branch names against the URL residue. Factor that parsing out and
add a no-fork sibling.

- Extract the URL→`components` parsing (current lines ~155–182, ending at
  `components[5] = residue.slice(branch.name.length + 1)`) into a helper, e.g.
  `async function parseRawGitHubUrl(gm, url)` returning the `components` array (or null).
  `forkAndOpen` keeps calling it, then shows the fork overlay as today.
- Add:

  ```js
  // Open a GitHub file bound to its repo WITHOUT forking (the ?connect=true path).
  // Mirrors forkAndOpen's URL parsing, then binds gm and opens the file directly.
  // Use only when the user can push to <owner>/<repo>; otherwise the later push 403s.
  export async function connectAndOpen(gm, url) {
    const components = await parseRawGitHubUrl(gm, url);
    if (!components) {
      throw new Error('connect: URL does not match raw GitHub URL expectations');
    }
    // components: [full, owner, repo, residue, branch, filepath]
    await openRepoFileOnBranch(gm, components[1], components[2], components[4], '/' + components[5]);
  }
  ```

### 2. `app/static/lib/github-menu.js`

The block inside `forkRepoClicked()` that runs after a successful fork (current lines
~71–88, guarded by `if (inputRepoOverride && inputBranchOverride && inputFilepathOverride)`)
is exactly "switch to this branch of this repo and open this file". Factor it into an
exported helper and call it from both places:

```js
// Bind gm to <userOrg>/<repo> on <branch>, clone, and open <filepathOverride>.
// Shared by the post-fork open (forkRepoClicked) and the no-fork connect path.
export async function openRepoFileOnBranch(gm, userOrg, repo, branch, filepathOverride) {
  gm.repo = `${userOrg}/${repo}`;
  gm.branch = branch;
  const dir = filepathOverride.substring(0, filepathOverride.lastIndexOf('/') + 1);
  gm.filepath = dir;
  setMeiFileInfo(gm.filepath, gm.repo, gm.repo + ':');
  await checkAndClone(`https://github.com/${gm.repo}.git`, gm.branch);
  fillInBranchContents();
}
```

`forkRepoClicked()`'s post-fork block then becomes a call to `openRepoFileOnBranch(...)`
with the existing override values. No behavioural change to the fork path.

### 3. `app/static/lib/main.js`

Alongside the existing `forkParam` handling (current line ~674 reads `fork`; the action
block is at ~line 770, `if (forkParam === 'true' && urlFileName) { ... }`):

```js
let connectParam = searchParams.get('connect');
```

In the guard that currently fetches a plain URL when `?file=` is present **without**
`fork` (current line ~682, `if (urlFileName && !(forkParam === 'true'))`), also exclude
the connect case so it does not double-load as a plain URL:

```js
if (urlFileName && !(forkParam === 'true') && !(connectParam === 'true')) {
  openUrlFetch(new URL(urlFileName));
  urlFetchInProgress = true;
}
```

Then add a connect action block mirroring the fork one (logged-in → act now; logged-out →
stash in storage, log in, resume on return — reuse the same storage key pattern as
`forkAndOpen`, e.g. `connectAndOpen`):

```js
if (connectParam === 'true' && urlFileName) {
  if (isLoggedIn && gm) {
    connectAndOpen(gm, urlFileName);
  } else {
    storage.safelySetStorageItem('connectAndOpen', urlFileName);
    // ...trigger the same login-then-resume flow fork uses...
  }
}
```

And mirror the post-login resume that `forkAndOpen` has (current ~line 744,
`if (storage.forkAndOpen && gm) { forkAndOpen(...) }`):

```js
if (storage.connectAndOpen && gm) {
  connectAndOpen(gm, storage.connectAndOpen);
  storage.removeItem('connectAndOpen');
}
```

Import `connectAndOpen` from `./fork-repository.js`.

## Known limitation to fix while here (affects `fork=true` too)

The URL parser (`forkAndOpen`, and now `connectAndOpen`) splits the path on branch names
but does **not** strip a URL query string or hash. For a **private** repo, the GitHub
Contents API `download_url` carries a short-lived `?token=…`, so the residue becomes
`<branch>/<path>?token=…` and the derived file path is corrupted. Strip `url.search` and
`url.hash` before parsing (parse with `new URL(url)` and use `url.origin + url.pathname`),
so both `connect` and `fork` work for private campaign repos.

## How instigation uses it (already wired, for reference)

`src/routes/campaign/[owner]/[repo]/+page.server.ts`, `editor` action:

- **Owner / collaborator (`canPush`):** the console creates an `encode-<task_id>` branch,
  gets the score's `download_url` **on that branch**, and opens
  `…/?file=<rawUrlOnBranch>&connect=true`. The user commits to that branch; the console
  then opens a same-repo PR (`encode-<task_id>` → default branch).
- **Volunteer (no push):** unchanged — `…/?file=<rawUrl>&fork=true`. The user commits to
  their fork; the console opens a cross-repo PR (`fork:branch` → upstream default branch).

In both cases mei-friend only **commits**; the **console** opens the submission PR that
triggers the submission Action and advances the task to `validation_required`.
