# Let's Encode! — security hardening notes

Threat-model review of the campaign automation (GitHub Actions), the SPA, and the
OAuth session broker, as the code stands on 2026-08-05. Companion to `DESIGN.md`
(§4 caller, §6 PR contract, §11 hardening checklist).

Findings are grounded in the current implementation:
`user-repo-template/.github/workflows/caller.yml`, `instigation/scripts/coordinator.ts`,
`instigation/src/lib/coordinator-policy.ts`, `campaign-claim.ts`, `campaign-submit.ts`,
`instigation/src/routes/**`, and `instigation/broker/app.py`.

## What the design already gets right

These properties were checked against the code and hold; they are the reason the
obvious attacks don't work, and they must not regress.

- **Fork code is never executed.** `caller.yml` runs on `pull_request_target` in
  the base repo's context but `actions/checkout` (pinned by SHA) takes the base
  tree only. The fork is read purely as data — changed paths and blobs via the
  API. There is no fork checkout and no fork script execution.
- **The Action authors every table mutation.** Identity is the PR author's
  *numeric* account id from the event (`PR_AUTHOR`), timestamps are server time.
  A fork's proposed CSV bytes are never merged for claim/validation PRs — those
  PRs are closed, and the authoritative change is the Action's own commit.
- **Path boundary enforced.** `boundaryCheck` (in `campaign-claim.ts`) rejects any
  PR whose changed paths fall outside the single file its operation allows
  (claim → `tracking/lock.csv`, validation → `tracking/state.csv`, encoding → the
  task's fragment).
- **Central pointer read from the base ref**, never the fork (`caller.yml` cfg
  step reads `config.yaml` from the base tree; the caller's `paths:` filter does
  not include `config.yaml`, so a fork cannot even trigger on it).
- **MEI schema machine-check** runs `xmllint --relaxng` against the pinned
  MEI-CMN 5.0 schema with a **SHA-256 integrity check** on the fetched schema.
- **Broker keeps the token server-side.** `__Host-` cookie prefix in production,
  `HttpOnly`, `SameSite=Lax`, `Secure`; session-ID regeneration after auth
  (fixation defense); authlib `state` + PKCE `S256`; token revoked at GitHub on
  logout; `return_to` validated same-origin; proxy is login-gated, allowlisted to
  `api.github.com`, strips client-supplied `Authorization`/`Cookie`/`Host`, and
  disables upstream redirects (`allow_redirects=False`).

The exposures below are not in the PR mechanics — they are in the crowd logic,
resource limits, one render sink, and blast-radius / defense-in-depth choices.

---

## Findings

Severity uses likelihood × impact for this system (a public crowd-encoding tool
where campaigns live in an individual's personal GitHub account).

### H-1 — Mutable central ref → supply-chain RCE across every campaign
**Severity: Critical · Status: KNOWN / PLANNED (DESIGN.md §11, still open)**

The caller checks out `automation.central_repository` at `automation.ref` and runs
`node central/<path>` with a `contents:write` + `pull-requests:write` token. During
iteration `automation.ref` is the moving branch `main`. Anyone who can push to the
central repo (which doubles as the instigation repo) thereby runs code inside
**every live campaign's** Action with that campaign's write token.

*Exploit sketch:* compromise or mis-merge into central `main` → next
`pull_request_target`/`schedule` in any campaign pulls and executes the new code
with a write token scoped to that campaign → tables and score rewritten at will.

*Fix (already on the roadmap):* pin `automation.ref` to an immutable tag or commit
SHA; upgrade by committing a new ref. Set `PUBLIC_AUTOMATION_REF` for production.
Nothing else here blocks on that — flagged only so it isn't lost.

### H-2 — Sybil validation can force-accept arbitrary encodings
**Severity: High · Status: partially by design (allowlist deferred)**

The no-self-validation rule (`campaign-claim.ts`) keys on the numeric account id,
and `allowlist`/`blocklist` are unenforced (default open, DESIGN.md §10). The
machine-check verifies MEI *validity*, not musical correctness — human validation
is the only correctness guard. An attacker with N accounts encodes on account A and
passes validation to `pass_threshold` with accounts B, C… No single account
self-validates, so every check passes.

*Impact:* the attacker controls task outcomes — pushing through deliberately wrong
encodings or steering a campaign's result. This is the primary "capture" vector.

*Fix options:* enforce the per-task allowlist for validation (turn the designed-but-
unbuilt gate on for sensitive campaigns); raise `required_validations`; add an
instigator-review/approval step before a task flips to `completed`; consider
account-age / contribution-history heuristics. Full anti-Sybil is hard on public
forges — the realistic mitigation is allowlist + human approval for campaigns that
need integrity.

### H-3 — OAuth scope blast radius
**Severity: Medium · Status: MITIGATED (narrowed to `public_repo`)**

The broker requests `scope: "public_repo notifications"` — read/write over the
user's **public** repositories plus notification management, and no access to
their private repositories. The token never reaches the browser (good), but
anything that can drive the broker proxy as the victim (see M-1) acts with that
scope, so it could write to the user's public repos.

A GitHub App was evaluated to scope access to campaign repos only, but GitHub
requires **"All repositories"** access to create a repository (a fork or a
template-generate) through an App — broader than `public_repo`, and it includes
private repos — so the App path was not adopted. `public_repo` is the narrowest
classic scope that still permits the fork/create flow; narrowing further would
require per-repo fine-grained tokens the user creates by hand. M-1 (XSS) remains
the thing that would abuse this scope, so it matters more.

### M-1 — Stored XSS via Verovio SVG injected with `{@html}`
**Severity: Medium (High impact, lower likelihood) · Status: FIXED (2026-08-05) — DOMPurify sanitises every rendered page (SVG profile) before it reaches the `{@html}` sink**

`instigation/src/routes/[campaign]/+page.svelte:1604` injects Verovio's
rendered notation with `{@html flagSvg(preview.svgs[p + 1] ?? "")}`. `flagSvg`
is not a sanitiser — it round-trips the SVG through `DOMParser` to add a CSS
class to flagged measures and passes everything else through. The SVG is produced
by `verovio.renderToSVG(...)` from `score.mei`, whose content is attacker-supplied
(merged from an accepted encoding PR). The rest of the UI is safe: the campaign
listing renders `{repo.description}` / `{repo.full_name}` through Svelte's
auto-escaped `{...}` interpolation, and `{@html}` appears **only** at this one sink.

*Exploit sketch:* land a schema-valid MEI whose Verovio SVG output carries an active
payload (e.g. via text/annotation fields or SVG constructs Verovio does not fully
neutralise). When the instigator or a validator opens the console preview, the
payload runs in the SPA origin. It cannot read the token (HttpOnly), but it can call
the broker `/proxy/**` as the victim — which, with the `public_repo notifications`
scope (H-3), is write access to every public repository the victim owns.

*Why not higher:* the MEI must pass `xmllint --relaxng` against MEI-CMN 5.0, which
does not admit arbitrary HTML/script, and Verovio escapes text output — so a working
payload is non-trivial. But "engine output derived from untrusted input, injected as
raw HTML" is exactly the pattern that should not rely on the engine's escaping.

*Fix:* sanitise the SVG before injection (DOMPurify with the SVG/SVG-filters profile,
`FORBID_TAGS: ['script','foreignObject']`, strip `on*` attributes and
`href`/`xlink:href` `javascript:` values), or render into a sandboxed
`<iframe sandbox>` / a detached document. Sanitising at the `{@html}` boundary is the
smallest change and keeps the strict CSP as the second layer.

### M-2 — Open lock squatting freezes a campaign
**Severity: Medium · Status: new finding**

Claiming is open (H-2) and encoding locks are exclusive (one per task,
`campaign-claim.ts`). An attacker can claim every task; the only release is the
reaper after `stale_after_minutes`. `caller.yml` runs the reaper on an **hourly**
cron (`0 * * * *`) plus lazily on each claim, so a script that re-claims on release
can keep every task locked indefinitely, locking out legitimate encoders.

*Fix:* per-account concurrent-claim caps; allowlist for claims on sensitive
campaigns; shorten `stale_after_minutes` and/or reaper cadence; optionally an
instigator "force release" from the console (the `workflow_dispatch` path exists).

### M-3 — PR flooding exhausts Actions minutes / API quota and bloats history
**Severity: Medium · Status: new finding**

Every PR touching `tracking/**` or `sources/**`, including each `synchronize` push,
triggers a workflow run in the **instigator's personal account**, consuming their
Actions minutes and API quota. Every processed event — including rejects — appends a
`history.csv` commit (DESIGN.md §6). `concurrency` serialises runs with
`cancel-in-progress: false`, so floods queue rather than drop.

*Exploit sketch:* open/synchronise many PRs → backlog of serialized runs burns the
instigator's minutes and rate limit; rejected spam still grows `history.csv` and the
git history.

*Fix:* the `paths:` filter already narrows triggers; add early cheap rejects (drop
PRs from brand-new/zero-history accounts before the heavy steps), cap runs, and
consider that rejected PRs need not always commit an audit row. Monitor the telemetry
the coordinator already emits (`[github-api-summary]`).

### M-4 — Broker CSRF rests solely on SameSite=Lax + `__Host-` prefix
**Severity: Low–Medium · Status: FIXED (2026-08-05) — same-origin `Origin`/`Referer` check on all state-changing routes**

State-changing proxy calls use POST/PUT/PATCH/DELETE, which SameSite=Lax does
not send cross-site, so CSRF was effectively blocked — but the entire defense
was the cookie attribute plus the `__Host-` prefix, with no independent second
layer. `app.py` now rejects any POST/PUT/PATCH/DELETE whose `Origin` (or, when
absent, `Referer`) names a different host than the request arrived at,
covering `/proxy/**`, `/logout` and the registry's claim/register/release
routes. A double-submit CSRF token remains optional on top.

### M-5 — The broker `/iiif` relay is SSRF-shaped by design
**Severity: Medium · Status: mitigated in code, residual risk accepted**

`GET /iiif?url=…` (`broker/app.py`) fetches a browser-supplied URL server-side
and returns the body — a server-side request forgery surface by construction.
It exists because campaign sources come from arbitrary institutions' IIIF
servers, so the host cannot be an allowlist. The mitigations in place: the
route is login-gated and rate-limited per user; only `https` URLs are accepted;
`resolves_to_public_address` rejects any hostname resolving to a private,
loopback, link-local, reserved, multicast or unspecified address (every
resolved record is checked); redirects are not followed by `requests` but
re-entered manually, so each hop is re-validated against the same rules (max 5);
the response is capped at 25 MB and restricted to JSON / image content types;
no credentials are attached upstream.

*Residual risk:* DNS rebinding between the `getaddrinfo` check and the actual
connect (TOCTOU) is not closed — the check and the fetch resolve independently.
A logged-in user can also use the relay to probe arbitrary public HTTPS hosts
from the broker's IP. Both are bounded by the login gate and the public-address
rule. *Hardening options:* pin the connection to the checked address, and/or
egress-filter the broker host.

### L-1 — `node central/${{ path }}` and the awk YAML parser are base-controlled footguns
**Severity: Low · Status: hardening**

`caller.yml` expands `node central/${{ steps.cfg.outputs.path }}` unquoted, and the
central pointer is read by a hand-rolled awk scan of `config.yaml`. These read from
the base ref, so a fork PR cannot influence them — but a mistyped or compromised base
`config.yaml` becomes command injection into the run step, and the awk parser is
fragile. *Fix:* validate `repo`/`ref`/`path` against strict patterns before use;
quote expansions; treat `path` as an allowlisted filename.

### L-2 — Dead/incorrect workflow config
**Severity: Low (informational) · Status: FIXED (2026-08-05) — the invalid `queue:` key was removed from `caller.yml`**

`caller.yml` set `concurrency.queue: max`, which is **not a valid GitHub Actions
concurrency key** (only `group` and `cancel-in-progress` exist) and was silently
ignored.

### L-3 — `xmllint` runs without `--nonet`
**Severity: Low · Status: FIXED (2026-08-05) — `--nonet` added in `scripts/mei-validate.ts`**

The machine-check pipes untrusted MEI to `xmllint --relaxng`. Content is passed on
stdin (not shell-interpolated) and default `xmllint` does not substitute external
entities; `--nonet` closes the remaining network/entity side-channel.

### L-4 — The "never check out the fork" invariant is convention-only
**Severity: Low (process) · Status: hardening**

The safety of `pull_request_target` here depends entirely on the caller not checking
out or running fork content. That invariant lives only in YAML comments. One future
edit (e.g. adding `ref: github.event.pull_request.head.sha` to a checkout, or running
a fork script) turns this into RCE-with-write-token. *Fix:* a CI lint / test asserting
the caller never references `head.sha`/`head.ref` in a checkout or run step, plus a
prominent guard comment.

### L-5 — Campaign owners can rewrite the task plan via the console
**Severity: Low (owner-level) · Status: by design, validated**

The console's plan editor lets a campaign owner rewrite `tracking/task.csv`
(the `savePlan` command). The validation in `src/lib/campaign-plan.ts`
(`checkPlan`) restricts edits to untouched tasks: any task with a claim, an
encoding or a validation verdict must be carried over verbatim (it cannot be
removed or rewired), dependencies must stay within the plan and acyclic, and
the state rows accompanying a plan are generated by the same code.

*Residual risk:* this is owner-level power, not a volunteer-level exposure —
the owner already has push access to their own campaign repo and could edit the
CSV directly. The validation protects volunteers' in-flight work from being
orphaned by a plan edit; it does not (and cannot) protect the tables from the
owner.

---

## Suggested order of work

1. **M-1** (sanitise the Verovio `{@html}` sink) — cheap, closes the one live XSS
   sink, and blunts what remains of the H-3 blast radius.
2. **M-4** (Origin/Referer check on the proxy) — a few lines of defense-in-depth.
3. **L-2 / L-3 / L-1 / L-4** — small workflow-hygiene fixes; L-2 also feeds M-2.
4. **M-2 / M-3** (claim caps, cheap early rejects) — needed before any adversarial
   public exposure.
5. **H-2** (allowlist enforcement / instigator approval) — for campaigns that need
   integrity; the mechanism is designed, not built.
6. **H-1** (pin central ref) — already planned. **H-3** is mitigated: the scope is
   narrowed to `public_repo notifications`, no auth migration is pending, and
   `public_repo` is the narrowest classic scope that permits the fork/create flow
   (see H-3); what remains of it is addressed through M-1.
7. **M-5** (IIIF relay) and **L-5** (plan editor) — accepted with their in-code
   mitigations; revisit only if the residual risks listed there change.
