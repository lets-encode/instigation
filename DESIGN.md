# Let's Encode! — design & status

**Let's Encode!** is a decentralised crowd-encoding system for music scores. No central server owns
campaign state: each campaign is an ordinary Git repository, and all coordination logic (task
assignment, locking, validation, merging, attribution) runs in **one generic GitHub Actions
workflow** in that repo — a task-agnostic *caller* that forwards the triggering event to a **central
automation repository** and commits the result back. Two thin clients drive the system: a **static
instigation GUI** (organiser creates/configures a campaign) and the **mei-friend volunteer client**
(contributors encode/validate).

> Single authoritative design + status document; §9 records the current state. Data model is
> **schema v2** (four tables keyed by `(task_id, subtask_id)` plus the command log, §5). An
> `mei-template` campaign uses the `whole` strategy (one task = the whole `sources/score.mei`, one
> validation subtask); a `facsimile` campaign splits encoding into one task per page carrying
> measures, joined back into the shared score by page on accept (§6, §7a). Coding guidelines to
> honour are in `CLAUDE.md` (simplicity, surgical changes, goal-driven).

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
| `BASE_REPO` / `BASE_REPO_ID` | `owner/repo` + numeric repo id | same |
| `EVENT_NAME` | `pull_request_target` | `schedule` / `workflow_dispatch` |
| `PR_NUMBER`, `PR_AUTHOR` (numeric account id), `PR_AUTHOR_LOGIN` | from the PR | — |
| `HEAD_REPO` / `HEAD_REPO_ID`, `HEAD_SHA`, `HEAD_REF` | the PR head (fork or same-repo) | — |

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
          PR_AUTHOR:  ${{ github.event.pull_request.user.id }}        # numeric id = identity
          PR_AUTHOR_LOGIN: ${{ github.event.pull_request.user.login }} # login = commit prose only
          BASE_REPO_ID: ${{ github.repository_id }}
          HEAD_REPO:  ${{ github.event.pull_request.head.repo.full_name }}
          HEAD_REPO_ID: ${{ github.event.pull_request.head.repo.id }}
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
campaign:      { title, description, instigator, repo_id, language, license }  # instigator + repo_id are numeric GitHub ids
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

`task_id, subtask_id, fragment, locator, allowlist, blocklist, depends_on`

- `fragment`: the source file the row addresses (e.g. `sources/score.mei`).
- `locator`: address *within* the fragment — a page's surface id (`surface-N`) for a per-page
  encoding task, a controlled-vocab term for pre-tasks (`measure-zones`; §7a), or empty = the whole
  file. Realises per-page fragmentation now (facsimile, §7a) and the reserved `by_measure`/`by_section`
  strategies later.
- `allowlist`/`blocklist`: per-row claim gates — present in the schema but **not yet enforced**
  (default open, §10).
- `depends_on`: a task_id that must be `completed` before this task can be claimed; empty = none.
  Enforced in the claim accept rules (`dependency_incomplete`). Chains the pre-tasks before the
  encoding work (§7a).

**state.csv — live status, Action-authored**

`task_id, subtask_id, status, encoder, encoded_at, validate_status_1 … validate_status_n`

- Task row `status`: `encoding_required` → `validation_required` → `completed` (when every subtask
  is completed). `encoder`/`encoded_at` are recorded here. A task with **no** validation subtasks
  goes `encoding_required` → `completed` on its accepted submission.
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

**history.csv — append-only audit log**

`timestamp, task_id, subtask_id, user_id, action, outcome, detail, command, version, input`

Every processed event appends a row — **including rejects** (attribution + audit): `action` ∈
`claim_encoding|claim_validation|submit_encoding|submit_validation|reap|dispatch`, `outcome` ∈
`accepted|rejected|released`, `detail` = the reject reason, the validation verdict, or the reaped
lock's kind.

The last three columns record the **console command** behind the event, when there was one —
`command`/`version` identify it, `input` is its input as JSON — so user actions are replayable as
data. Every console operation is a named, versioned command in a registry (`src/lib/commands.ts`)
run through one dispatcher; how the columns get filled follows the trust model (§6):

- Commands whose mutation travels as a PR (claim, encode-claim via the editor, submit encoding,
  submit validation, the pre-task submissions) embed a **command envelope**
  (`src/lib/command-envelope.ts`) in the PR body as data; **the Action authors the row**, taking
  `command`/`version`/`input` from the envelope but `user_id`/`timestamp`/`outcome` from the event
  and its own decision — volunteers never write to the campaign repo. Events without an envelope
  (hand-opened PRs, scheduled reaps) leave the command columns empty.
- Commands that mutate without a PR (the reaper dispatch, `action: dispatch`) require push access,
  so the console commits the row itself (best-effort: a lost log row is reported, never fails the
  command).
- Reads (`readTables`, `rawLink`) are commands too, but are not logged.

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
| lock `user_id` / `encoder` / validator id | the **PR author's numeric account id** (from the event); the login is resolved for display only |
| lock `timestamp` / `encoded_at` / validation time | **server time** |
| validation `pass`/`fail` | the volunteer's verdict, stamped with their numeric id + time |
| MEI bytes | the **fork's content**, after the machine-check |
| every `history.csv` row | the Action, describing what it just decided; the command columns come from the PR body's envelope, never the fork's tables (§5) |

Table changes are *applied by the Action*, not merged from fork bytes (a boundary check limits *which*
cells change, not *what* goes in). MEI content is the volunteer's and is merged.

**The three PR types** (distinguished by changed path):

| PR | Allowed change | Carries |
|---|---|---|
| Claim | `tracking/lock.csv` only | task_id, subtask_id, kind |
| Encoding | the task's fragment (`sources/score.mei`) only | the MEI content |
| Validation | `tracking/state.csv` only | subtask + pass/fail verdict |

The pre-task submissions (§7a) are ordinary *encoding-type* PRs — they rewrite the fragment.
Because several tasks can share one fragment, an encoding-type PR's **task** is resolved from the
PR's own data: the command envelope's task_id, the `encode-<task_id>` branch name, or the author's
single active encoding lock among the candidate tasks (in that order; a lone candidate needs no
tie-break).

**Joining encoding into the fragment.** A whole-file task (empty locator) and a pre-task take the
fork's fragment verbatim. A per-page encoding task (locator `surface-N`, §7a) contributes only its
page: the coordinator splices the fork's measures for that page — those inside the page's `<pb>`
span, matched by `xml:id` — into the base score and keeps every other page as it stands
(`src/lib/mei-page-splice.ts`). This is what lets page tasks be worked independently and merge
without clobbering each other; the spliced result is what the machine-check validates.

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

## 7a. Facsimile pre-tasks

A campaign created from page images / a PDF (source kind `facsimile`) does not start at encoding:
the detector's measure boxes are provisional, so the score is built in stages
(`src/lib/mei-facsimile.ts`, one model — `buildFacsimileMei` / `parseFacsimileMei`):

| Stage | Content of `sources/score.mei` | Written by |
|---|---|---|
| A | `<facsimile>` only: surfaces, graphics, one labelled `<zone type="measure" n="…">` per box; one empty `<mdiv>` | init |
| B | + one `<measure n="…" facs="#zone">` (holding an `<mRest/>`) per zone | (intermediate form; still parsed) |
| C | + a `<pb/>` before each page's first measure, an `<sb/>` before each flagged measure, and one `<mdiv>` per movement/section/piece | P0001's submission (`submitZones`) |

All stages validate against the pinned MEI-CMN 5.0 schema, so the ordinary machine-check
applies to every submission.

The pre-task submission advances the score from stage A to stage C, so its content always differs
from the file already in the repo — even when the volunteer changed nothing, because the new stage
adds elements (measures, breaks, movements) stage A lacked. That guaranteed diff matters: the
caller's `pull_request_target` is `paths`-filtered (§4), so an identical file would open an empty
PR that never triggers the automation and leaves the console polling forever.

The task table chains the work via `depends_on` (§5): **P0001** (`locator: measure-zones`, one
validation subtask) → **one encoding task per page** that carries measures (`locator: surface-N`,
one validation subtask each), all depending on P0001. The pre-task establishes the `<pb>`
boundaries and continuous measure numbering the per-page split and join rely on. Each is an
ordinary crowd task: claimed (encoding-kind lock), submitted as an encoding-type PR (joined into
the shared score by page, §6), validated through the normal machinery. Pages with no detected
measures get no encoding task. An `mei-template` campaign keeps the single whole-file **T0001**.

The **zone editor** (`/campaign/[campaign]/zones/[task]`) is the volunteer interface for the
pre-task, driven entirely by commands (`readFacsimile`, `claimTask`, `submitZones`). It has two
steps within the one task, submitted together:

- *Step 1 — Measures*: add (drag on the page), delete, move and resize boxes over the page
  image. Numbering follows reading order automatically; a per-measure label override (e.g.
  `10a`/`10b` for voltas) interrupts the sequence and numbering continues from its integer prefix.
  Validators review the same view read-only and pass/fail from the console.
- *Step 2 — Breaks & movements*: page breaks are automatic (one per surface); the volunteer clicks
  measures to toggle system starts (pre-suggested from the detected row grouping) and shift-clicks
  to mark a measure as the start of a movement, section or piece — each becomes its own `<mdiv>`.

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

**Command layer.** Every console operation is a named, versioned command (`src/lib/commands.ts`)
run through one dispatcher, and every mutating command fills the command columns of a
`history.csv` row (§5): PR-flow commands via the envelope in the PR body (Action-authored row,
`scripts/coordinator.ts` + `src/lib/command-envelope.ts`), the reaper dispatch via a direct
client commit. The console page is one caller of the registry; the command-log pipeline has not
yet been exercised live.

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
subtask_id)` with an append-only history; **the facsimile pre-tasks** (§7a) — staged score,
`depends_on` chaining, the zone editor, and coordinator-side measure generation (`locator` is now
used by the pre-tasks; the reserved `by_measure`/`by_section` strategies still aren't). Not yet
exercised live: the full pre-task pipeline (zones submit → validate → generate → encoding
unblocked). `allowlist`/`blocklist` remain unenforced (below).

Deferred (designed, not built):

- **Onboarding wizard** — collect *what/have/validation-policy*; header pre-fill (scoreDef,
  staffDef pre-tasks); algorithmically generate the task table for the reserved fragmentation
  strategies. If heavy compute moves off the client, a `workflow_dispatch` path to the caller
  carrying mei-friend-style inputs (`workpackage_id`, `filepath`, `parameters`) is the dispatch
  counterpart to §4's event path.
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
- [x] **API quota telemetry** — the shared forge adapter records per-process request counts and
  GitHub rate-limit headers, each coordinator run prints its own summary in the campaign's Actions
  log, and the OAuth proxy logs sanitized upstream quota fields while distinguishing its own
  throttle. No campaign state or coordination telemetry is stored centrally.
- [ ] **Actions write permissions** — the create flow sets the repo's default workflow token to write;
  confirm for any org-owned repos.
- [x] **MEI schema validator** — the machine-check runs `xmllint --relaxng` against the pinned
  MEI-CMN 5.0 schema (§6), not just well-formedness.
