# Let's Encode! — design & status

**Let's Encode!** is a decentralised crowd-encoding system for music scores. There is no
central server that owns campaign state: each campaign lives in an ordinary GitHub
repository, and the coordination logic (task assignment, locking, validation, merging,
attribution) runs as GitHub Actions in that repo. Two thin clients drive it through GitHub's
API and pull requests — an **instigation GUI** (organiser creates/configures a campaign) and
the **mei-friend volunteer client** (contributors encode/validate).

This is the single authoritative design + status document. Scope below is **v1**: the
`whole` fragmentation strategy, where one campaign = one task = the whole `sources/score.mei`.

> Continuing in a fresh session? Read this top-to-bottom; current state is §7, next task §8.
> Coding guidelines to honour are in `CLAUDE.md` (simplicity, surgical changes, goal-driven).

## 1. The three components

- **Instigation GUI** (`instigation/`, a SvelteKit app) — organiser logs in with GitHub,
  creates a campaign repo from the template, and configures it. Also the home of the
  **central automation code** the campaign workflows call (see the caller/central split below).
- **Campaign repository** — an independent repo stamped from the template
  (`lets-encode/user-repo-template`). Holds the score sources, `config.yaml`, the two tracking
  tables, and thin caller workflows. The heart of the system.
- **mei-friend volunteer client** — where contributors claim/encode/validate. Out of scope
  here except for the PR contract it relies on (§6).

**Two copy mechanisms.** Instigation uses GitHub's *generate* (template → independent campaign
repo): a campaign is its own project, made many times from one template, never PRs back.
Volunteers *fork* the campaign repo and submit work as PRs upstream — the model that makes
cross-repo PRs cheap and standard.

**Caller/central split.** To keep the campaign repo minimal and human-glanceable, the Actions'
real code is not inlined in it. Each campaign workflow is a thin caller that checks out the
central automation code (in `instigation/` for now) at a pinned ref and runs it. Trade-off: a
campaign's automation depends at run time on that central repo + ref being reachable — so
"each campaign lives entirely in its own repo" holds with that qualification. (Action A is the
exception — it runs server-side in the GUI at creation; §5.)

## 2. Settled decisions

| Decision | Resolution |
|---|---|
| Generate vs. fork | generate for instigation; fork for volunteers (PRs upstream). |
| Table format | **CSV** — machine-readable; one cell/row changes per PR → minimal diffs. Users never read/write them on GitHub directly; the platform presents them. |
| Config format | **YAML** — small, reviewable, diffable, self-documenting. |
| Sources (v1) | a **barebones MEI** stamped from the template, header filled at instigation (one measure, one note). IIIF/image/existing-MEI/OMR are future. |
| MEI checks vs validation | machine checks (well-formed XML + schema) **gate** a submission but are separate from **validation** — a human peer-review step (several reviewers, instigator-configured). |
| Auth scope | the GUI logs in with the full GitHub **`repo`** scope (it needs admin on created repos, e.g. to enable Actions write permissions). |
| Table integrity | **the Action is the sole author of all table mutations**; volunteer PRs supply only intent + MEI content (§6). |
| Fork-PR trust | campaign workflows use **`pull_request_target`** — run trusted code in the base repo's context, treat the fork PR as data, never execute it (§6). |
| Ids / timestamps | zero-padded `T0001…`; ISO-8601 UTC (`…Z`) everywhere. |

## 3. The campaign repository (template contents)

Everything here ships in the template and travels into each campaign copy:

- `config.yaml` — the single source of truth for task definition (§4). The template ships
  `config.example.yaml`; the GUI writes the filled `config.yaml` at creation.
- `sources/score.mei` — the working score. v1: stamped from `templates/score.template.mei`
  (placeholders `{{TITLE}}`, `{{COMPOSER}}`, `{{LICENSE}}`).
- `tracking/state.csv`, `tracking/locks.csv` — machine-maintained tables (§4).
- `.github/workflows/` — thin caller workflows (claim, submit, reaper).

## 4. Config & formats (v1)

### config.yaml

Authored once at instigation; minimal but extensible (growth points are marked `(reserved)`
in `config.example.yaml`).

```yaml
schema_version: 1
campaign:      { title, description, instigator, language, license }
sources:       [ { id, kind: mei-template, path, template, header: { composer } } ]
fragmentation: { strategy: whole }
validation:    { required_validations, pass_threshold }
locking:       { stale_after_minutes }
```

| Path | v1 meaning |
|---|---|
| `campaign.title` | → MEI `<title>`. |
| `campaign.license` | e.g. `CC-BY-4.0` → MEI `<useRestrict>`. |
| `campaign.instigator` | organiser's GitHub login. |
| `sources[].kind` | v1 only `mei-template` (reserved: `iiif`, `image-urls`, `existing-mei`, `omr`). |
| `sources[].header.composer` | → MEI header. |
| `fragmentation.strategy` | v1 only `whole` (reserved: `by_measure`, `by_section`, `parts`). |
| `validation.required_validations` | number of `v1…vn` cells per task. |
| `validation.pass_threshold` | `pass` count that completes a task. |
| `locking.stale_after_minutes` | abandoned claims released after this (reaper). |

*Growth (not in v1):* richer `sources[].kind`, the extra fragmentation strategies, and
`validation.rubric`/`strictness`/`separate_fragmentation`. The schema is shaped to absorb
these without a redesign.

### state.csv — one row per task

`task_id, fragment, state, encoder, encoded_at, v1 … vn`

- `state`: `encoding_required` → `validation_required` → `completed`.
- `v1…vn`: validation cells, count = `required_validations`. Each is empty or a pipe token
  `status|user|timestamp` with status ∈ `pass|fail` (pipe avoids colliding with the colons in
  timestamps). **In-progress validation is tracked by a `validation` lock, not an in-cell
  marker** — a cell stays empty until a final pass/fail.

### locks.csv — one row per active claim (header-only after init)

`task_id, locked_by, locked_at, kind` with `kind` ∈ `encoding|validation`. The reaper compares
`locked_at` against `stale_after_minutes`.

## 5. The Actions (A–E)

| | Action | Trigger | Runs |
|---|---|---|---|
| A | Initialisation | GUI "Create repo" | **server-side in the GUI** |
| B | Claim (lock) | fork PR touching `locks.csv` | caller workflow → central |
| C | Submission (encode / validate) + D | fork PR (fragment / `state.csv`) | caller workflow → central |
| E | Stale-lock reaper | cron | caller workflow → central |

- **A — Initialisation.** At creation the GUI generates the repo, then commits `config.yaml`,
  the stamped `sources/score.mei`, `state.csv` (one task `T0001`, `encoding_required`, empty
  `vN`) and a header-only `locks.csv` — in one commit. Idempotent: output is fully determined
  by config + template, so re-running before any volunteer work reproduces identical files. It
  runs server-side because the organiser is in the loop; B–E run as in-repo workflows.
- **B — Claim.** Validates a claim deterministically and reserves the task; first valid claim
  wins (§6).
- **C — Submission (+ D).** Validates an encoding or a validation outcome, merges the MEI
  content, and advances state/attribution (§6). D (state advance) is folded in.
- **E — Reaper.** Periodically clears locks older than `stale_after_minutes`. Cron timing is
  coarse, so the logic tolerates imprecise firing.

## 6. Volunteer PR contract & trust (Actions B/C/D)

**Trust model.** Campaign workflows fire on `pull_request_target`: they run in the **base
repo's context** (write token) using the workflow + central code from the trusted side; the
fork PR is read only as **data** (its diff/patch via the API — no fork checkout, no fork code
executed).

**Integrity — the Action authors all table mutations.** A volunteer PR supplies only (a)
*intent* (which task, claim kind, or pass/fail verdict) and (b) *MEI content*. The Action
derives the authoritative row/cell itself:

| Field | Authoritative source |
|---|---|
| `locked_by` / `encoder` / validator login | the **PR author** (from the event) |
| `locked_at` / `encoded_at` / validation time | **server time** |
| validation `pass`/`fail` | the volunteer's verdict, stamped with their login + time |
| MEI bytes | the **fork's content**, after the machine-check |

So table changes are *applied by the Action*, not merged verbatim from fork bytes (a boundary
check limits *which* cells change, not *what values* go in). MEI content is the volunteer's and
is merged.

**The three PR types:**

| PR | Allowed change | Carries |
|---|---|---|
| Claim (B) | `tracking/locks.csv` only | task_id, kind |
| Encoding (C) | the task's fragment (`sources/score.mei`) only | the MEI content |
| Validation (C) | `tracking/state.csv` only | pass/fail verdict |

**Accept rules.**

- *Claim:* task exists; for `encoding`, state is `encoding_required` and no active encoding
  lock; for `validation`, state is `validation_required`, an open slot exists `(final cells +
  active validation locks < required_validations)`, the claimant isn't already holding one, and
  **isn't the encoder** (no self-validation).
- *Encoding:* PR touches only the fragment, author holds the active encoding lock, MEI passes
  the machine-check → set `encoder`/`encoded_at`, state → `validation_required`, drop the lock.
- *Validation:* author holds the active validation lock → write the first open `vN` =
  `verdict|author|now`, drop the lock; once `pass_threshold` passes accumulate, → `completed`.

**Race arbitration (optimistic concurrency).** GitHub serialises writes to `main`. A shell
reads the tables pinned to the branch-head SHA, decides, then commits on that exact parent with
a **non-fast-forward** ref update. If a competing change merged first, the update fails →
re-read, re-decide (now sees the new lock) → reject cleanly. First valid claim wins; the loser
fails cleanly. Claim/validation PRs are **closed, not merged** (the authoritative change is the
Action's own commit); encoding PRs contribute their MEI content.

**MEI machine-check.** Well-formed XML (now) + schema-valid MEI (validator still to choose; the
template declares MEI-CMN 5.0). Musical correctness is *not* machine-checked — that is the
human `vN` validation.

**End to end (v1, one note):**

```
init:                       T0001 … encoding_required           locks: —
bob claims encoding (B)                                          locks: T0001,bob,…,encoding
bob submits encoding (C)    encoder=bob, validation_required     locks: —   (score.mei merged)
carol claims validation (B) (carol ≠ bob)                        locks: T0001,carol,…,validation
carol submits pass (C/D)    v1=pass|carol|… ; threshold met → completed     locks: —
```

## 7. Implementation map & current state

Central code (in `instigation/`) — pure decision logic, unit-tested with **no live or mocked
GitHub** (`npm test`):

| File | Role |
|---|---|
| `src/lib/server/campaign-init.js` | Action A: config build, MEI stamp, table generation. |
| `src/lib/server/campaign-tables.js` | CSV parse/serialise for state & locks. |
| `src/lib/server/campaign-claim.js` | Action B: `boundaryCheck`, `checkClaim`. |
| `src/lib/server/campaign-submit.js` | Action C/D: `checkEncoding`, `checkValidation`. |
| `src/lib/server/campaign-reaper.js` | Action E: `reapLocks`. |
| `src/lib/server/github.js` | GitHub REST helpers (auth, generate, commit, branch, PR, dispatch). |
| `scripts/claim.mjs` | Action B workflow shell (impure GitHub I/O). |
| `scripts/submit.mjs` | Action C/D workflow shell (impure GitHub I/O). |
| `scripts/reap.mjs` | Action E workflow shell (impure GitHub I/O). |
| `src/routes/campaign/[owner]/[repo]/` | Campaign console: drives the Actions from the GUI. |

Status:

- **A** wired into the GUI create flow (generate → set Actions write perms → commit config +
  score + tables).
- **B** wired end to end: `user-repo-template/.github/workflows/claim.yml` (`pull_request_target`
  caller) + `scripts/claim.mjs`.
- **C/D** wired end to end: `user-repo-template/.github/workflows/submit.yml` + `scripts/submit.mjs`
  (encoding well-formedness via `xmllint`; MEI schema validation still pending).
- **E** wired: `user-repo-template/.github/workflows/reaper.yml` (scheduled) + `scripts/reap.mjs`.
- **Campaign console** (`/campaign/[owner]/[repo]`) — a GUI page that drives B/C/E by opening
  the same PRs a volunteer client would (claim → encode → validate) and dispatching the reaper.
  Owners/collaborators commit on a branch in the repo directly; **anyone else forks the repo and
  opens a cross-repo PR upstream** (the real volunteer model — needs a public repo or read access
  to fork). Stands in for mei-friend.
- All five Actions are **not yet live-tested** on a real campaign.
- **mei-friend** already exists and can be connected to a campaign — volunteers open it via URL
  parameters (`file=` pointing at the score, `fork=true`), so the volunteer encoding/validation
  loop has a working editor today.
- Not built: the **MEI schema validator** and a dedicated **WYSIWYG MEI editor** (a separate,
  lower-friction editing surface).

Convention: decision logic stays pure and tested; only the thin `*.mjs` shells touch GitHub
(and stay untested, by preference).

## 8. Roadmap

1. **Live end-to-end test** — drive A–E against a real campaign repo via the campaign console
   (the shells are statically verified but not yet exercised live). ← next
2. **MEI schema validator** — wire `xmllint --relaxng` (or chosen tool) into `submit.mjs`'s
   machine-check, beyond the current well-formedness check.
3. **Volunteer PR contract end-to-end** — scripted GitHub calls standing in for mei-friend,
   before editor integration.

## 9. Before production — hardening checklist

Deferred while iterating; **required before any real (non-test) campaign**:

- [ ] **Pin the central ref.** Each caller workflow checks out and *runs* the central code.
  While iterating they use `lets-encode/instigation@main` — a moving branch, so any push
  changes what every live campaign runs. Pin each workflow's checkout `ref:` to an immutable
  tag/SHA (e.g. `@v1`); upgrade by bumping it. Affected: every
  `user-repo-template/.github/workflows/*.yml` that checks out central (`claim.yml`,
  `submit.yml`, `reaper.yml`). Because `ref` is just an input, splitting central out of
  `instigation` later is the same one-line change.
- [ ] **Central repo reachability** — simplest if `lets-encode/instigation` is public; else the
  checkout needs a token.
- [ ] **Actions write permissions** — the create flow sets `default_workflow_permissions: write`
  (works for repos the user owns via the `repo` scope); confirm for org-owned repos.
- [ ] **MEI schema validator** — choose + pin so the machine-check covers schema validity, not
  just well-formedness.
