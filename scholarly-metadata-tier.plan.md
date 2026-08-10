# Scholarly metadata tier — implementation plan

A third view of the metadata editor for musicologists preparing electronic
editions. Planned 2026-08-10; decisions marked **locked** are settled and not
up for redesign. Field-to-tier placement follows Jaklin's meiHead tier notes
(2026-08-10) and the approved Detailed-vs-scholarly split of their "advanced"
pool — recorded in the project memory as `metadata-tier-notes`; tier moves
are Jaklin's call.

**The approved split, as a rule of thumb:** Detailed = transcribing what is
visible on the physical object; Scholarly = editorial method, the abstract
work, and the digital edition itself. Consequences beyond the original plan:

- The scholarly tier must let the **file's own** edition be filled (the
  version of the digital edition), with the file-vs-source distinction
  visible in the UI; the *source's* edition stays a manifestation field on
  Detailed.
- Scholarly additionally gets: dedicated role fields with dropdowns
  (arranger, author, librettist, funder, sponsor — merMEId's "+ add"
  pattern), a series statement, file-publication extras (distributor,
  address, availability beyond the licence, a file-level identifier), and
  the source's condition (which **moves off Detailed**).
- Explicitly XML-editing-only, never form fields: classDecls, domainsDecl,
  samplingDecl, tagsDecl.
- Automatic, never form-fed: appInfo, revisionDesc, the contributor
  persNames provenance writes.

**Locked decisions**

- The scholarly tier groups fields by the actual MEI header structure — the
  file, the source, the work, encoding practice — each group with a one-line
  plain-language explanation.
- XML editing is reachable **only** from inside the scholarly tier, presented
  as a clearly de-emphasised last resort. The Short/Detailed views lose their
  XML tab.
- MEI element names are never shown in the scholarly UI — not in labels, not
  as secondary text, not in hints or placeholders. Plain language only.
  (Element names inside the last-resort XML editor's *content* are the XML
  itself, not UI copy.)
- The scholarly tier is never required to finish the wizard. No field in it
  gates Next/Finish.
- UI copy stays literal and factual.

**Constraints carried over from the existing design**

- The form remains the source of truth; building is total, parsing is
  best-effort with verbatim preservation of what the form does not model
  (`source-metadata.ts` header comment).
- Every new emission must round-trip through `parseSourceHead` and validate
  against the pinned `mei-CMN.rng` (`src/lib/__tests__/mei-schema.test.ts`).
  Element order comes from the schema's content models, not the guidelines
  prose.
- Header content comes only from the metadata forms plus the campaign licence
  — no campaign copy in the score.
- Pure regex/string handling in `source-metadata.ts`, as today.

## Schema facts the plan is built on

Checked against the pinned `mei-CMN.rng` (sha `fa2081…`), not the guidelines:

- `<meiHead>` children are a fixed sequence: `altId*`, `fileDesc`,
  `encodingDesc?`, `workList?`, `manifestationList*`, `extMeta*`,
  `revisionDesc?`.
- `<workList>` is `head*, work+`. `<work>` is an **ordered** sequence (not an
  interleave): head\*, identifier\*, **title+** (at least one is required),
  respStmt-like\*, workIdent\* (`key | mensuration | meter | incip | tempo`),
  otherChar\*, creation?, history?, langUsage?, perfMedium?, perfDuration?,
  audience?, contents?, context?, biblList?, notesStmt?, classification?,
  expressionList?, componentList?, relationList?, extMeta?.
- `<key>` and `<meter>` are empty elements: key carries `@pname`, `@accid`,
  `@mode` (att.keyMode/att.pitch/att.accidental); meter carries `@count`,
  `@unit`, `@sym`.
- `<perfMedium>` holds `head*, (castList | perfResList)?, annot*`;
  `<perfResList>` holds `<perfRes>` items (text content).
- `<classification>` holds `head*, termList?`; `<termList>` holds
  `label|term`, `<term>` is text.
- `<encodingDesc>` children are a fixed sequence: `head*`, `appInfo?`,
  `editorialDecl?`, `projectDesc?`, `samplingDecl?`, `domainsDecl?`,
  `tagsDecl?`, `classDecls?`. So `appInfo` — which the provenance code owns
  (`mei-provenance.ts`, `buildPieceHead`) — sits **before** the two elements
  the form will start emitting.
- `<editorialDecl>` and `<projectDesc>` take `<p>` paragraphs.
- `<fileDesc>` is a fixed sequence: `titleStmt`, `editionStmt?`, `extent?`,
  `pubStmt`, `seriesStmt?`, `notesStmt?`, `sourceDesc?`.
- `<pubStmt>` is `head*, (unpub | pubStmtPart*)` where pubStmtPart is a free
  (unordered) choice of `availability`, address, date, identifier,
  `distributor`, publisher, pubPlace, respStmt — no ordering constraint to
  manage there.
- `<editionStmt>` takes `<edition>` (+ optional respStmt); `<seriesStmt>`
  takes `title+`, respStmt-likes, identifiers, `biblScope`.
- titleStmt's respStmt-like slot admits both `<respStmt>` and the dedicated
  elements (`arranger`, `author`, `editor`, `funder`, `librettist`,
  `lyricist`, `sponsor`, …), so the existing `persName@role`-inside-respStmt
  emission stays valid for every dropdown role.

## 1. Extended data model (`source-metadata.ts`)

New fields on `SourceMetadata`, all empty by default in
`emptySourceMetadata()`:

```ts
/** The file: the digital edition itself, distinct from the source. */
fileEdition: string;      // version of the digital edition → fileDesc editionStmt
seriesTitle: string;      // series the file belongs to → seriesStmt <title>
seriesNumber: string;     // place in the series → seriesStmt <biblScope>
distributor: string;      // → fileDesc pubStmt <distributor>
pubAddress: string;       // → fileDesc pubStmt <address>
fileIdentifier: string;   // → fileDesc pubStmt <identifier>
fileAvailability: string; // access/reuse statement beyond the licence → <availability>

/** The work: high-level musical identity, independent of the source copy. */
keyNote: string;        // 'C', 'C♯', 'E♭', … mapped to @pname/@accid on build
keyMode: string;        // 'major' | 'minor' | church modes (att.keyMode values)
meterCount: string;     // free text digits, e.g. '3'
meterUnit: string;      // e.g. '4'
performanceMedium: string[];   // one entry per instrument/voice → <perfRes>
classification: string[];      // one entry per term → <term>

/** Encoding practice. */
editorialNotes: string;        // blank-line-separated paragraphs → editorialDecl <p>s
projectDescription: string;    // paragraphs → projectDesc <p>s

/** Preservation (see §3). */
encodingExtraXml: string;  // children of <encodingDesc> the form does not model (appInfo, samplingDecl, …)
workExtraXml: string;      // unmodelled children of the first <work>
extraWorksXml: string;     // second and later <work> elements, verbatim
```

Notes:

- The work's required `<title>` reuses the existing `title` field — no
  separate work-title field. A musicologist needing a distinct uniform title
  uses the last-resort XML editor. (Revisit only if this proves to be a
  frequent need.)
- Dedicated roles (arranger, author, librettist, funder, sponsor) reuse the
  existing `contributors` array — the scholarly UI adds them through a role
  **dropdown** (plus a free-text choice) instead of the free-role input, but
  the stored shape and the `respStmt`/`persName@role` emission stay one
  mechanism. Emitting the schema's dedicated elements (`<arranger>`, …)
  instead is a possible later refinement; it would complicate parse for no
  round-trip gain now.
- `keyNote`/`keyMode` are stored as the UI-level strings; a small mapping
  table converts note ↔ (`@pname`, `@accid`) at build/parse time
  (`E♭` → `pname="e" accid="f"`). An unparseable note value builds to no
  `<key>` at all rather than an invalid attribute.
- `copyMetadata` in `pieces.ts` deep-copies `contributors`; it must also
  copy the two new array fields (`performanceMedium`, `classification`).
- `applyDraft` in `wizard.svelte.ts` already back-fills new fields via
  `{ ...emptySourceMetadata(), ...entries.source }`; no draft migration
  needed beyond that.

## 2. Emission

### `buildSourceHead`

New blocks, in `<meiHead>`'s fixed child order:

```
fileDesc            titleStmt (as today),
                    editionStmt from fileEdition,
                    pubStmt gains distributor / address / identifier /
                      availability from the new file fields,
                    seriesStmt from seriesTitle (+ biblScope from seriesNumber),
                    sourceDesc (as today)
encodingDesc        appInfo etc. from encodingExtraXml (rank-spliced, §3),
                    then editorialDecl / projectDesc from the fields
workList            head from nothing; first <work> from the fields
                    (+ workExtraXml rank-spliced, then extraWorksXml)
manifestationList   (as today)
extMeta/revisionDesc and unknowns   (from extraHeadXml, as today)
```

- `<encodingDesc>` is emitted only when it would have content (a field set or
  `encodingExtraXml` non-empty). Same for `<workList>`.
- Inside the emitted `<work>`: `<title>` (always, from `title`, empty element
  when blank), then `<key>`/`<meter>` when set, then preserved children and
  `perfMedium`/`classification` in the schema's sequence (see §3 for how
  preserved children find their slot).
- Empty fields emit nothing, as today.

### `buildPieceHead`

Piece headers are the ones that ship, so the same blocks must reach them:

- Signature change: the piece's own `SourceMetadata` is passed in (it already
  exists as `piece.meta`; today only title/composer are plucked from it in
  `CampaignPiecesStep`). Work and encoding-practice fields come from the
  piece's meta, **falling back to the source's** field-by-field, the same way
  composer already falls back. Rationale: each piece is a work; a
  single-piece campaign fills the source form once and the piece inherits it
  via the existing fallback (and the "Copy from the source" button).
- The existing hard-coded `<encodingDesc><appInfo>…` block gains
  `editorialDecl`/`projectDesc` after `appInfo` (schema order).
- `<workList>` slots between `</encodingDesc>` and the manifestation.
- The piece's `pubStmt` already carries the licence as `<availability>` /
  `<useRestrict>`; `fileAvailability` adds a second `<useRestrict>` inside
  the same `<availability>`, after the licence's. The other file-publication
  fields (`fileEdition`, series, distributor, address, identifier) join the
  piece's fileDesc the same way as the source head's — they describe the
  digital edition, so they apply to both.

## 3. Preservation and the ownership boundary

The module's boundary widens: it now owns `<fileDesc>`,
`<manifestationList>`, **`<encodingDesc>`**, and **`<workList>`**. But unlike
the first two, blind non-preservation inside the new two is not acceptable:

- `<appInfo>` inside `encodingDesc` is written by `buildPieceHead` and
  appended to by the coordinator's `recordContribution`. Losing it on a form
  round-trip would erase provenance.
- The scholarly tier's XML editor is exactly where a musicologist adds work
  markup the form lacks (`<history>`, `<creation>`, `<langUsage>`, a second
  `<work>`); the component promises "markup it doesn't model is kept as
  written".

Mechanism — **rank splice**: a helper that, given preserved child fragments
and the modelled emissions, orders them by a rank table derived from the
parent's content-model sequence (element name → position). Both
`encodingDesc` (8 slots) and `work` (~20 slots) have fully ordered models in
which every child is distinguishable by name, so a simple
name→rank map re-emits a valid sequence. Unknown element names sort last
within their parent (best effort — the well-formedness chip and the schema
tests are the safety net, and hand-written invalid order was already possible
in the XML view today).

Parse changes in `parseSourceHead`:

1. Extract `<encodingDesc>`: read `editorialDecl`/`projectDesc` `<p>`s into
   the two text fields; every other child (notably `appInfo`) goes verbatim
   into `encodingExtraXml`.
2. Extract `<workList>`: first `<work>` → modelled fields (title is *not*
   read back into `meta.title` — fileDesc's title stays the source of that
   field); unmodelled children of that work → `workExtraXml`; remaining
   `<work>` siblings → `extraWorksXml`.
3. Read the new fileDesc fields: `editionStmt` → `fileEdition`, `seriesStmt`
   → series fields, and the file `pubStmt`'s distributor / address /
   identifier / availability. Care at one legacy fallback: parse currently
   reads publisher/pubPlace/date from the *file's* pubStmt when no
   manifestation exists (old headers). That fallback must keep looking only
   for those three source fields, while the new file-level reads target
   `distributor`/`address`/`identifier`/`useRestrict` — distinct element
   names, so the two reads do not collide, but a test pins it.
4. `extraHeadXml` keeps its role for the rest, but `workList` and
   `encodingDesc` are now stripped out of it. `splitAtManifestationSlot`
   stays for `extMeta`/`revisionDesc`.

**Migration of existing headers:** none needed as data migration — test
campaign repos are disposable (pre-production). Old headers whose `workList`
sat verbatim in `extraHeadXml` (e.g. saved drafts, headers written through
the old XML view) migrate implicitly: the next parse routes the workList into
the new fields + preservation slots, and the next build emits an equivalent,
still-valid header. A round-trip test pins this (§6, phase 1).

**Known edge (pre-existing, not new):** a preserved `<altId>` would be
re-emitted after `fileDesc`, which the schema rejects — true of today's code
as well. The rank-splice helper can fix this for `meiHead`'s own children
cheaply; do it in passing, but it is not a goal of this work.

## 4. Reworked view switcher and the last-resort XML editor

### `MetadataForm.svelte`

- `View` becomes `"short" | "long" | "scholarly"` — `"xml"` is no longer a
  view. Pills read **Short / Detailed / Scholarly** (keeping the existing
  first two labels).
- New bindable prop `xmlOpen: boolean` (default false), meaningful only while
  `view === "scholarly"`. Switching away from scholarly closes it (parsing
  the XML back first, as leaving the XML view does today).
- Opening the editor generates the XML from the fields (`buildSourceHead`);
  closing it (or switching view / leaving the step) parses it back —
  unchanged round-trip semantics, relocated.
- Placement inside the scholarly view: after the four groups, visually
  de-emphasised — small text-button styling, not a pill in the switcher row:

  > **Everything else**
  > If the header needs something these fields don't cover, you can edit it
  > directly as XML. Changes to fields the form knows are read back into the
  > form; the rest is kept as you wrote it.
  > [Edit the header as XML]

- The `keptAsWritten` read-back panel keeps working; with `workList` and
  `encodingDesc` now modelled it will report genuinely foreign markup only.

### `CampaignSourceStep.svelte`

- `view` state drops `"xml"`; add `xmlOpen` bound to the form.
- `editing` becomes `xmlOpen && !showPages`; the material-pane handover,
  well-formedness chip, wrap toggle and "Show the pages" swap all key off
  that instead of `view === "xml"`.
- `leave()` parses back when `xmlOpen`.
- `WizardCard`'s `status` string: `xmlOpen ? "editing the XML" : "describing
  the source"` (unchanged copy, new condition).

### `CampaignPiecesStep.svelte`

- Uses `MetadataForm` without `externalEditor`; the inline `XmlEditor`
  renders inside the scholarly view's last-resort area. No other changes
  beyond passing the piece's full meta into `buildPieceHead` (§2).

## 5. Scholarly form UI structure

One column of four titled groups (reusing the existing `fieldset`/`legend`
styling), each opening with its one-line explanation as muted text. All
labels plain-language; no MEI element names anywhere.

**The file** — *"The digital score itself — not the printed copy: what it is
called, who is responsible for it, and how this edition is published."* The
file-vs-source distinction must be visible here, since the group carries an
edition field of its own next to the source's on Detailed.

| Field | Backing | Notes |
|---|---|---|
| Title | `title` | shared with Short/Detailed |
| Composer | `composer` | shared |
| Contributors | `contributors` | name rows with a **role dropdown** (arranger, author, librettist, funder, sponsor, editor, …, plus a free-text role) — merMEId's "+ add another" pattern |
| Version of this digital edition | `fileEdition` | labelled to contrast with the source's edition |
| Series / Number in the series | `seriesTitle`, `seriesNumber` | |
| Distributor | `distributor` | |
| Contact address | `pubAddress` | |
| Identifier | `fileIdentifier` | e.g. a DOI or catalogue number for the file |
| Access and reuse | `fileAvailability` | free text beyond the campaign licence; the licence itself stays automatic |

**The source** — *"The physical copy the music is taken from, and where that
copy is kept."*

| Field | Backing | Notes |
|---|---|---|
| Publisher / Place of publication / Year | `publisher`, `pubPlace`, `date` | |
| Edition | `edition` | the source's own, labelled to contrast with the file's |
| Extent | `extent` | |
| Condition | `condition` | **moves here from Detailed** per the approved split (Detailed keeps: extent, source edition + year, holding institution, shelfmark, note) |
| Holding institution / Shelfmark | `repository`, `shelfmark` | |
| Note about the source | `note` | |

**The work** — *"The composition itself, independent of any particular
printed copy."*

| Field | Backing | Control |
|---|---|---|
| Key | `keyNote` + `keyMode` | two selects: note (C…B with sharps/flats, blank option) and mode (blank, major, minor, church modes) |
| Metre | `meterCount` + `meterUnit` | two short numeric inputs, shown as `count / unit` |
| Performance medium | `performanceMedium` | repeatable rows ("Add an instrument or voice"), like contributors |
| Classification | `classification` | repeatable rows ("Add a term"), placeholder e.g. "sonata" |

**Encoding practice** — *"How the printed music is turned into this digital
score: the rules followed and the project behind it."*

| Field | Backing | Control |
|---|---|---|
| Editorial decisions | `editorialNotes` | textarea; hint: "How ambiguities, obvious errors and additions in the source are handled." |
| About the project | `projectDescription` | textarea; hint: "Why and by whom the music is being encoded." |

Then the de-emphasised last-resort XML area (§4).

Nothing in the group is required; the wizard's Next/Finish logic is untouched
(**locked**: the tier can be ignored entirely).

## 6. Phased implementation order

Each phase lands green on `npm test` and `npm run check` (plus
`check:scripts` where the coordinator is touched — it isn't, but
`mei-provenance` is shared, so run it in phase 2).

**Phase 1 — model and source builder/parser** (`source-metadata.ts`,
`pieces.ts` `copyMetadata`)

New fields; rank-splice helper; `buildSourceHead` emits the extended
fileDesc (editionStmt, pubStmt extras, seriesStmt) plus
encodingDesc/workList; `parseSourceHead` extracts them and fills the three
preservation fields.

Tests (`source-metadata.test.ts`): build/parse round-trip for every new
field; key-note mapping both ways incl. accidentals and the unparseable-note
case; paragraph splitting; preserved `appInfo` survives a round-trip
unchanged; unmodelled work children (`creation`, `history`) come back in
schema order next to modelled ones; a second `<work>` survives verbatim; an
old-style header with `workList` in `extraHeadXml` re-emits equivalently
(migration pin); the legacy fileDesc-pubStmt fallback still reads source
publisher/place/date while the new file-level pubStmt fields are read
separately.

Tests (`mei-schema.test.ts`): a fully-populated scholarly source header
validates at both stages (including editionStmt/seriesStmt/pubStmt extras in
fileDesc's fixed order); work-fields-only; encoding-fields-only; preserved
markup on both sides plus modelled workList together.

**Phase 2 — piece headers** (`source-metadata.ts` `buildPieceHead`,
`CampaignPiecesStep.svelte` call site)

Signature takes the piece's meta; per-field fallback to the source;
editorialDecl/projectDesc after the appInfo block; workList before the
manifestation.

Tests: piece-head string assertions for fallback behaviour;
`mei-schema.test.ts` piece-head-with-scholarly-fields validates;
`mei-provenance.test.ts` case: `recordContribution` on a header that already
has `editorialDecl` still lands its `application` inside the existing
`appInfo` and validates.

**Phase 3 — form and wizard UI** (`MetadataForm.svelte`,
`CampaignSourceStep.svelte`)

View type change, scholarly view with the four groups, `xmlOpen` sub-state,
XML pill removed, source step rewired. Two tier moves in the existing views
land here too: Condition leaves the Detailed view (it stays a field, shown
in scholarly's source group), and Place of publication joins the Short view
(the tier notes record this move as done, but the current Short view does
not show it — verify and do it here).

Verification is by preview (component tests don't exist in this repo):
switch through all three views on both steps; open/close the XML editor from
scholarly and confirm field read-back and `keptAsWritten`; material-pane
handover and "Show the pages" on the source step; leave the step with the
editor open and come back; confirm Short/Detailed have no XML access left;
sweep the scholarly view for any MEI element name in visible copy;
`svelte-check` clean.

**Phase 4 — drafts and copy plumbing**

`wizard-draft.test.ts`: a pre-scholarly draft loads with the new fields
back-filled; a draft saved with scholarly fields round-trips.
`pieces.test.ts` (or inline): `copyMetadata` deep-copies the new arrays —
mutating the copy's `performanceMedium` must not touch the original.
"Copy from the source" / "Copy from previous piece" carry the new fields (they
do automatically via `copyMetadata`; the test pins it).

## Open questions (from the tier notes — need an explicit call, none block
the phases above)

- The notes suggest the notes statement "can contain the description
  provided in the beginning" (the campaign description). That conflicts with
  the locked rule that campaign copy stays out of the score
  (`mei-fed-by-metadata-forms`). Until decided, nothing campaign-level is
  emitted.
- The series statement could arguably live on Detailed instead of scholarly.
  Planned for scholarly; moving it later is a one-line UI change.
- An "unpublished manuscript" checkbox on Detailed (emitting `<unpub>` in
  the manifestation's pubStmt) may be worth adding when scholarly lands —
  noted, not planned.
- Open automatic-tier ideas from the notes, not part of this work: `altId`
  as an internal identifier, `extMeta` for IMSLP imports (better parsed into
  fields than copied).

## Out of scope

- A separate work-title field (reuses `title`; XML editor covers uniform
  titles).
- `@sym`-style metre symbols (common/cut time) as form fields.
- `<creation>`, `<history>`, `<langUsage>`, incipits, "further physical
  description" beyond extent/condition (dimensions etc.) — reachable via the
  last-resort editor, preserved by the rank splice, not modelled.
- classDecls, domainsDecl, samplingDecl, tagsDecl — per the tier notes these
  are XML-editing-only, never form fields.
- Any coordinator change: `recordContribution` needs no modification (phase 2
  only adds a test proving that).
- Wizard step flow, config.yaml shape, and per-piece task planning.
