# Changelog

All notable changes to the instigation platform. Commit hashes are given in
parentheses.

## Unreleased

- A campaign's creation time now comes from the repository, so the NEW tag and the newest sort work before any task activity (previously both derived from the first history entry).
- Campaign overview redesign: the grid of tiles is now a list of full-width rows — facsimile spine, title/byline/progress, incipit strip, and the campaign's suggested next task, claimable in place (encoding claims open mei-friend, review claims land on the review; work the viewer holds shows Continue). One search & filter bar (All / Open to claim / Nearly done / Yours, sort select) replaces the sort segments, open-tasks switch and pager; "Show n more" pages the list. Logged out, rows are link-only.
- The score setup, measure correction and review viewers carry the piece's comments panel beside their task controls; the review viewer's old discussion list and composer are gone.
- Score view fits the window: the panes scroll to the page bottom and the comments composer stays visible; the panes area got rounded corners.
- Full-page score view at ?score=<piece> (with optional ?page=), replacing the score dock: the top bar backs out to the campaign, the piece-scoped comments panel sits beside the score, comment anchors turn to their page and highlight the range, and measure selection targets the composer — a comment posted then carries the selected measure as its anchor. Back/forward navigate it; an open task's ?task= survives the round trip, and its panel links to the score at the task's page.
- The score toolbar sits on its own background bar; the side panels run the full row height with pinned composers; the volunteer task column keeps a reading width beside the right-edge comments panel.
- Instigator view: a piece rail scopes the board to one piece (context strip with thumbnail, incipit and progress above the columns); rail rows carry per-category task counts in the column colours; cards carry their piece's colour edge; clicking a card tints it and opens an in-page task panel (status, score link, submission, validation record, one action, discussion) instead of the dock takeover — Escape or ✕ closes it. Volunteers get the same panel in the comments panel's place. The campaign view now fills the window width.
- Board columns list every card; a stats-bar toggle (All tasks / Claimable) filters to open encodings and free review slots instead of the per-column show-more collapse.
- The side panels' resize handle is a visible grip bar.
- Volunteer view rebuilt: campaign title with progress, the next task as a hero card (facsimile thumbnail, context and effort lines, claim + preview actions), three suggested alternatives, and every piece as an expandable row listing its tasks; the comments panel sits beside it and follows the expanded piece. Hero stats, task ids, run states and attention chips left the volunteer screen; claim buttons are disabled logged out.
- Comments side panel component: one piece's discussion, sectioned per task and colour-coded by stage, with measure anchors, a pinned composer, drag-resize and a persisted open state.
- Piece previews module: cached first-page facsimile thumbnail and Verovio incipit (opening system) per piece, for the campaign view redesign.

## 0.24.0 – 2026-09-01

- Banner text on the setup and zones task pages is left-aligned again.
- Posting or resolving a comment shows a spinner at the composer or comment instead of the task's run state.
- Background submissions no longer show the busy overlay popup.

## 0.23.0 – 2026-08-28

- Task-first volunteer view instead of the board (next task, open tasks grouped and tinted per piece, piece progress); the board stays for instigators.
- Task panel: one status pill plus the one available action; claim-to-review moved into the header.
- Board cards are navigation-only; the hero claim button covers reviews too.
- "Needs attention" unfolds its tasks; the column flag is gone.
- The piece tiles' "View score" replaces "Preview the score"; "ready" is now "open".
- Removed "Copy raw link".

## 0.22.2 – 2026-08-28

- The board tints each task an accepted submission (encoding, validation, send-back) of the viewer's just moved, with a "just submitted" badge, for one minute.
- The Done column now lists the five most recently finished tasks as cards, newest first, collapsing only the rest into the summary; done lines show the pass hand instead of a tick.
- Card footers (claim, waits-for, worker, validation dots, completion line) now sit at the card's bottom edge instead of leaving the uniform card height unused.
- Task titles now name the piece (config title, else its id) everywhere — board cards, task panel, review view, ticker, plan editor and dashboard — instead of the score file's basename.
- The Manage button now matches the size of the other hero buttons.
- Restyled the banners to match the app design (wash background, coloured left edge, ink text) and unified their styles and placement across all pages.
- A rate-limited campaign page now reports the failed lookup with a retry instead of claiming the campaign does not exist.
- Redesigned the GitHub-interaction status messages. (`05ca5cb`)
- Added this changelog, reconstructed from the full git history.
- Synced the package version with the changelog.
- Moved the design and spec docs (DESIGN.md, SECURITY-HARDENING.md, mei-friend-connect spec, scholarly-metadata plan, meeting notes) to the private lets-encode-meta repo; the README points there.

## 0.22.1 – 2026-08-27

- Visual restyle: hand-palette design tokens, darker background, more cohesive style across the app. (`c9bc713`)

## 0.22.0 – 2026-08-25

- Added a full-screen review view with side panel and comments. (`7d83cbd`)

## 0.21.0 – 2026-08-24

- Switched to MEI 5.1. (`87797ff`)
- Added a prototype score-definition editor and a score-setup task. (`4710121`)
- Disabled the pass and submit-encoding buttons while a PR completes in the background. (`854a967`)

## 0.20.2 – 2026-08-14

- Bug fixes in task logic. (`d9b82cf`)

## 0.20.1 – 2026-08-13

- Failed PRs now surface as clear errors. (`2ad3603`)
- Fixed comment and fail logic; investigated comments not being shown. (`0181816`, `d8475f7`)
- GitHub Actions speed improvements and non-blocking action-waiting experiments. (`c294c57`, `dac7a58`)
- Added config flags, including one to allow same-repo validation in dev. (`beb2cb3`, `b932def`)
- Generated MEI now includes xml:ids. (`9ab4db9`)
- Fixed bugs in the task chain logic. (`ce0f7e0`)

## 0.20.0 – 2026-08-11

- Improved the measure corrector interface. (`4087211`, `0991c32`)
- Campaign overview now lists open validation tasks. (`123048b`)
- Zoom optimizations; zoom slider also in the preview. (`d7139bb`, `474dbd2`)
- Progress timer improvements: temporary continue button on the timer overlay, no negative numbers. (`4455697`, `b8ff275`)

## 0.19.0 – 2026-08-10

- Integrated the project website (including assets) into the instigation platform. (`aa420d5`)
- Started reworking metadata entry (scholarly tier planned, not implemented); redesigned the pieces metadata form to avoid duplicating the source form. (`955e48b`, `888086a`)
- Improved pages-per-row behaviour. (`3386722`)
- Downgraded to Node 22 to match the server environment. (`d292c2b`)

## 0.18.0 – 2026-08-07

- Refactored the campaign main view: preview and task info as resizable panels. (`8c0f32f`)

## 0.17.1 – 2026-08-06

- Codebase cleanup and view simplification. (`0df44a2`, `fc41e84`)
- Restructured deployment and added configs. (`d818c7a`)
- Fixed claiming and PRs. (`922513d`)
- Fixed Verovio rendering and restored the full-score preview. (`474b2cd`)

## 0.17.0 – 2026-08-05

- Redesigned and implemented the dashboard. (`c77492e`, `8a0938b`)

## 0.16.0 – 2026-08-04

- Wizard UI refactoring; added the physical-only piece kind (no images). (`5c5248d`)

## 0.15.0 – 2026-08-03

- Environment setup for the three instances (prod, stage, test): per-mode config, Apache config, wsgi.py, virtual-host and document-root changes. (`ec2cc51`, `1c07427`, `a6bc7cb`, `e32fcca`, `5c63106`, `cdd90ca`)
- Updated Python dependencies, Vite config, and MEI RNG schema handling. (`cf6fe73`, `2ccd513`, `6cce49d`)
- Moved wizard readme content one level up. (`3aba335`)

## 0.14.0 – 2026-07-31

- Started adding progress info for GitHub Actions. (`9397ea5`)
- Visual redesign of the wizard. (`3fc3888`)

## 0.13.0 – 2026-07-30

- Integrated the redirector into the instigator for easier deployment. (`605f67f`)
- Added an empty gunicorn config file. (`9e6e45b`)

## 0.12.1 – 2026-07-29

- Improved score preview and image selection (moved from bottom panel to side panel). (`0415111`)
- Made measure detection and GitHub Action calls faster; cleaned up facsimile-detection code. (`137cf6d`, `db6dfbf`)

## 0.12.0 – 2026-07-28

- Started the setup wizard (large refactor); fixed a continue-setup bug. (`d951bcb`, `624885a`)
- Updated logo and favicon. (`beb9f92`)
- Fixed image paths for the preview and added an image selector after upload. (`9034232`)

## 0.11.1 – 2026-07-24

- Narrowed OAuth to the public_repo scope, renamed oauth → auth, redirector integration fixes. (`2c924ce`)

## 0.11.0 – 2026-07-22

- Redesigned the measure zone editor. (`fcd923c`)

## 0.10.0 – 2026-07-21

- Refactored to use GitHub numerical ids instead of names for repos and users; integrated the redirector/registry for URLs. (`8f841bf`)
- Renamed buttons and finished the node layout. (`ada7dec`)
- Added provisional undo/redo functionality. (`d7f146c`)

## 0.9.0 – 2026-07-20

- Node UI improvements: movable nodes, per-page task when adding a facsimile, node-stack centering, better zooming. (`6b47b77`, `f90dcee`, `b5ad8c9`, `4a7bda2`)
- Moved unit tests to src/lib/__tests__/ and normalized test imports. (`0a4a295`)
- Comment reformatting and edits. (`eae49d7`)

## 0.8.0 – 2026-07-17

- Info panel now shows data from the MEI header; refined graph status to avoid duplicate info. (`dea7fd9`, `79000ca`)
- Fixed GitHub API rate limiting and applied security hardening. (`ee50a2f`, `4a8e2b3`)
- Another attempt at fixing notification muting. (`b0481ba`)
- Updated the file picker, XML parser, and tests; added package-lock to the repo. (`6498bb3`, `c091ed4`, `dcf580a`, `10e4b89`)
- Return to the campaign page after submitting. (`2cd1561`)
- Removed pinning for now. (`9108e26`)
- Added the GNU AGPL v3 license. (`94acbe5`)

## 0.7.0 – 2026-07-16

- Improved node design: resizable preview and side panel; fixed node width. (`e826a40`, `ba6108a`)
- Fixed GitHub notification problems and a rate-limit error. (`60a36e5`, `a8d1c2e`, `75542b5`)
- Fixed lock/claim symbols, skipped the extra claim step for measure correction, fixed status pills for the pre-task. (`d6e6e6e`, `4d0408d`)

## 0.6.1 – 2026-07-15

- Better error behaviour after measure detection via the API. (`a252617`)

## 0.6.0 – 2026-07-13

- Restructured OAuth to keep the token server-side. (`5c2cff8`)
- Added the zone editor. (`5094644`)

## 0.5.0 – 2026-07-03

- Volunteer and owner branches created on encode claim. (`52d76e8`)
- Console logging and retries for the Claim (encoding) button. (`dc08335`)
- Reworked the campaign page: Verovio preview, handle sluggification, drag-and-drop files, removed the warning. (`c386ecf`)
- Wording fixes in headings; removed the template mention. (`1f57fe2`)
- Disabled caching for GETs to avoid stale responses. (`b779827`)

## 0.4.0 – 2026-07-02

- Switched to a Flask server for OAuth; removed the rest of the backend in favour of generic GitHub Actions workflows. (`7016c6d`, `f10410e`)
- Added fastForwardBranch; moved to four tracking tables. (`c02f5ae`, `f9ef497`)
- Muted notifications on first action (claim). (`cc9bf68`)
- Open mei-friend after the GitHub steps finish. (`a10ca2b`)
- Added PDF/image upload with measure detection. (`49be64d`)
- Fixed the MEI file missing from the task branch. (`842326a`)
- Housekeeping: readme, nginx conf, dotenv, gitignore. (`946e4a0`, `6de45eb`, `d4fa609`, `5190279`)

## 0.3.0 – 2026-07-01

- Campaign homepage URL now leads to the console instead of GitHub. (`8e632e3`)
- Removed Node backend pieces and refactored GitHub Actions functionality. (`84d8c22`)

## 0.2.0 – 2026-06-30

- First draft of the console; switched to TypeScript. (`9f2da37`, `f4215fb`, `bfa04f6`)
- Added a heuristic for handles/repo names. (`f5b33fb`)

## 0.1.0 – 2026-06-24/26

- First draft of GitHub login and repo generation from a template. (`53c3fc1`)
- Experiments with setting up GitHub Actions. (`3b647bd`)
