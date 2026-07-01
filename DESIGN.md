# Let's Encode! — design & status

**Let's Encode!** is a decentralised crowd-encoding system for music scores. No central server owns
campaign state: each campaign is an ordinary Git repository, and all coordination logic (task
assignment, locking, validation, merging, attribution) runs in **one generic GitHub Actions
workflow** in that repo — a task-agnostic *caller* that forwards the triggering event to a **central
automation repository** and commits the result back. Two thin clients drive the system: a **static
instigation GUI** (organiser creates/configures a campaign) and the **mei-friend volunteer client**
(contributors encode/validate).

> Single authoritative design + status document. This describes the **target** architecture of the
> backendless restructure; §9 records what is currently migrated. Scope is **v1**: the `whole`
> fragmentation strategy (one campaign = one task = the whole `sources/score.mei`). Coding guidelines
> to honour are in `CLAUDE.md` (simplicity, surgical changes, goal-driven).

## 1. Architecture at a glance

```
Instigation GUI (static SPA)                         ← user's forge token, in the browser
  │  create campaign (generate + commit) · read tables · open contribution PRs
  ▼
Campaign repository                                  ← data + ONE task-agnostic caller
  config.yaml · sources/score.mei · tracking/*.csv
  .github/workflows/caller.yml
  │  on pull_request_target / schedule:
  │  read central pointer from config (base ref) → checkout central → run it
  ▼
Central automation repository (e.g. lets-encode/automation)
  one coordinator entry + pure decision modules (provider-neutral)
  │  decide + mutate tables/MEI (optimistic concurrency); attribute to the PR author
  ▼
Campaign repository                                  ← results committed back, PR closed
```

Two copy mechanisms: **generate** (template → independent campaign repo) for instigation; **fork +
pull request** for contributions (the model that makes cross-repo PRs cheap and standard). The
campaign repo carries *no* task logic — only its data and a forwarder; every decision lives centrally.

## 2. The components

- **Instigation GUI** (`instigation/`, a SvelteKit **static** app, `adapter-static`) — no backend.
  The organiser logs in with the forge (OAuth via a stateless token broker, §8), then the browser
  uses a **`ForgeClient`** (the user's token, direct to the forge API) to: create the campaign repo
  from the template and initialise it (Action A, §7), read the tracking tables, and open the
  contribution PRs that drive the automation (the campaign console).
- **Campaign repository** — an independent repo stamped from the template
  (`lets-encode/user-repo-template`). Holds `config.yaml`, `sources/score.mei`, the two tracking
  tables, and a single generic `caller.yml`. The heart of the system, and deliberately logic-free.
- **Central automation repository** (e.g. `lets-encode/automation`) — one coordinator entry plus the
  pure, tested decision modules the caller runs. Provider-neutral. Pinned by ref from the campaign's
  own config, so upgrading a live campaign is a config commit, not a workflow edit.
- **mei-friend volunteer client** — where contributors encode/validate. External; in scope here only
  for the PR contract it relies on (§6).

## 3. Settled decisions

| Decision | Resolution |
|---|---|
| Backend | **None.** The former SvelteKit server was only a forge REST client on the user's token; it moves to the browser. Deploy as static assets. |
| OAuth | **Token broker** — one ~20-line stateless function holds the client secret and only swaps `code`→`token` (GitHub offers no PKCE and no CORS on its token endpoint). A *provider trait*: GitLab supports PKCE, so it needs no broker. |
| Per-repo workflows | **One generic, task-agnostic caller** replaces any per-task workflows. Triggers: `pull_request_target` (all contributions) + `schedule` (the reaper). It forwards the event; central decides what to do. |
| Central location | **Read from the campaign config on the base ref** (§4) — never hardcoded, never taken from the fork. The pinned ref lives in that config. |
| Central logic | Lives in the **central automation repo**; the campaign repo carries none. |
| Provider independence | A **`ForgeClient` seam** + a provider-config object (API base, OAuth endpoints, raw-URL pattern, fork/PR verbs). No hardcoded hosts or paths. GitHub implemented now; GitLab/others later are a drop-in (§8). |
| Campaign ownership | The **instigator's personal account**. Consequence: keep the `canPush` dual-path — the owner contributes via a same-repo branch (mei-friend `connect=true`); everyone else forks + PRs. |
| Table integrity | **The Action is the sole author of all table mutations.** Fork+PR contributors have zero write access, so this holds without branch protection (§6). |
| Generate vs fork | generate for instigation; fork for contributions. |
| Table / config format | **CSV** tables (one cell/row per PR → minimal diffs); **YAML** config. Users never read/write them directly; the GUI presents them. |
| Concurrency | **Optimistic** — read the branch-head SHA, decide, commit non-fast-forward, retry on conflict (§6). |
| Ids / timestamps | zero-padded `T0001…`; ISO-8601 UTC (`…Z`). |

## 4. The generic caller — triggers & forwarded parameters

This is the crux of "no task logic in the campaign repo." The pattern follows mei-friend's
[caller-template](https://github.com/mei-friend/caller-template) → [automation](https://github.com/mei-friend/automation)
split, **adapted for a multi-user, event-driven flow**: mei-friend's caller is triggered by
`workflow_dispatch` and receives everything as explicit inputs (`workpackage_id`, `filepath`,
`parameters`, `commit_message`, …); Let's Encode is triggered by `pull_request_target`/`schedule`,
which **carry no custom inputs** — so the parameters come from two other places instead.

**(a) The central pointer — from the campaign config, on the base ref.** The caller has nothing
hardcoded. It checks out the campaign repo (its base tree — safe; see below) and reads three fields
from `config.yaml`:

| Config field | Meaning |
|---|---|
| `automation.central_repository` | `owner/repo` of the automation logic (provider-neutral data). |
| `automation.ref` | Immutable tag/SHA to pin (upgrading = a config commit). |
| `automation.path` | Entry-point script within that repo. |

Reading these from the **base** ref is a security boundary: a fork PR cannot redirect where central
lives, because the fork's version of `config.yaml` is never used.

**(b) The event context — forwarded to central as environment.** The only "parameters" the central
entry needs are the identity of the event; it derives the rest itself.

| Env var | `pull_request_target` | `schedule` |
|---|---|---|
| `GH_TOKEN` | base repo's `GITHUB_TOKEN` (write) | same |
| `BASE_REPO` | `owner/repo` | same |
| `EVENT_NAME` | `pull_request_target` | `schedule` |
| `PR_NUMBER`, `PR_AUTHOR` | from the PR | — |
| `HEAD_REPO`, `HEAD_SHA`, `HEAD_REF` | the PR head (fork or same-repo) | — |

**What is *not* forwarded — central derives or reads it as data:**

- **Which operation** (claim / encode / validate) — inferred from the PR's *changed paths*
  (`locks.csv` → claim; `sources/**` → encoding; `state.csv` → validation). No `workpackage_id`.
- **The intent values** (task id, claim kind, pass/fail verdict) — read from the PR's proposed table
  diff, treated as data (never merged verbatim; §6). No `parameters` input.
- **Config values** (`pass_threshold`, `required_validations`, `stale_after_minutes`) — read from
  `config.yaml`. 
- **Commit message** — the central entry commits via the forge API itself (for optimistic
  concurrency + PR closing), so there is no `commit_message` input.

**Sketch** (`user-repo-template/.github/workflows/caller.yml`, byte-identical in every campaign):

```yaml
name: Campaign automation
on:
  pull_request_target:
    types: [opened, reopened, synchronize]
    # optional: paths-filter to the three tracked areas to avoid firing on unrelated PRs
  schedule:
    - cron: '*/15 * * * *'   # reaper; coarse timing is fine (logic compares elapsed time)
concurrency: { group: campaign-${{ github.repository }}, cancel-in-progress: false }
permissions: { contents: write, pull-requests: write }
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4                       # base tree ONLY (never the fork head)
      - id: cfg                                         # read central pointer from base config
        run: |                                          # targeted reads — no yq/YAML dep required
          echo "repo=$(sed -n 's/.*central_repository: *//p' config.yaml)" >> "$GITHUB_OUTPUT"
          echo "ref=$(sed  -n 's/.*ref: *//p'               config.yaml)" >> "$GITHUB_OUTPUT"
          echo "path=$(sed -n 's/.*path: *//p'              config.yaml)" >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v4
        with: { repository: '${{ steps.cfg.outputs.repo }}', ref: '${{ steps.cfg.outputs.ref }}', path: central }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }                      # bare-node type-stripping; no build step
      - run: sudo apt-get install -y libxml2-utils       # xmllint (MEI well-formedness)
      - env:                                            # (b) event context → central
          GH_TOKEN:   ${{ github.token }}
          BASE_REPO:  ${{ github.repository }}
          EVENT_NAME: ${{ github.event_name }}
          PR_NUMBER:  ${{ github.event.pull_request.number }}
          PR_AUTHOR:  ${{ github.event.pull_request.user.login }}
          HEAD_REPO:  ${{ github.event.pull_request.head.repo.full_name }}
          HEAD_SHA:   ${{ github.event.pull_request.head.sha }}
          HEAD_REF:   ${{ github.event.pull_request.head.ref }}
        run: node central/${{ steps.cfg.outputs.path }}
```

**Trust boundary.** `pull_request_target` runs in the **base** repo's context with a write token;
`actions/checkout` defaults to the base tree, so the fork's code is **never executed** — it is read
only as data (its changed paths + the blob at `HEAD_SHA`, via the API). The caller must never check
out the fork head.

## 5. Config & table formats (v1)

### config.yaml

Authored once at instigation. Minimal but extensible; growth points marked `(reserved)`.

```yaml
schema_version: 1
campaign:      { title, description, instigator, language, license }
automation:    { central_repository, ref, path }   # the central pointer (§4a); ref is pinned
sources:       [ { id, kind: mei-template, path, template, header: { composer } } ]
fragmentation: { strategy: whole }
validation:    { required_validations, pass_threshold }
locking:       { stale_after_minutes }
```

### state.csv — one row per task

`task_id, fragment, state, encoder, encoded_at, v1 … vn`

- `state`: `encoding_required` → `validation_required` → `completed`.
- `v1…vn`: validation cells, count = `required_validations`. Each is empty or `status|user|timestamp`
  with status ∈ `pass|fail` (pipe avoids colliding with the colons in timestamps). In-progress
  validation is tracked by a `validation` lock, not an in-cell marker.

### locks.csv — one row per active claim (header-only after init)

`task_id, locked_by, locked_at, kind` with `kind` ∈ `encoding|validation`. The reaper compares
`locked_at` against `stale_after_minutes`.

> A richer data model (`task`/`lock`/`state`/`history` tables keyed by `(taskID, subtaskID)`, with
> per-task `locator`/allowlist/blocklist and an append-only log) is designed but **deferred** — §10.

## 6. Volunteer PR contract & trust

One caller routes every contribution by changed path; the accept logic below lives in the central
automation repo.

**Trust model.** The caller fires on `pull_request_target`: it runs trusted central code in the base
repo's context (write token), reading the fork PR only as **data** (§4). No fork checkout, no fork
code executed.

**Integrity — the Action authors all table mutations.** A contribution PR supplies only (a) *intent*
(which task, claim kind, or pass/fail verdict) and (b) *MEI content*. The Action derives the
authoritative row/cell itself:

| Field | Authoritative source |
|---|---|
| `locked_by` / `encoder` / validator login | the **PR author** (from the event) |
| `locked_at` / `encoded_at` / validation time | **server time** |
| validation `pass`/`fail` | the volunteer's verdict, stamped with their login + time |
| MEI bytes | the **fork's content**, after the machine-check |

Table changes are *applied by the Action*, not merged from fork bytes (a boundary check limits *which*
cells change, not *what* goes in). MEI content is the volunteer's and is merged.

**The three PR types** (distinguished by changed path):

| PR | Allowed change | Carries |
|---|---|---|
| Claim | `tracking/locks.csv` only | task_id, kind |
| Encoding | the task's fragment (`sources/score.mei`) only | the MEI content |
| Validation | `tracking/state.csv` only | pass/fail verdict |

**Accept rules.**

- *Claim:* task exists; for `encoding`, state is `encoding_required` and no active encoding lock; for
  `validation`, state is `validation_required`, an open slot exists (`final cells + active validation
  locks < required_validations`), the claimant isn't already holding one, and **isn't the encoder**
  (no self-validation).
- *Encoding:* PR touches only the fragment, author holds the active encoding lock, MEI passes the
  machine-check → set `encoder`/`encoded_at`, state → `validation_required`, drop the lock.
- *Validation:* author holds the active validation lock → write the first open `vN` =
  `verdict|author|now`, drop the lock; once `pass_threshold` passes accumulate, → `completed`.

**Race arbitration (optimistic concurrency).** The forge serialises writes to `main`. The central
entry reads the tables pinned to the branch-head SHA, decides, then commits on that exact parent with
a non-fast-forward ref update. If a competing change merged first, the update fails → re-read,
re-decide (now sees the new lock) → reject cleanly. First valid claim wins. Claim/validation PRs are
**closed, not merged** (the authoritative change is the Action's own commit); encoding PRs contribute
their MEI content.

**MEI machine-check.** Well-formed XML (via `xmllint`, now) + schema-valid MEI (validator still to
choose; the template declares MEI-CMN 5.0). Musical correctness is *not* machine-checked — that is
the human `vN` validation.

**Same-repo vs fork (the `canPush` dual-path).** Because campaigns live in the instigator's personal
account, the owner can't fork their own repo: the console commits on a same-repo `encode-<task_id>`
branch and binds mei-friend with `connect=true` (open + bind, no fork). Everyone else forks
(`fork=true`) and the console opens a cross-repo PR upstream. Both produce a `pull_request_target`
event the one caller handles identically.

**End to end (v1, one note):**

```
init:                       T0001 … encoding_required           locks: —
bob claims encoding                                             locks: T0001,bob,…,encoding
bob submits encoding        encoder=bob, validation_required    locks: —   (score.mei merged)
carol claims validation     (carol ≠ bob)                       locks: T0001,carol,…,validation
carol submits pass          v1=pass|carol|… ; threshold → completed        locks: —
```

## 7. Instigation (Action A) — client-side

At creation the GUI, using the organiser's token in the browser via the `ForgeClient`:

1. **generates** the campaign repo from the template into the instigator's account,
2. sets the repo's Actions token to read/write (so the caller can commit tables + close PRs),
3. commits, in one commit: `config.yaml` (including the `automation` pointer), the stamped
   `sources/score.mei` (fills `{{TITLE}}`/`{{COMPOSER}}`/`{{LICENSE}}`), `state.csv` (one task
   `T0001`, `encoding_required`, empty `vN`) and a header-only `locks.csv`.

Idempotent: output is fully determined by config + template, so re-running before any contribution
reproduces identical files. Runs client-side because the organiser is in the loop; everything else
runs in the campaign repo's caller.

## 8. Provider-agnostic design

Two provider-touching surfaces, cleanly separated so a second forge is additive:

- **Client `ForgeClient` interface** — identity/OAuth, repo-from-template, read/write files, commit,
  branch, list, **fork + open change-request**, raw-file URL, and CI-trigger. A `GitHubForge` implements
  it now; all specifics (API base, OAuth endpoints, raw-URL pattern, fork/PR verbs, auth strategy)
  live in a per-provider **config object** — **no hardcoded hosts or paths anywhere**. Auth is a
  provider trait: GitHub → token broker; GitLab → PKCE (no broker).
- **Automation logic is provider-neutral by construction** — the coordinator + decision modules read
  and mutate files via the `ForgeClient`. The only provider-specific artefact is the **caller**
  itself (GitHub Actions YAML now; a structurally identical GitLab CI job later — fork MR event →
  read central pointer → run central). The decision modules and `config.yaml` port unchanged.
- **Implementing a new provider** (e.g. GitLab) = a new `ForgeClient` + its config + a caller in that
  provider's CI dialect. Most operations map to that provider's REST (create-from-template, fork,
  merge requests, pipeline dispatch, search — none of which are plain git). For the *git subset* only
  (read file, commit, branch, head), [isomorphic-git](https://isomorphic-git.org/) is an option behind
  the seam — worth considering if a provider's REST is browser-hostile for commits, or for client-side
  diff/merge/offline. Trade-offs: it speaks the git smart-HTTP protocol, which most hosts serve without
  CORS (so it needs a CORS proxy — unlike GitHub's CORS-friendly REST), and it needs an in-browser
  filesystem. Not adopted now: the GitHub REST implementation needs no proxy and maps directly onto the
  optimistic-concurrency commit (§6).

## 9. Status

This document describes the target. **Current code is mid-migration** — the pre-restructure shape is
still in place and is being replaced per the plan:

- Instigation GUI still uses `adapter-node` with a real server: OAuth (`login`/`auth/callback`/
  `logout`, httpOnly-cookie session in `hooks.server.ts`), Action A, and the console all run as
  server `load`/actions. → move to a static SPA + `ForgeClient` + token broker (§2, §7, §8).
- The template still ships **three** thin caller workflows (`claim.yml`, `submit.yml`, `reaper.yml`)
  that check out `lets-encode/instigation@main` and run `scripts/{claim,submit,reap}.mjs`. → collapse
  to the **one** generic `caller.yml` (§4) forwarding to a central automation repo.
- Central code currently lives inside `instigation/` (`src/lib/server/campaign-*.ts` decision logic
  with unit tests; `scripts/*.mjs` shells). → split into `lets-encode/automation`, consolidating the
  three shells into one coordinator entry that branches on `EVENT_NAME` + changed paths and reuses the
  pure modules.

Reused as-is: the pure, tested decision logic (`campaign-init`, `campaign-tables`, `campaign-claim`,
`campaign-submit`, `campaign-reaper`) — GitHub is never touched in those tests. Convention: decision
logic stays pure and tested; only thin shells touch the forge.

**Runtime.** Central code is TypeScript run by bare `node` (≥23.6 type-stripping), so the caller pins
`node-version: 24` and shell imports use real `.ts` specifiers. The SPA imports the same modules via
Vite. No build step for the automation.

## 10. Roadmap & deferred

Migration order (each phase independently shippable):

1. **Backendless SPA** — static adapter, `ForgeClient`(GitHub) seam, token broker; keep today's
   single-task `whole` model working. Verify with a browser smoke test of `generate` + a commit
   sequence against the forge API (the load-bearing CORS assumption).
2. **One generic caller + central automation repo** — collapse the three callers; stand up
   `lets-encode/automation`; live end-to-end (claim → encode → validate → reap) on a throwaway campaign.

Deferred (designed, not built):

- **Richer data model** — tables keyed by `(taskID, subtaskID)`. Granularity differs by activity: a
  **task** is the unit of *encoding* (larger portion, one encoder) and its **subtasks** are the units
  of *validation* (smaller portions, reviewed in parallel) — hence the composite key everywhere,
  addressing either the whole task or one sub-portion.
  - `task`: `taskID, subtaskID, locator, allowlist, blocklist` (`locator` = an MEI `xml:id`, or a
    controlled-vocab term for pre-tasks) — realises the reserved `by_measure`/`by_section` strategies.
  - `state`: `taskID, subtaskID, status, validate_status_1…n`.
  - `lock`: `taskID, subtaskID, userID, timestamp, kind`. **`kind` is kept**: encoding is exclusive
    (no parallel editing — one encoding lock per task) while validation is concurrent (several
    validators review the same encoded work), so `kind` tells the two apart.
  - `history`/`log`: append-only record of all actions, including rejects (attribution + audit).
- **Onboarding wizard + pre-tasks** — collect *what/have/validation-policy*; for PDF sources run
  measure-detection + header pre-fill and the pre-tasks (sb/pb, scoreDef, staffDef); then
  algorithmically generate the task table. Heavy compute runs in Actions, which adds a
  `workflow_dispatch` path to the caller carrying mei-friend-style inputs (`workpackage_id`,
  `filepath`, `parameters`) — the dispatch counterpart to §4's event path.
- **Allow/blocklist enforcement** — an optional per-task gate in the accept logic; **default open**
  (anyone can claim).
- **GitLab (and other) `ForgeClient`** implementations behind the §8 seam.

## 11. Before production — hardening checklist

- [ ] **Pin the central ref.** `automation.ref` in each campaign's `config.yaml` must be an immutable
  tag/SHA, not a moving branch; upgrade by committing a new ref. (Iteration may use `main`.)
- [ ] **Central reachability** — simplest if the central automation repo is public; else the checkout
  needs a token.
- [ ] **Never execute fork code** — the caller checks out the base tree only; the fork is data (§4, §6).
- [ ] **Read the central pointer from the base ref** — never from the PR head (§4a).
- [ ] **Token handling in the SPA** — the forge token lives in `sessionStorage`/memory (no httpOnly
  cookie), so it is XSS-reachable: ship a strict CSP, no third-party scripts, prefer `sessionStorage`.
- [ ] **Broker** — stateless, holds only the client secret, CORS-restricted to the app origin.
- [ ] **Actions write permissions** — the create flow sets the repo's default workflow token to write;
  confirm for any org-owned repos.
- [ ] **MEI schema validator** — choose + pin so the machine-check covers schema validity, not just
  well-formedness.
