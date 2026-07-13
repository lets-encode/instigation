# Let's Encode! — design & status

**Let's Encode!** is a decentralised crowd-encoding system for music scores. No central server owns
campaign state: each campaign is an ordinary Git repository, and all coordination logic (task
assignment, locking, validation, merging, attribution) runs in **one generic GitHub Actions
workflow** in that repo — a task-agnostic *caller* that forwards the triggering event to a **central
automation repository** and commits the result back. Two thin clients drive the system: a **static
instigation GUI** (organiser creates/configures a campaign) and the **mei-friend volunteer client**
(contributors encode/validate).

> Single authoritative design + status document; §9 records the current state. Data model is
> **schema v2** (four tables keyed by `(task_id, subtask_id)`, §5); the only fragmentation strategy
> implemented is `whole` (one campaign = one task = the whole `sources/score.mei`, with one
> validation subtask). Coding guidelines to honour are in `CLAUDE.md` (simplicity, surgical
> changes, goal-driven).

## 1. Architecture at a glance

```
Instigation GUI (static SPA)                         ← forge token held server-side by the session broker
  │  create campaign (generate + commit) · read tables · open contribution PRs
  ▼
Campaign repository                                  ← data + ONE task-agnostic caller
  config.yaml · sources/score.mei · tracking/*.csv
  .github/workflows/caller.yml
  │  on pull_request_target / schedule / workflow_dispatch:
  │  read central pointer from config (base ref) → checkout central → run it
  ▼
Central automation repository (the instigation repo doubles as this)
  one coordinator entry + pure decision modules (provider-neutral)
  │  decide + mutate tables/MEI (optimistic concurrency); attribute to the PR author
  ▼
Campaign repository                                  ← results committed back, PR closed
```

Two copy mechanisms: **generate** (template → independent campaign repo) for instigation; **fork +
pull request** for contributions (the model that makes cross-repo PRs cheap and standard). The
campaign repo carries *no* task logic — only its data and a forwarder; every decision lives centrally.

## 2. The components

- **Instigation GUI** (`instigation/`, a SvelteKit **static** app, `adapter-static`) — no app backend.
  The organiser logs in with the forge (OAuth run server-side by the session broker, §8), then the
  browser uses a **`ForgeClient`** (authenticated calls relayed through the broker, which attaches
  the user's token from its session) to: create the campaign repo
  from the template and initialise it (Action A, §7), read the tracking tables, and open the
  contribution PRs that drive the automation (the campaign console).
- **Campaign repository** — an independent repo stamped from the template
  (`lets-encode/user-repo-template`). Holds `config.yaml`, `sources/score.mei`, the two tracking
  tables, and a single generic `caller.yml`. The heart of the system, and deliberately logic-free.
- **Central automation repository** — one coordinator entry plus the pure, tested decision modules
  the caller runs. Provider-neutral. Pinned by ref from the campaign's own config, so upgrading a
  live campaign is a config commit, not a workflow edit. **The instigation repo doubles as this
  repo** (entry: `scripts/coordinator.ts`): the coordinator and the SPA share the decision modules
  (`src/lib/campaign-*.ts`) and the forge adapter, so nothing is duplicated. Because the pointer is
  config data, campaigns can be repointed at a dedicated repo later without touching the template.
- **mei-friend volunteer client** — where contributors encode/validate. External; in scope here only
  for the PR contract it relies on (§6).

## 3. Settled decisions

| Decision | Resolution |
|---|---|
| Backend | **The session broker only.** The SPA is static assets; its one server-side dependency is the OAuth session broker, which holds the token and relays the authenticated forge calls. |
| OAuth | **Session broker** — a small stateful service (a Flask app, `broker/`) runs the whole OAuth flow, holds the client secret and the user's token in a server-side session (the browser gets only an httpOnly cookie), and proxies the SPA's authenticated API calls. The token is never present in the page, so script injection cannot read it. A *provider trait*: a GitLab deployment could run PKCE in the browser instead, trading that protection for a serverless setup. |
| Per-repo workflows | **One generic, task-agnostic caller** replaces any per-task workflows. Triggers: `pull_request_target` (all contributions) + `schedule` (the reaper) + `workflow_dispatch` (manual reaper run from the console). It forwards the event; central decides what to do. |
| Central location | **Read from the campaign config on the base ref** (§4) — never hardcoded, never taken from the fork. The pinned ref lives in that config. |
| Central logic | Lives in the **central automation repo**; the campaign repo carries none. The **instigation repo doubles as the central repo** (entry: `scripts/coordinator.ts`), so the SPA and the coordinator share the pure modules. |
| Provider independence | A **`ForgeClient` seam** + a provider-config object (API base, OAuth endpoints, raw-URL pattern, fork/PR verbs). No hardcoded hosts or paths. GitHub implemented now; GitLab/others later are a drop-in (§8). |
| Campaign ownership | The **instigator's personal account**. Consequence: keep the `canPush` dual-path — the owner contributes via a same-repo branch (mei-friend `connect=true`); everyone else forks + PRs. |
| Table integrity | **The Action is the sole author of all table mutations.** Fork+PR contributors have zero write access, so this holds without branch protection (§6). |
| Generate vs fork | generate for instigation; fork for contributions. |
| Table / config format | **CSV** tables (one cell/row per PR → minimal diffs); **YAML** config. Users never read/write them directly; the GUI presents them. |
| Concurrency | **Optimistic** — read the branch-head SHA, decide, commit non-fast-forward, retry on conflict (§6). |
| Ids / timestamps | zero-padded `T0001…` / `S0001…`; ISO-8601 UTC (`…Z`). |

## 4. The generic caller — triggers & forwarded parameters

This is the crux of "no task logic in the campaign repo." The pattern follows mei-friend's
[caller-template](https://github.com/mei-friend/caller-template) → [automation](https://github.com/mei-friend/automation)
split, **adapted for a multi-user, event-driven flow**: mei-friend's caller is triggered by
`workflow_dispatch` and receives everything as explicit inputs (`workpackage_id`, `filepath`,
`parameters`, `commit_message`, …); Let's Encode is triggered by `pull_request_target`/`schedule`
(+ `workflow_dispatch` for a manual reaper run), which **carry no custom inputs** — so the
parameters come from two other places instead.

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

| Env var | `pull_request_target` | `schedule` / `workflow_dispatch` |
|---|---|---|
| `GH_TOKEN` | base repo's `GITHUB_TOKEN` (write) | same |
| `BASE_REPO` | `owner/repo` | same |
| `EVENT_NAME` | `pull_request_target` | `schedule` / `workflow_dispatch` |
| `PR_NUMBER`, `PR_AUTHOR` | from the PR | — |
| `HEAD_REPO`, `HEAD_SHA`, `HEAD_REF` | the PR head (fork or same-repo) | — |

**What is *not* forwarded — central derives or reads it as data:**

- **Which operation** (claim / encode / validate) — inferred from the PR's *changed paths*
  (`lock.csv` → claim; `sources/**` → encoding; `state.csv` → validation). No `workpackage_id`.
- **The intent values** (task id, claim kind, pass/fail verdict) — read from the PR's proposed table
  diff, treated as data (never merged verbatim; §6). No `parameters` input.
- **Config values** (`pass_threshold`, `required_validations`, `stale_after_minutes`) — read from
  `config.yaml`. 
- **Commit message** — the central entry commits via the forge API itself (for optimistic
  concurrency + PR closing), so there is no `commit_message` input.

**Implementation** (`user-repo-template/.github/workflows/caller.yml`, byte-identical in every
campaign) — the full file lives in the template; structurally:

```yaml
name: Campaign automation
on:
  pull_request_target:
    types: [opened, reopened, synchronize]
    paths: [ 'tracking/**', 'sources/**' ]   # skip unrelated PRs (boundary checks still gate)
  schedule:
    - cron: '*/15 * * * *'   # reaper; coarse timing is fine (logic compares elapsed time)
  workflow_dispatch: {}      # manual reaper run (campaign console)
concurrency: { group: campaign-${{ github.repository }}, cancel-in-progress: false }
permissions: { contents: write, pull-requests: write }
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4                       # base tree ONLY (never the fork head)
      - id: cfg                                         # read central pointer from base config
        run: |                                          # awk scoped to the `automation:` block
          # (`ref:`/`path:` also appear elsewhere in config.yaml); no yq/YAML dep.
          # Empty outputs (config.yaml not yet committed) no-op the later steps.
          read_automation() { awk -v key="$1" '/^automation:/{f=1;next} /^[^[:space:]]/{f=0}
            f && $1 == key":" {gsub(/"/,"",$2); print $2; exit}' config.yaml 2>/dev/null || true; }
          echo "repo=$(read_automation central_repository)" >> "$GITHUB_OUTPUT"
          echo "ref=$(read_automation ref)"               >> "$GITHUB_OUTPUT"
          echo "path=$(read_automation path)"             >> "$GITHUB_OUTPUT"
      - uses: actions/checkout@v4
        if: steps.cfg.outputs.repo != ''
        with: { repository: '${{ steps.cfg.outputs.repo }}', ref: '${{ steps.cfg.outputs.ref }}', path: central }
      - uses: actions/setup-node@v4
        if: steps.cfg.outputs.repo != ''
        with: { node-version: 24 }                      # bare-node type-stripping; no build step
      - if: steps.cfg.outputs.repo != ''
        run: sudo apt-get install -y libxml2-utils       # xmllint (MEI machine-check)
      - if: steps.cfg.outputs.repo != ''
        env:                                            # (b) event context → central
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

## 5. Config & table formats (schema v2)

### config.yaml

Authored once at instigation. Minimal but extensible; growth points marked `(reserved)`.

```yaml
schema_version: 2
campaign:      { title, description, instigator, language, license }
automation:    { central_repository, ref, path }   # the central pointer (§4a); ref is pinned
sources:       [ { id, kind: mei-template, path, template, header: { composer } } ]
fragmentation: { strategy: whole }
validation:    { required_validations, pass_threshold }
locking:       { stale_after_minutes }
```

### The four tracking tables

All keyed by **`(task_id, subtask_id)`**: a **task** is the unit of *encoding* (one encoder), its
**subtasks** are the units of *validation* (reviewed in parallel, possibly split differently). A row
with an **empty `subtask_id` addresses the whole task**; a row with one addresses a single
validation portion. The `whole` strategy is the degenerate case: one task `T0001` (the entire
score) with one subtask `S0001` spanning the same range.

**task.csv — task/subtask definitions, written at init**

`task_id, subtask_id, fragment, locator, allowlist, blocklist`

- `fragment`: the source file the row addresses (e.g. `sources/score.mei`).
- `locator`: address *within* the fragment — an MEI `xml:id`, or a controlled-vocab term for
  pre-tasks; empty = the whole file. Realises the reserved `by_measure`/`by_section` strategies.
- `allowlist`/`blocklist`: per-row claim gates — present in the schema but **not yet enforced**
  (default open, §10).

**state.csv — live status, Action-authored**

`task_id, subtask_id, status, encoder, encoded_at, validate_status_1 … validate_status_n`

- Task row `status`: `encoding_required` → `validation_required` → `completed` (when every subtask
  is completed). `encoder`/`encoded_at` are recorded here.
- Subtask row `status`: `pending` (task not yet encoded) → `validation_required` → `completed`
  (once `pass_threshold` passes accumulate).
- `validate_status_1…n`: validation cells on subtask rows, count = `required_validations`. Each is
  empty or `status|user|timestamp` with status ∈ `pass|fail` (pipe avoids colliding with the colons
  in timestamps). In-progress validation is tracked by a `validation` lock, not an in-cell marker.

**lock.csv — one row per active claim (header-only after init)**

`task_id, subtask_id, user_id, timestamp, kind` with `kind` ∈ `encoding|validation` — kept because
encoding is exclusive (one lock per task) while validation is concurrent (several validators on the
same encoded work). Encoding locks sit on the task row key, validation locks on a subtask key. The
reaper compares `timestamp` against `stale_after_minutes`.

**history.csv — append-only audit log, Action-authored**

`timestamp, task_id, subtask_id, user_id, action, outcome, detail`

Every processed event appends a row — **including rejects** (attribution + audit): `action` ∈
`claim_encoding|claim_validation|submit_encoding|submit_validation|reap`, `outcome` ∈
`accepted|rejected|released`, `detail` = the reject reason, the validation verdict, or the reaped
lock's kind.

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
| lock `user_id` / `encoder` / validator login | the **PR author** (from the event) |
| lock `timestamp` / `encoded_at` / validation time | **server time** |
| validation `pass`/`fail` | the volunteer's verdict, stamped with their login + time |
| MEI bytes | the **fork's content**, after the machine-check |
| every `history.csv` row | the Action, describing what it just decided |

Table changes are *applied by the Action*, not merged from fork bytes (a boundary check limits *which*
cells change, not *what* goes in). MEI content is the volunteer's and is merged.

**The three PR types** (distinguished by changed path):

| PR | Allowed change | Carries |
|---|---|---|
| Claim | `tracking/lock.csv` only | task_id, subtask_id, kind |
| Encoding | the task's fragment (`sources/score.mei`) only | the MEI content |
| Validation | `tracking/state.csv` only | subtask + pass/fail verdict |

**Accept rules.**

- *Claim:* the addressed row exists and the key matches the kind (encoding → task row, validation →
  subtask row). For `encoding`: status is `encoding_required` and no active encoding lock. For
  `validation`: the subtask's status is `validation_required`, an open slot exists (`final cells +
  active validation locks on that subtask < required_validations`), the claimant isn't already
  holding one, and **isn't the task's encoder** (no self-validation).
- *Encoding:* PR touches only the fragment, author holds the active encoding lock, MEI passes the
  machine-check → task row gets `encoder`/`encoded_at` and → `validation_required`, its `pending`
  subtasks → `validation_required`, drop the lock.
- *Validation:* author holds the subtask's active validation lock → write its first open
  `validate_status_N` = `verdict|author|now`, drop the lock; once `pass_threshold` passes
  accumulate the subtask → `completed`, and when every subtask is completed the task row →
  `completed`.

**History.** Every processed event — accepted or rejected — is committed as an appended
`history.csv` row (§5). A rejected PR therefore still produces one commit (the audit entry), just
never a table or content change.

**Race arbitration (optimistic concurrency).** The forge serialises writes to `main`. The central
entry reads the tables pinned to the branch-head SHA, decides, then commits on that exact parent with
a non-fast-forward ref update. If a competing change merged first, the update fails → re-read,
re-decide (now sees the new lock) → reject cleanly. First valid claim wins. Claim/validation PRs are
**closed, not merged** (the authoritative change is the Action's own commit); encoding PRs contribute
their MEI content.

**MEI machine-check.** `xmllint --relaxng` against the **pinned MEI-CMN 5.0 RelaxNG schema**
(`https://music-encoding.org/schema/5.0/mei-CMN.rng` — the schema the template's `<?xml-model?>`
declares), which covers well-formedness too. The coordinator fetches the schema once per run; a
fetch failure fails the run loudly rather than letting content through unchecked. Musical
correctness is *not* machine-checked — that is the human `vN` validation.

**Same-repo vs fork (the `canPush` dual-path).** Because campaigns live in the instigator's personal
account, the owner can't fork their own repo: the console commits on a same-repo `encode-<task_id>`
branch and binds mei-friend with `connect=true` (open + bind, no fork). Everyone else forks
(`fork=true`) and the console opens a cross-repo PR upstream. Both produce a `pull_request_target`
event the one caller handles identically.

**End to end (`whole` strategy, one note):**

```
init:                    T0001    encoding_required             locks: —
                         └ S0001  pending
bob claims encoding                                             locks: (T0001,–,bob,encoding)
bob submits encoding     T0001    validation_required (encoder=bob)   locks: —   (score.mei merged)
                         └ S0001  validation_required
carol claims validation  (carol ≠ bob)                          locks: (T0001,S0001,carol,validation)
carol submits pass       S0001    validate_status_1=pass|carol|… → completed   locks: —
                         T0001    completed (all subtasks done)
```

(Each step also appends a history.csv row.)

## 7. Instigation (Action A) — client-side

At creation the GUI, acting as the organiser via the `ForgeClient` (token attached by the broker):

1. **generates** the campaign repo from the template into the instigator's account,
2. sets the repo's Actions token to read/write (so the caller can commit tables + close PRs),
3. commits, in one commit: `config.yaml` (including the `automation` pointer), the stamped
   `sources/score.mei` (fills `{{TITLE}}`/`{{COMPOSER}}`/`{{LICENSE}}`), and the four tracking
   tables (§5): `task.csv` (task `T0001` + subtask `S0001`), `state.csv` (`encoding_required` /
   `pending`), and header-only `lock.csv` and `history.csv`.

Idempotent: output is fully determined by config + template, so re-running before any contribution
reproduces identical files. Runs client-side because the organiser is in the loop; everything else
runs in the campaign repo's caller.

## 8. Provider-agnostic design

Two provider-touching surfaces, cleanly separated so a second forge is additive:

- **Client `ForgeClient` interface** — identity/OAuth, repo-from-template, read/write files, commit,
  branch, list, **fork + open change-request**, raw-file URL, and CI-trigger. A `GitHubForge` implements
  it now; all specifics (API base, OAuth endpoints, raw-URL pattern, fork/PR verbs, auth strategy)
  live in a per-provider **config object** — **no hardcoded hosts or paths anywhere**. Auth is a
  provider trait: GitHub → session broker (token server-side); GitLab → PKCE possible (no broker).
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

**The migration described by this document is code-complete.** The target architecture above is
what the repos now contain:

- **Static SPA + session broker** — `adapter-static`, no server routes. OAuth runs server-side in
  the session broker (`broker/`, Flask), which holds the token and relays authenticated forge
  calls; all forge access goes through the `ForgeClient` seam (`src/lib/forge/`). A strict CSP is
  baked into the build (`svelte.config.js`).
- **One generic caller** — the template ships a single `caller.yml` (§4) that reads the
  `automation:` pointer from the campaign's `config.yaml` on the base ref and runs the central
  coordinator. The three per-task workflows and their `scripts/*.mjs` shells are gone.
- **Central automation** — this repo doubles as the central repo: `scripts/coordinator.ts` is the
  single entry (routes on `EVENT_NAME` + changed paths), reusing the pure decision modules
  (`campaign-tables`, `campaign-claim`, `campaign-submit`, `campaign-reaper`) that the SPA also
  imports. Action A (`campaign-init`) writes the `automation:` pointer into every new campaign.

Convention preserved: decision logic stays pure and tested (GitHub is never touched in unit tests);
only thin shells — the coordinator and the `ForgeClient` — touch the forge.

**Data model.** The four-table schema v2 (§5) is implemented end to end: init writes all four
tables, the decision modules and coordinator address `(task_id, subtask_id)`, every outcome —
including rejects — appends to `history.csv`, and the console renders tasks and validation
subtasks separately.

**Verification.** Unit tests cover the decision modules and Action A. A live end-to-end run
(2026-07-02, throwaway campaign `ohwjd/e2e-caller-test`, still on schema v1) confirmed the caller
pipeline: claim accepted (Action-authored lock) → stale lock reaped via `workflow_dispatch` →
re-claim → encoding accepted (schema machine-check, volunteer MEI merged with `Co-authored-by`
attribution) → same-account validation claim rejected (`self_validation`) → PR head branches
cleaned up. Not yet exercised live: the **schema v2 pipeline** (rerun the e2e after pushing), a
validation *accept* (needs a second account — the no-self-validation rule blocks one-account
testing), and the in-browser smoke test of the full console flow (§10 phase 1).

**Runtime.** Central code is TypeScript run by bare `node` (≥23.6 type-stripping), so the caller pins
`node-version: 24` and the coordinator imports use real `.ts` specifiers. The SPA imports the same
modules via Vite. No build step for the automation.

## 10. Roadmap & deferred

Migration order (each phase independently shippable):

1. **Static SPA + session broker** — ✅ built (static adapter, `ForgeClient`(GitHub) seam, session broker).
   Remaining verification: a browser smoke test of `generate` + a commit sequence against the forge
   API (the load-bearing CORS assumption).
2. **One generic caller + central automation** — ✅ built and verified live on a throwaway campaign
   (claim → reap → re-claim → encode → self-validation rejected; §9). Outstanding: a validation
   *accept* end-to-end, which needs a second account.

Done since: **the four-table data model** (schema v2, §5) — tables keyed by `(task_id,
subtask_id)` with an append-only history. What remains of it: nothing *uses* `locator` yet (the
reserved `by_measure`/`by_section` strategies will), and `allowlist`/`blocklist` are unenforced
(below).

Deferred (designed, not built):

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
  tag/SHA, not a moving branch; upgrade by committing a new ref. (Iteration uses `main` — set
  `PUBLIC_AUTOMATION_REF` for the production deployment.)
- [x] **Central reachability** — the central repo (this one) is public, so the caller's checkout
  needs no token.
- [x] **Never execute fork code** — the caller checks out the base tree only; the fork is data (§4, §6).
- [x] **Read the central pointer from the base ref** — never from the PR head (§4a).
- [x] **Token handling** — the forge token never reaches the browser: it lives in the broker's
  server-side session, the page holds only an httpOnly session cookie, and authenticated API calls
  are relayed through the broker's login-gated proxy. The strict CSP (scripts `'self'` only, hashed
  init script, allow-listed `connect-src`/`img-src`) baked into the build via `svelte.config.js`
  remains as defence in depth.
- [x] **Broker** — holds the client secret and the session tokens; same-origin mount only (no CORS
  surface); revokes the token at GitHub on logout; proxy is allowlisted to `api.github.com`,
  login-gated, and rate-limited.
- [ ] **Actions write permissions** — the create flow sets the repo's default workflow token to write;
  confirm for any org-owned repos.
- [x] **MEI schema validator** — the machine-check runs `xmllint --relaxng` against the pinned
  MEI-CMN 5.0 schema (§6), not just well-formedness.
