# Handoff: Campaign Setup Wizard Redesign ("Workbench" shell + dark mode)

## Overview
Redesign of the 6-step campaign setup wizard for the Let's Encode music-encoding platform. The wizard becomes a fixed three-zone **workbench**: step rail left, material (pages/dropzone/XML) centre, work card right — so the primary action (Continue/Finish) always sits bottom-right. Includes a full dark-mode palette.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code**. The task is to recreate these designs in the existing SvelteKit codebase (`src/lib/components/Campaign*Step.svelte`, `MetadataForm.svelte`, `ProgressSteps.svelte`, `wizard.svelte.ts`) using its established patterns. Do not ship the HTML.

Open `Wizard Redesign.dc.html` in a browser. It contains several exploration rounds; **only sections `#4a` (light, locked) and `#5a` (dark) are canonical.** Everything below them (`#3a`–`#1c`) is superseded exploration — ignore it.

## Fidelity
**High-fidelity.** Colors, spacing, typography and copy are final. Recreate pixel-perfectly, adapted to the app's real data.

## Shell (all six steps)
Canvas designed at 1600×950; the shell is fluid: rail and work card fixed-width, material pane flexes.

- **App bar** — 56px tall, `rgba(255,255,255,.9)` over the page gradient, bottom border `#e6e8f0`. Left: logo (`static/logo.svg`, height 30px). Right (flex, gap 14px): user chip (26px round avatar `#2563c9`, white initial, 13.5px name), "Log out" button (14px, padding 6px 13px, bg `#f7f8fb`, border `#e6e8f0`, radius 6px), theme toggle (36px circle, border `#e6e8f0`).
- **Page background** — base `#f7f8fb` with three soft radial tints (brand tri-colour): `radial-gradient(60% 90% at 15% 0%, rgba(109,195,255,.12), transparent 60%)`, `radial-gradient(60% 90% at 85% 10%, rgba(118,222,118,.12), transparent 60%)`, `radial-gradient(50% 80% at 50% 100%, rgba(255,167,109,.10), transparent 60%)`.
- **Step rail** (left, 248px, padding 24px 20px 18px) — replaces the horizontal ProgressSteps. Header: "CAMPAIGN SETUP" (12px/600, uppercase, letter-spacing .04em, `#79809a`) then campaign name 15px/600 with `· owner/slug` in 12px monospace `#79809a`. **No three-dot / kebab cluster.** Six steps as a vertical chain: 26px circles joined by 1px×18px connectors (`#e6e8f0`).
  - Done: circle bg `#e8f7ec`, border `#b6e2c1`, ✓ `#1a7f4b`; label 13.5px/600 `#4a5167` + one-line summary 11.5px `#79809a` (e.g. "test7 · This is the title", "CC BY 4.0", "1 PDF · 34 pages", "33 kept", "Fledermaus · Spina, 1874").
  - Active: circle solid `#2563c9`, white number, halo `0 0 0 4px rgba(37,99,201,.15)`; label 13.5px/700 `#1f2433`; status line 11.5px/600 `#2563c9` (e.g. "describing the source", "editing the XML", "2 pieces · all pages covered").
  - Upcoming: white circle, border `#d0d0d0`, number `#79809a`; label 600 `#79809a`, no summary.
  - Rail footer (pushed to bottom): autosave line "● Draft saved · just now" (11.5px `#79809a`, 6px dot `#76de76`) and an underlined text button "Discard this setup" (12px `#79809a`, hover `#b42318`).
- **Material pane** (centre, flexes; margin 24px 0 24px 12px) — white card, border `#e6e8f0`, radius 14px, shadow `0 1px 2px rgba(31,36,51,.06), 0 8px 28px rgba(31,36,51,.07)`. Has a 48px toolbar (border-bottom `#e6e8f0`) and a body on `#f7f8fb`. Steps 1–2 have no material: show a dashed placeholder instead (border `1.5px dashed #d8dce8`, radius 14px, bg `rgba(255,255,255,.5)`, centred ♪ + "No material yet" 14px/600 `#79809a` + step-specific hint 12.5px `#9aa0b5`).
- **Work card** (right, 472px incl. 24px outer padding) — same card styling as the material pane; padding 26px 28px. Title `h1` 21px/1.25, intro 13.5px `#4a5167`. Footer pinned to the bottom via flex spacer: top border `#e6e8f0`, buttons right-aligned, gap 10px. "Back" — 14px/600, padding 10px 22px, bg `#f7f8fb`, border `#e6e8f0`, radius 999px. "Continue →" — white on `#2563c9`, padding 10px 26px, radius 999px, shadow `0 1px 3px rgba(37,99,201,.35)`, hover `#1b49a0`. Step 6 uses "Finish ✓" in green `#1a7f4b`, hover `#146239`.

## Screens / Views

### Step 1 · Name (`CampaignNameStep.svelte`)
Work card "Name your campaign": Campaign name input (helper "Used in the URL and as the Git repository name.", availability line "✓ Available" 11.5px/600 `#1a7f4b`), Title input (helper "The campaign's readable label, shown wherever it is listed."), optional "About this campaign" textarea (helper "Optional — volunteers see it when they open the campaign."). Inputs: 14px, padding 9px 12px, border `#d0d5e2`, radius 8px; labels 13px/600. No Back button on step 1. Material pane: placeholder ("Your pages will appear here once you add a source at step 3.").

### Step 2 · Licence (`CampaignLicenseStep.svelte`)
Work card "Choose a licence": select-style control (CC BY 4.0 — Attribution), plain-language summary in a `#f7f8fb` radius-8 box, link "Read the full CC-BY-4.0 licence". Material placeholder: "The licence comes first — it governs what volunteers agree to when they contribute."

### Step 3 · Upload (`CampaignUploadStep.svelte`)
**The dropzone lives in the material pane**, not the card: full-pane dashed zone (border `2px dashed #9db9e8`, bg `rgba(234,244,255,.55)`), ⤓ icon `#2563c9`, "Drop page images, PDFs or MEI encodings here", "You can combine them — or continue without any.", "Browse files" pill (white, border `#bcd4f3`, text `#2563c9`). Queued files appear as rows under the dropzone (PDF chip 34×42, filename in 12.5px mono, size + "read on Continue", × remove). Work card "Add your source": IIIF manifest URL input (helper about canvases being committed), rights checkbox ("I have the right to publish this material under the campaign's licence."), status box ("1 file ready — pages are read when you continue").

### Step 4 · Pages (`CampaignPagesStep.svelte`)
Material toolbar: filename (12px mono, truncated) · spacer · "N per row" stepper · zoom % stepper · divider · "Keep all" / "Keep none" buttons. Grid of page thumbnails (aspect-ratio 0.73, white, border `#cfe0f6` when kept / `#e6e8f0` grey + diagonal-stripe overlay + "left out" pill when excluded; order badge top-left, 20px round, `#2563c9` white when kept, `#e6e8f0` grey when not; caption "p. N" 10.5px mono). Work card "Choose the pages": big count "33 <small>of 34 pages kept</small>" (34px/700 tabular), 6px progress bar (track `#eef2f8`, fill `linear-gradient(90deg,#6dc3ff,#76de76)`), three interaction hints (click to toggle, shift-click for a run, drag to reorder), link "More about page order and spreads", live status box (✓ Rendered 34 pages · 4.1s / … Committing 33 images — 14 of 33 · 16.0s).

### Step 5 · Source (`CampaignSourceStep.svelte` + `MetadataForm.svelte`)
Pages stay visible in the material pane (read-only: toolbar "33 pages · committed" + green chip "Pages are set — for reference"; page badges greyed). Work card "Describe the source" / "What the pages were taken from. Every piece inherits this." with a **three-view switcher** — Short · Detailed · XML pill group (active: white on `#2563c9`; inactive: white bg, border `#e6e8f0`, hover blue) — three views over ONE value:
- **Short (default):** Title, Composer, Publisher + Year (Year fixed 110px) inputs; hint "Publisher and year usually sit on the title page — it's the first page on the left."
- **Detailed:** adds Place of publication, Extent, Condition, Note, and a repeatable Contributors list (name + role, Remove/Add contributor).
- **XML:** **the editor takes over the material pane** (pages step aside). Rail status becomes "editing the XML".
  - Editor pane toolbar: "meiHead — source header" (11.5px mono), validation chip "● Well-formed · valid against mei-CMN" (green chip as above), spacer, "Wrap lines" and "Show the pages" buttons.
  - Editor body: bg `#fdfdfe`, 12.5px/1.85 monospace, 44px right-aligned line-number gutter (`#c3c9d9`; active-selection lines highlighted bg `#eaf4ff`, numbers `#79809a`). Syntax colours: tags `#2563c9`, attribute names `#e07b39`, attribute values/strings `#1a7f4b`, comments `#79809a`, text `#1f2433`.
  - Work card in XML mode keeps a **live read-back panel**: "The editor is using the material pane while you write. Fields the form knows are read back when you switch views; markup it doesn't model is kept as written." + bordered table "READ FROM THE XML" (rows Title / Composer / Publisher / Year / "Kept as written — 1 identifier, 1 comment"; rows 12.5px, label `#79809a`, value `#1f2433`, row borders `#f0f1f5`). Round-trip rule: unmodeled markup is preserved verbatim.

### Step 6 · Pieces (`CampaignPiecesStep.svelte`)
Material pane = region editor: toolbar hint "Drag on a page to give a region to **Ouverture**" (piece name in its colour) + per-row/zoom steppers; page grid with translucent piece regions (fill `rgba(255,167,109,.25)` / border `2px solid #e07b39` for piece 1; `rgba(109,195,255,.25)` / `#2563c9` for piece 2; radius 4px; piece-name badge pill on first/last page of its run). Work card "Mark the pieces":
- Header row: "PIECES · 2" (11px uppercase) + "+ Add piece" pill.
- Piece list: selected piece expands — `1.5px solid #e07b39` border, bg `#fff7f0`, 13px colour swatch, name 13.5px/600, "pages 1–5" — and carries **bulk page actions inside its body**: three pills "Assign all pages" / "Unassign all" / "Clear regions" (11.5px, border `#e8d5c4`, hover `#e07b39`; Clear regions hovers red `#b42318`). Actions are always scoped to the selected piece. Unselected pieces: plain row, border `#e6e8f0`, hover border blue, × delete on hover.
- Metadata block: "Metadata for **Ouverture**" + the same Short · Detailed · XML pill switcher (piece metadata reuses `MetadataForm`); Title + Composer inputs; helper pills "Copy from the source" and "Copy from previous piece"; footnote "**Ouverture** covers pages 1–5. Adjust its regions in the pane on the left."
- Footer: Back + green "Finish ✓".

## Interactions & Behavior
- Rail steps are links: completed steps navigate back; upcoming steps disabled.
- Autosave: persist draft on change (existing `wizard-draft.ts`); update "Draft saved · just now" line. "Discard this setup" prompts for confirmation, then deletes the draft.
- View switcher: Short/Detailed/XML edit one underlying meiHead value. Switching from XML re-parses and reads known fields back into the form; unknown markup is never dropped. Entering XML mode swaps the material pane to the editor (pages hidden, "Show the pages" toggles back); leaving XML restores the pages.
- XML validation chip states: green "Well-formed · valid against mei-CMN"; on error switch chip to red with message and line highlight (design shows the valid state).
- Pieces: selecting a piece expands its row (accordion) and re-scopes drag-to-region + bulk actions to it. "Assign all pages" gives the piece a full-page region on every kept page; "Unassign all" removes its page assignments; "Clear regions" keeps assignments but deletes drawn rectangles (confirm destructive actions).
- Buttons/pills: hover = blue text + blue border (`#2563c9`); primary buttons darken (`#1b49a0` / `#146239`).
- Theme toggle in the app bar switches light/dark; persist preference.

## Dark Mode (section `#5a`)
Systematic palette swap, same layout. **Page scans stay light** (they are paper) — thumbnails become warm paper `#f2f0ea`, staff lines `#bdb8aa`, page-number pills `#e3e0d6`/`#454b5f`. Use `static/logo-dark.svg` in the app bar.

| Token | Light | Dark |
|---|---|---|
| Page base | `#f7f8fb` | `#0f1118` (same radial tints) |
| App bar | `rgba(255,255,255,.9)` | `rgba(20,23,32,.85)` |
| Card / pane bg | `#fff` | `#1c1f2b` |
| Inset bg (grids, editor) | `#f7f8fb` / `#fdfdfe` | `#12141d` |
| Control bg (inputs, pills) | `#fff` / `#f7f8fb` | `#161a26` / `#232736` |
| Border | `#e6e8f0` | `#2a2e3d` |
| Input border | `#d0d5e2` | `#3a4054` |
| Text | `#1f2433` | `#e8eaf2` |
| Secondary text | `#4a5167` | `#b6bccf` |
| Muted text | `#79809a` | `#8f96ad` |
| Blue accent (text/border/tags) | `#2563c9` | `#6ea3f5` |
| Blue button bg | `#2563c9` → `#1b49a0` | `#3b76e0` → `#2f68c4` |
| Green (chips/valid/strings) | `#1a7f4b` on `#e8f7ec`/`#b6e2c1` | `#5fd08a` on `rgba(46,160,92,.15)`/`#2e5c42` |
| Green button bg | `#1a7f4b` → `#146239` | `#22995c` → `#1d7f4d` |
| Orange accent | `#e07b39` | `#f0924f` (solid badge bg stays `#e07b39`) |
| Danger | `#b42318` | `#e5533f` |
| Selected piece bg | `#fff7f0` | `rgba(240,146,79,.12)` |
| XML line highlight | `#eaf4ff` | `rgba(110,163,245,.10)` |
| Card shadow | `rgba(31,36,51,.06/.07)` | `rgba(0,0,0,.5/.45)` |

## Design Tokens (light)
- Font: `"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`; mono `ui-monospace, Menlo, monospace`.
- Type scale: h1 21px/1.25 · body 13.5px · labels 13px/600 · helpers 11.5px · section headers 11–12px/600 uppercase, letter-spacing .04–.05em · big stat 34px/700 tabular.
- Radii: cards/panes 14px · inputs/boxes 8px · toolbar buttons 6–8px · pills/buttons 999px · thumbnails 6px · regions 4px.
- Spacing: pane margins 24px · card padding 26px 28px · toolbar 48px, padding 0 16px · grid gap 14px, padding 16px.
- Brand tri-colour (from logo): blue `#6dc3ff`, green `#76de76`, orange `#ffa76d`; functional blue `#2563c9`, green `#1a7f4b`, orange `#e07b39`.
- Links: `#2f68c4`, hover `#1b49a0`.

## State Management
Extends the existing wizard store (`wizard.svelte.ts` / `wizard-draft.ts`): current step, per-step completion + summary strings for the rail, upload queue, kept/ordered pages, source meiHead (single value; view mode Short/Detailed/XML is UI state), pieces `[{id, name, color, pageRange, regions[], meiHead}]`, selected piece id, autosave timestamp, theme.

## Assets
- `static/logo.svg` (light) and `static/logo-dark.svg` (dark) — both already in the repo.
- Page thumbnails in the mocks are CSS placeholders; production uses real rendered page images.

## Files in this bundle
- `Wizard Redesign.dc.html` — the design document (open in a browser; `support.js` is its runtime). Canonical sections: `#4a` (light) and `#5a` (dark); `#2a` shows all six light steps in full.
- `support.js` — runtime for the HTML file, not part of the design.
- `assets/logo.svg`, `assets/logo-dark.svg` — referenced by the HTML.
