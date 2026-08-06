# Let's Encode! — design & status

**Let's Encode!** is a decentralised crowd-encoding system for music scores. No central server owns
campaign state: each campaign is an ordinary Git repository, and all coordination logic (task
assignment, locking, validation, merging, attribution) runs in **one generic GitHub Actions
workflow** in that repo — a task-agnostic *caller* that forwards the triggering event to a **central
automation repository** and commits the result back. Two thin clients drive the system: a **static
instigation GUI** (organiser creates/configures a campaign; volunteers browse, claim and follow
work) and the **mei-friend volunteer client** (contributors encode/validate).

> Single authoritative design + status document; §9 records the current state. Data model is
> **schema v3** (five tables keyed by `(task_id, subtask_id)` plus the command log, §5): a campaign
> describes one physical source holding N **pieces** (`by-piece` strategy), each piece one MEI at
> `sources/<piece-id>/score.mei` and one group of tasks. A `facsimile` piece opens with a
> measure-correction pre-task and splits encoding into one task per page, joined back into the
> piece's score by page on accept (§6, §7a); an `encoded` piece gets one whole-file task; a
> `physical-only` piece gets per-page or whole-file tasks (§5). Coding guidelines to honour are in
> `CLAUDE.md` (simplicity, surgical changes, goal-driven).

## 1. Architecture at a glance

```
Instigation GUI (static SPA)                         ← forge token held server-side by the session broker
  │  create campaign (generate + commit) · read tables · open contribution PRs
  ▼
Campaign repository                                  ← data + ONE task-agnostic caller
  config.yaml · sources/<piece>/score.mei · tracking/*.csv
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
  The user logs in with the forge (OAuth run server-side by the session broker, §8), then the
  browser uses a **`ForgeClient`** (authenticated calls relayed through the broker, which attaches
  the user's token from its session) to: create the campaign repo from the template and initialise
  it via the onboarding wizard (§7), read the tracking tables, and open the contribution PRs that
  drive the automation. Its surfaces — the landing page, the wizard, the personal dashboard, the
  campaign console and the zone editor — are laid out in §7b/§7c.
- **Campaign repository** — an independent repo stamped from the template
  (`lets-encode/user-repo-template`). Holds `config.yaml`, one `sources/<piece-id>/score.mei` per
  piece, the five tracking tables, and a single generic `caller.yml`. The heart of the system, and
  deliberately logic-free.
- **Central automation repository** — one coordinator entry plus the pure, tested decision modules
  the caller runs. Provider-neutral. Pinned by ref from the campaign's own config, so upgrading a
  live campaign is a config commit, not a workflow edit. **The instigation repo doubles as this
  repo** (entry: `scripts/coordinator.ts`): the coordinator and the SPA share the decision modules
  (`src/lib/campaign-*.ts`) and the forge adapter, so nothing is duplicated. Because the pointer is
  config data, campaigns can be repointed at a dedicated repo later without touching the template.
- **Session broker** (`broker/`, Flask) — the SPA's one server-side dependency: the OAuth flow and
  token custody (§3), plus two service mounts, the slug registry and the IIIF relay (§8a).
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
| Campaign addressing | A campaign lives at **`/<name>`** on the app's origin. The name → repo-id mapping lives in the **slug registry** (§8a); the SPA resolves the name to the stable numeric repo id, then to the current `owner/repo`, so renames and transfers don't break addresses. |
| Table integrity | **The Action is the sole author of all table mutations.** Fork+PR contributors have zero write access, so this holds without branch protection (§6). |
| Generate vs fork | generate for instigation; fork for contributions. |
| Table / config format | **CSV** tables (one cell/row per PR → minimal diffs); **YAML** config. Users never read/write them directly; the GUI presents them. |
| Concurrency | **Optimistic** — read the branch-head SHA, decide, commit non-fast-forward, retry on conflict (§6). |
| Ids / timestamps | zero-padded `T0001…` / `P0001…` / `S0001…`; ISO-8601 UTC (`…Z`). |

## 4. The generic caller — triggers & forwarded parameters

This is the crux of "no task logic in the campaign repo." The pattern follows mei-friend's
[caller-template](https://github.com/mei-friend/caller-template) → [automation](https://github.com/mei-friend/automation)
split, **adapted for a multi-user, event-driven flow**: mei-friend's caller is triggered by
`workflow_dispatch` and receives everything as explicit inputs (`workpackage_id`, `filepath`,
`parameters`, `commit_message`, …); Let's Encode is triggered by `pull_request_target`/`schedule`
(+ `workflow_dispatch` for a manual reaper run), which **carry no custom inputs** — so the
parameters come from two other places instead.

**(a) The central pointer — from the campaign config, on the base ref.** The caller has nothing
hardcoded, and the campaign repo itself is never checked out: the caller reads `config.yaml` with
**one API call** pinned to `$GITHUB_SHA` — which for `pull_request_target` is the **base** branch
head, so a fork PR cannot redirect where central lives (the fork's version of `config.yaml` is
never used). Three fields form the pointer:

| Config field | Meaning |
|---|---|
| `automation.central_repository` | `owner/repo` of the automation logic (provider-neutral data). |
| `automation.ref` | Immutable tag/SHA to pin (upgrading = a config commit). |
| `automation.path` | Entry-point script within that repo. |

A 404 (config.yaml not yet committed, e.g. a scheduled run on a freshly generated repo) empties the
outputs and no-ops the remaining steps; any other API failure fails the run rather than silently
doing nothing.

**(b) The event context — forwarded to central as environment.** The only "parameters" the central
entry needs are the identity of the event; it derives the rest itself.

| Env var | `pull_request_target` | `schedule` / `workflow_dispatch` |
|---|---|---|
| `GH_TOKEN` | base repo's `GITHUB_TOKEN` (write) | same |
| `BASE_REPO` | `owner/repo` | same |
| `EVENT_NAME` | `pull_request_target` | `schedule` / `workflow_dispatch` |
| `PR_NUMBER`, `PR_AUTHOR` (numeric account id), `PR_AUTHOR_LOGIN` | from the PR | — |
| `HEAD_REPO`, `HEAD_SHA`, `HEAD_REF` | the PR head (fork or same-repo) | — |

**What is *not* forwarded — central derives or reads it as data:**

- **Which operation** (claim / encode / validate / comment) — inferred from the PR's *changed paths*
  (`lock.csv` → claim; `sources/**` → encoding; `state.csv` → validation or send-back;
  `comment.csv` alone → comment). No `workpackage_id`.
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
    - cron: '0 * * * *'   # hourly reaper — fallback cleanup; claims also reap expired locks lazily
  workflow_dispatch: {}    # manual reaper run (campaign console)
concurrency: { group: campaign-${{ github.repository }}, cancel-in-progress: false, queue: max }
permissions: { contents: write, pull-requests: write }
jobs:
  run:
    runs-on: ubuntu-24.04
    steps:
      - if: github.event_name == 'pull_request_target'  # xmllint (MEI machine-check) installs in
        run: sudo apt-get install … libxml2-utils &     # the background — only encoding submissions
                                                        # use it, and only PRs can carry one
      - id: cfg                                         # (a) read the central pointer: ONE API call,
        run: |                                          # no base checkout; awk scoped to the
          gh api "repos/$GITHUB_REPOSITORY/contents/config.yaml?ref=$GITHUB_SHA" …
          # `automation:` block (`ref:`/`path:` also appear elsewhere in config.yaml)
      - uses: actions/checkout@<pinned-sha>             # v4 — the CENTRAL repo only, never the fork
        if: steps.cfg.outputs.repo != ''
        with: { repository: '${{ steps.cfg.outputs.repo }}', ref: '${{ steps.cfg.outputs.ref }}', path: central }
      - uses: actions/setup-node@<pinned-sha>           # v4; node 24 — bare-node type-stripping,
        if: steps.cfg.outputs.repo != ''                # no build step
        with: { node-version: 24 }
      # …wait for the background xmllint install (pull_request_target only)…
      - if: steps.cfg.outputs.repo != ''
        env:                                            # (b) event context → central
          GH_TOKEN:   ${{ github.token }}
          BASE_REPO:  ${{ github.repository }}
          EVENT_NAME: ${{ github.event_name }}
          PR_NUMBER:  ${{ github.event.pull_request.number }}
          PR_AUTHOR:  ${{ github.event.pull_request.user.id }}        # numeric id = identity
          PR_AUTHOR_LOGIN: ${{ github.event.pull_request.user.login }} # login = commit prose only
          HEAD_REPO:  ${{ github.event.pull_request.head.repo.full_name }}
          HEAD_SHA:   ${{ github.event.pull_request.head.sha }}
          HEAD_REF:   ${{ github.event.pull_request.head.ref }}
        run: node central/${{ steps.cfg.outputs.path }}
```

The third-party actions are pinned to full commit SHAs. `concurrency` with `queue: max` serialises
runs so two events can't be applied concurrently (belt-and-braces alongside the coordinator's
optimistic-concurrency retry, §6).

**Trust boundary.** `pull_request_target` runs in the **base** repo's context with a write token.
The fork's code is **never executed** — the only checkout is the pinned central repo; the campaign
repo is read via the API (its base-ref config, the PR's changed paths, the blob at `HEAD_SHA`), so
the fork's tree is only ever data.

## 5. Config & table formats (schema v3)

### config.yaml

Authored once at instigation (`buildCampaignConfig` / `configToYaml`, `src/lib/campaign-init.ts`).
`configToYaml` rejects anything but schema 3, the `by-piece` strategy, the three piece kinds and
distinct piece paths (`assertSupported`), so nothing unsupported is ever committed as a campaign's
config.

```yaml
schema_version: 3
campaign:      { name, title, description, instigator, repo_id, language, license }  # name is the handle; instigator + repo_id are numeric GitHub ids
automation:    { central_repository, ref, path }   # the central pointer (§4a); ref is pinned
source:                                    # the physical source the pieces were read from
  kind: facsimile                          # what the source itself is
  images: [ img/001.jpg, … ]               # committed page images, repo-relative
  header: { title, composer, publisher, date }
  rights_acknowledged: <version>           # which acknowledgement the instigator agreed to
pieces:                                    # one work each: its own MEI, its own tasks
  - id: <piece-id>
    kind: facsimile                        # facsimile | encoded | physical-only
    path: sources/<piece-id>/score.mei     # the fragment its tasks address
    pages: <n>                             # physical-only: pages of the source it spans (optional)
    zones: [ { surface, ulx, uly, lrx, lry } ]  # page regions the piece covers (facsimile)
    header: { title, composer }
fragmentation: { strategy: by-piece }
validation:    { required_validations, pass_threshold }
locking:       { stale_after_minutes }
```

### The five tracking tables

All keyed by **`(task_id, subtask_id)`**: a **task** is the unit of *encoding* (one encoder), its
**subtasks** are the units of *validation* (reviewed in parallel, possibly split differently). A row
with an **empty `subtask_id` addresses the whole task**; a row with one addresses a single
validation portion. An `encoded` piece is the degenerate case: one task spanning the whole file with
one subtask spanning the same range.

**task.csv — task/subtask definitions, written at init**

`task_id, subtask_id, fragment, locator, allowlist, blocklist, depends_on`

- `fragment`: the source file the row addresses — its piece's MEI (e.g.
  `sources/<piece-id>/score.mei`).
- `locator`: address *within* the fragment — a page's surface id (`surface-N`) for a per-page
  encoding task, a controlled-vocab term for pre-tasks (`measure-zones`; §7a), or empty = the whole
  file. This is what realises per-page fragmentation; a finer split (by measure, by section) would
  reuse the same column.
- `allowlist`/`blocklist`: per-row claim gates — present in the schema but **not yet enforced**
  (default open, §10).
- `depends_on`: a task_id that must be `completed` before this task can be claimed; empty = none.
  Enforced in the claim accept rules (`dependency_incomplete`). Chains a facsimile piece's page
  tasks behind its pre-task (§7a).

The table is rendered from one plan (`planTasks`, `src/lib/campaign-init.ts`), which emits per
piece, in table order:

- **facsimile** → a measure-correction pre-task (`P000n`, locator `measure-zones`) plus one
  encoding task per page carrying measures (locator `surface-N`, matching that page's `<pb>`), each
  depending on the pre-task; a facsimile piece with no measured pages falls back to a single
  whole-file task.
- **physical-only** → no pre-task (there is no facsimile to correct measures on): one task per page
  when the piece's page count is known, else a single whole-file task.
- **encoded** → one whole-file task.

Task numbers run continuously across pieces, pre-task numbers across facsimile pieces, so every id
is unique campaign-wide. Every planned task gets a task row plus one validation subtask `S0001`;
`task.csv` and `state.csv` are both rendered from the same plan so they cannot fall out of step.

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

**comment.csv — the comment log (fail explanations and discussion), Action-authored**

`comment_id, task_id, subtask_id, kind, page, measure_start, measure_end, author_id, timestamp, resolved, parent_id, body`

- `kind` ∈ `fail|question|addition|reply`. A **`fail` validation requires a comment row** — it
  rides the same PR as the verdict, and the coordinator rejects a fail without one
  (`fail_without_comment`). `question`/`addition` are top-level discussion, `reply` points at its
  parent via `parent_id`.
- Comments are anchored to **measures, not pixels** (`page` + `measure_start…measure_end`), so they
  survive re-encoding; the console renders the anchor as a chip and highlights the range in both
  preview panes.
- `resolved` flips '' → `true` (author or push access only); resolved comments leave the attention
  counts. `comment_id`/`author_id`/`timestamp` are Action-authored, never the fork's values.

**history.csv — append-only audit log**

`timestamp, task_id, subtask_id, user_id, action, outcome, detail, command, version, input`

Every processed event appends a row — **including rejects** (attribution + audit): `action` ∈
`claim_encoding|claim_validation|submit_encoding|submit_validation|send_back|submit_comment|resolve_comment|reap|dispatch`,
`outcome` ∈ `accepted|rejected|released`, `detail` = the reject reason, the validation verdict, the
comment kind, or the reaped lock's kind.

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

**The PR types** (distinguished by changed path):

| PR | Allowed change | Carries |
|---|---|---|
| Claim | `tracking/lock.csv` only | task_id, subtask_id, kind |
| Encoding | the task's fragment (its piece's `score.mei`) only | the MEI content |
| Validation | `tracking/state.csv` only (plus one appended `tracking/comment.csv` row on a fail) | subtask + pass/fail verdict (+ the fail's mandatory comment) |
| Send-back | `tracking/state.csv` only (the reset of one failed task) | task_id, via the reset shape |
| Comment | `tracking/comment.csv` only | one appended discussion row, or one `resolved` flip |

The pre-task submissions (§7a) are ordinary *encoding-type* PRs — they rewrite the fragment.
Because several tasks can share one fragment (a piece's page tasks all address its `score.mei`), an
encoding-type PR's **task** is resolved from the PR's own data: the command envelope's task_id, the
`encode-<task_id>` branch name, or the author's single active encoding lock among the candidate
tasks (in that order; a lone candidate needs no tie-break).

**Joining encoding into the fragment.** A whole-file task (empty locator) and a pre-task take the
fork's fragment verbatim. A per-page encoding task (locator `surface-N`, §7a) contributes only its
page: the coordinator splices the fork's measures for that page — those inside the page's `<pb>`
span, matched by `xml:id` — into the base score and keeps every other page as it stands
(`src/lib/mei-page-splice.ts`). This is what lets page tasks be worked independently and merge
without clobbering each other; the spliced result is what the machine-check validates.

**Accept rules.**

- *Claim:* the addressed row exists and the key matches the kind (encoding → task row, validation →
  subtask row). For `encoding`: status is `encoding_required`, no active encoding lock, and every
  `depends_on` task is completed (`dependency_incomplete`). For `validation`: the subtask's status
  is `validation_required`, an open slot exists (`final cells + active validation locks on that
  subtask < required_validations`), the claimant isn't already holding one, and **isn't the task's
  encoder** (no self-validation).
- *Encoding:* PR touches only the fragment, author holds the active encoding lock, MEI passes the
  machine-check → task row gets `encoder`/`encoded_at` and → `validation_required`, its `pending`
  subtasks → `validation_required`, drop the lock.
- *Validation:* author holds the subtask's active validation lock → write its first open
  `validate_status_N` = `verdict|author|now`, drop the lock; once `pass_threshold` passes
  accumulate the subtask → `completed`, and when every subtask is completed the task row →
  `completed`. A **fail is recorded in place** — the task stays in validation, flagged for
  attention, and the fail's mandatory comment row is appended (re-authored) to `comment.csv`.
- *Send-back:* the explicit follow-up to a fail — the task is in `validation_required` with at
  least one recorded fail, and the author is one of the failing validators or has push access →
  the task returns to `encoding_required` with attribution cleared, its subtasks to `pending`,
  every validation cell clears, and all locks on the task are released.
- *Comment:* one appended row (kind `question|addition|reply`, non-empty body, an existing task,
  a `reply` pointing at an existing parent), re-authored by the Action; or one `resolved` flip,
  allowed for the comment's author or push access.

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

**End to end (an encoded piece — one whole-file task, one note):**

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

## 7. Instigation (Action A) — the onboarding wizard

Campaign creation is a six-step wizard at `/new`. One shared state object spans the steps
(`src/lib/wizard.svelte.ts`); each step is a component (`src/lib/components/Campaign*Step.svelte`):

1. **Name** — name, title, description. The name is the repo name, the registry slug and the
   campaign's address at once; it is availability-checked as typed and **claimed** in the slug
   registry on Continue (a leased hold with a claim token, §8a), so a slow setup cannot lose it.
2. **Licence** — the campaign licence.
3. **Upload** — what the campaign is built from: page images, PDFs (rasterised one page per
   document page), existing MEI encodings, a IIIF manifest (fetched through the broker's `/iiif`
   relay, §8a), or nothing at all.
4. **Pages** — which pages of the upload the campaign keeps, in reading order. On Continue the
   campaign repository is created from the template under the claimed name
   (`src/lib/campaign-repo.ts`: create or adopt the repo, set its Actions token to read/write,
   wait for the template contents) and the chosen pages are fetched at committing size and
   committed. An upload with no page images skips this step; the upload step creates the
   repository instead.
5. **Source** — metadata for the physical source as a whole (title, composer, publisher, date),
   collected once; each piece's MEI header copies it at the end. Nothing is committed here.
6. **Pieces** — the works within the source: per-piece metadata, the page regions a facsimile
   piece covers (`PieceZoneEditor`), an optional page count for a physical-only piece. Pieces are
   seeded from the upload — one per uploaded encoding plus one facsimile piece for the page
   images. On finish the measure detector (`src/lib/measure-detection.ts` → the edirom detector)
   proposes measure boxes for the facsimile pages; the step builds the config
   (`buildCampaignConfig`/`configToYaml`), each piece's `sources/<piece-id>/score.mei` (facsimile
   pieces via `buildFacsimileMei`, headers from the source and piece metadata forms) and the five
   tracking tables, commits them **in one commit**, registers the name (claim → active, §8a), and
   stamps the listing topic that puts the campaign in the campaign list.

Every step mirrors its entries into a per-campaign localStorage draft (`src/lib/wizard-draft.ts`),
so a setup interrupted by a reload, a closed tab or a failed step can be continued from the landing
page; the record is removed once the last step has committed. Runs client-side because the
organiser is in the loop; everything after creation runs in the campaign repo's caller.

## 7a. Facsimile pre-tasks

A facsimile piece does not start at encoding: the detector's measure boxes are provisional, so its
score is built in stages (`src/lib/mei-facsimile.ts`, one model — `buildFacsimileMei` /
`parseFacsimileMei`):

| Stage | Content of the piece's `score.mei` | Written by |
|---|---|---|
| A | `<facsimile>` only: surfaces, graphics, one labelled `<zone type="measure" n="…">` per box; one empty `<mdiv>` | init |
| B | + one `<measure n="…" facs="#zone">` (holding an `<mRest/>`) per zone | (intermediate form; still parsed) |
| C | + a `<pb/>` before each page's first measure, an `<sb/>` before each flagged measure, and one `<mdiv>` per movement/section/piece | the pre-task's submission (`submitZones`) |

All stages validate against the pinned MEI-CMN 5.0 schema, so the ordinary machine-check
applies to every submission.

The pre-task submission advances the score from stage A to stage C, so its content always differs
from the file already in the repo — even when the volunteer changed nothing, because the new stage
adds elements (measures, breaks, movements) stage A lacked. That guaranteed diff matters: the
caller's `pull_request_target` is `paths`-filtered (§4), so an identical file would open an empty
PR that never triggers the automation and leaves the console polling forever.

The task table chains the work via `depends_on` (§5): per facsimile piece, one pre-task
(`locator: measure-zones`, one validation subtask) → **one encoding task per page** that carries
measures (`locator: surface-N`, one validation subtask each), all depending on that piece's
pre-task. The pre-task establishes the `<pb>` boundaries and continuous measure numbering the
per-page split and join rely on. Each is an ordinary crowd task: claimed (encoding-kind lock),
submitted as an encoding-type PR (joined into the piece's score by page, §6), validated through
the normal machinery. Pages with no detected measures get no encoding task. An `encoded` piece
keeps its single whole-file task and no pre-task.

The **zone editor** (`/[campaign]/zones/[task]`) is the volunteer interface for the
pre-task, driven entirely by commands (`readFacsimile`, `claimTask`, `submitZones`). It has two
steps within the one task, submitted together:

- *Step 1 — Measures*: add (drag on the page), delete, move and resize boxes over the page
  image. Numbering follows reading order automatically; a per-measure label override (e.g.
  `10a`/`10b` for voltas) interrupts the sequence and numbering continues from its integer prefix.
  Validators review the same view read-only and pass/fail from the console.
- *Step 2 — Breaks & movements*: page breaks are automatic (one per surface); the volunteer clicks
  measures to toggle system starts (pre-suggested from the detected row grouping) and shift-clicks
  to mark a measure as the start of a movement, section or piece — each becomes its own `<mdiv>`.

## 7b. The campaign console

`/[campaign]` (`src/routes/[campaign]/+page.svelte`) is where a campaign is followed and worked:
volunteers claim, submit and discuss; the instigator additionally edits the plan and dispatches the
reaper. Everything runs through the command registry (§5); the display is pure projection of the
tracking tables and the comment log:

- **The pipeline board** — five status columns (*Blocked · Ready to claim · Encoding · Validation ·
  Done*) of task cards, with per-task attention counts (recorded fails, open comments, open
  questions) and an activity ticker from `history.csv`. Built by `buildBoard`
  (`src/lib/campaign-board.ts`) on top of the task projection in `src/lib/campaign-graph.ts`
  (`buildGraph`: per-task status keys, validation slots, the viewer's next step —
  `campaign-graph.ts` contains only this projection, no layout or panel code). A **tables view**
  toggles from the board and shows the same tables row by row.
- **Plan editing** — `PlanEditor.svelte` rewrites `task.csv` through the `campaign.savePlan`
  command (push access required; `src/lib/campaign-plan.ts` `checkPlan` re-validates against
  freshly read tables so a claim landing mid-edit rejects the save). Only *untouched* tasks — no
  claim, no encoding, no verdict — may be added, removed, rewired or edited; a started task must be
  carried over verbatim and can only change position. New tasks get matching
  `encoding_required`/`pending` state rows.
- **The task overlay** — opens from a board card, with the board behind it: a score preview of the
  task's piece rendered by Verovio (a ~2 MB WASM module, loaded on first preview and reused) with
  comment anchors highlighted on their measures, the task's validation record (`buildRecord`), and
  its discussion threads (`buildThreads`) — commenting, replying and resolving run the comment
  commands (§6).

## 7c. Routes, navigation & cross-campaign stats

| Route | Content |
|---|---|
| `/` | The landing page: a rail with the start card, unfinished wizard setups (continuable drafts, §7) and the viewer's claimed work; every campaign in a paginated grid (12 per page) with search, sort and an open-tasks filter. |
| `/new` | The onboarding wizard (§7). |
| `/dashboard` | The personal dashboard (`src/routes/dashboard/+page.svelte`): the viewer's work across every campaign, grouped by what needs doing — *fix requested → encoding → awaiting validation → recently completed* — with every comment on their work as a feed. Actions run the same commands as the console; anything richer deep-links into the campaign's console. |
| `/[campaign]` | The campaign console (§7b). The URL carries only the campaign name; the repo is resolved name → stable repo id (registry, §8a) → current owner/name (`src/lib/campaign-resolve.ts`). |
| `/[campaign]/zones/[task]` | The measure-zone editor (§7a). |

Because a campaign lives at `/<name>` on the app's own origin, every top-level path the origin
serves is unregistrable as a campaign name (`broker/slug_validation.py` `RESERVED_NAMES` — `auth`,
`registry`, `new`, `campaigns`, `dashboard`, …; `test_registry.py` checks the route list against
it). The app is themed light/dark from tokens in `src/routes/theme.css`: a pre-paint script sets
`data-theme` before mount and the layout header carries the toggle.

**Cross-campaign stats** (`src/lib/campaign-stats.ts`) feed the landing grid, the your-work panel
and the dashboard: per campaign, the tracking tables condensed into the numbers a tile or card
shows (progress, tasks claimable right now, contributors, last activity, a facsimile page as tile
preview) plus the raw tables, so the personal projections (`myTasksIn`, `commentsOnMyWork`) can
pull one user's work out of them. `loadCampaignStats` fetches and caches per repo id. The listing
is per-repo client fetches, so logged-out browsing shares GitHub's anonymous 60 requests/hour
per-IP quota (§10).

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

## 8a. The broker's service mounts

Beyond OAuth and the API relay (§3), the session broker carries two same-origin services:

- **The slug registry** (`broker/registry.py`, a Flask blueprint mounted at `/registry`) owns
  exactly one thing: the mapping from a campaign's user-chosen name to the forge repo id of its
  repository — one SQLite table (`broker/slug_db.py`), no campaign content, no analytics. A name
  is taken in two steps, because a setup takes a while and the repo id only exists once the
  campaign does: `POST /claim` holds the name against a claim token (a lease — running out only
  lets someone else take the name), `POST /register` presents the token when the campaign is
  finished. Statuses are `pending` (a setup in progress), `active` (a campaign that exists) and
  `tombstoned` (staff removed the name via the admin route; the row is kept so the name stays
  occupied). The resolver `GET /api/slug/<name>` is public so logged-out visitors can browse;
  claiming and registering require the GitHub session. Admin routes are bearer-gated and expect
  institutional auth at the reverse proxy in production.
- **The IIIF relay** (`GET /iiif`, `broker/app.py`) fetches a IIIF manifest or canvas image
  same-origin for the onboarding wizard. Campaign sources come from arbitrary institutions, which
  rules out a CSP host allowlist, and many IIIF servers send no CORS headers — the relay solves
  both. It is session-gated, attaches no credentials, allows only https, re-checks every redirect
  hop against public-address rules, and is rate-limited (20 requests/second per user; the client
  paces its canvas fetches under that ceiling).

## 9. Status

The architecture above is what the repos contain:

- **Static SPA + session broker** — `adapter-static`, no server routes. OAuth runs server-side in
  the session broker (`broker/`, Flask), which holds the token and relays authenticated forge
  calls; all forge access goes through the `ForgeClient` seam (`src/lib/forge/`). A strict CSP is
  baked into the build (`svelte.config.js`). The broker also mounts the slug registry and the
  IIIF relay (§8a).
- **One generic caller** — the template ships a single `caller.yml` (§4) that reads the
  `automation:` pointer from the campaign's `config.yaml` on the base ref and runs the central
  coordinator.
- **Central automation** — this repo doubles as the central repo: `scripts/coordinator.ts` is the
  single entry (routes on `EVENT_NAME` + changed paths), reusing the pure decision modules
  (`campaign-tables`, `campaign-claim`, `campaign-submit`, `campaign-reaper`,
  `coordinator-policy`) that the SPA also imports.
- **Data model** — schema v3 (§5) end to end: init writes the five tables, `configToYaml` rejects
  unsupported configs, the decision modules and coordinator address `(task_id, subtask_id)`, and
  every outcome — including rejects — appends to `history.csv`.
- **Surfaces** — the onboarding wizard (§7), the landing page and personal dashboard (§7c), the
  campaign console with board, tables view, plan editor and task overlay (§7b), and the zone
  editor (§7a) are all built, all driving the forge through the command registry.
- **Command layer** — every console operation is a named, versioned command (`src/lib/commands.ts`)
  run through one dispatcher, and every mutating command fills the command columns of a
  `history.csv` row (§5): PR-flow commands via the envelope in the PR body (Action-authored row,
  `scripts/coordinator.ts` + `src/lib/command-envelope.ts`), the reaper dispatch via a direct
  client commit.

Convention preserved: decision logic stays pure and tested (GitHub is never touched in unit tests);
only thin shells — the coordinator and the `ForgeClient` — touch the forge.

**Verification.** Unit tests cover the decision modules, initialisation and the projections. A live
end-to-end run (2026-07-02, throwaway campaign `ohwjd/e2e-caller-test`, on schema v1 at the time)
confirmed the caller pipeline mechanics: claim accepted (Action-authored lock) → stale lock reaped
via `workflow_dispatch` → re-claim → encoding accepted (schema machine-check, volunteer MEI merged
with `Co-authored-by` attribution) → same-account validation claim rejected (`self_validation`) →
PR head branches cleaned up. Not yet exercised live on the current model: the **schema v3
pipeline**, a validation *accept* (needs a second account — the no-self-validation rule blocks
one-account testing), and the full pre-task pipeline (zones submit → validate → encoding
unblocked).

**Runtime.** Central code is TypeScript run by bare `node` (≥23.6 type-stripping), so the caller pins
`node-version: 24` and the coordinator imports use real `.ts` specifiers. The SPA imports the same
modules via Vite. No build step for the automation.

## 10. Roadmap & deferred

Deferred (designed, not built):

- **Allow/blocklist enforcement** — an optional per-task gate in the accept logic; the columns
  exist in `task.csv` (§5) but are **default open** (anyone can claim).
- **GitLab (and other) `ForgeClient`** implementations behind the §8 seam.

Known limitations:

- **Anonymous browsing quota** — the landing grid and dashboard fetch each campaign's tables from
  the client per repo, so logged-out visitors share GitHub's anonymous 60 requests/hour per-IP
  quota (§7c). Logged-in traffic uses the user's own quota via the broker relay.

## 11. Before production — hardening checklist

- [ ] **Pin the central ref.** `automation.ref` in each campaign's `config.yaml` must be an immutable
  tag/SHA, not a moving branch; upgrade by committing a new ref. (Iteration uses `main` — set
  `PUBLIC_AUTOMATION_REF` for the production deployment.)
- [x] **Central reachability** — the central repo (this one) is public, so the caller's checkout
  needs no token.
- [x] **Never execute fork code** — the caller checks out only the pinned central repo; the fork is
  data (§4, §6).
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
