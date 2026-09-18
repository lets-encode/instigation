<!--
  Wizard step 6: the works within the source. Each piece gets its own metadata
  and, when it is read from the facsimile, the regions of the pages it covers.

  Pieces are seeded from what the upload produced — one per uploaded encoding,
  plus a single facsimile piece for the page images — so a source holding one
  work needs no editing here.

  With page images the preparation step follows and finishes the setup; without
  them there is nothing to prepare, that step is skipped and Finish is here.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { imageSize } from "$lib/prepare-images.ts";
  import {
    copyMetadata,
    coverPages,
    createEncodedPiece,
    createPiece,
    formatRanges,
    initialPieces,
    pagesCovered,
    pieceColour,
  } from "$lib/pieces.ts";
  import { wizard, nextStep, previousStep } from "$lib/wizard.svelte.ts";
  import { CampaignFinisher } from "$lib/campaign-finish.svelte.ts";
  import WizardCard from "./WizardCard.svelte";
  import MetadataForm from "./MetadataForm.svelte";
  import PieceZoneEditor from "./PieceZoneEditor.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";

  let selected = $state(0);
  // With no page images the preparation step is skipped, so this step
  // finishes the setup itself.
  const last = $derived(wizard.images.length === 0);
  const finisher = new CampaignFinisher();
  onDestroy(() => finisher.cancel());
  const busy = $derived(finisher.busy);

  // Seed the pieces the first time the step is opened; returning from a later
  // step must not discard edits.
  if (!wizard.pieces.length) {
    wizard.pieces = initialPieces(
      wizard.encodings.map((encoding) => encoding.name),
      wizard.images.length > 0,
    );
  }

  // The pages the editor draws on: object URLs over the prepared page images,
  // with the pixel size the regions are expressed in. A superseded set is
  // released once its replacement is on screen; the live set on destroy.
  let liveUrls: string[] = [];
  let pages = $state<{ url: string; width: number; height: number }[]>([]);
  $effect(() => {
    let cancelled = false;
    (async () => {
      const urls: string[] = [];
      const built = await Promise.all(
        wizard.images.map(async (image) => {
          const { width, height } = await imageSize(image.blob);
          const url = URL.createObjectURL(image.blob);
          urls.push(url);
          return { url, width, height };
        }),
      );
      if (cancelled) {
        // Superseded before it was ever shown.
        urls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      pages = built;
      liveUrls.forEach((url) => URL.revokeObjectURL(url));
      liveUrls = urls;
    })();
    return () => {
      cancelled = true;
    };
  });
  onDestroy(() => liveUrls.forEach((url) => URL.revokeObjectURL(url)));

  function addPiece() {
    // With no page images there are no regions to mark, so an added piece is
    // transcribed from the physical source instead.
    const kind = wizard.images.length ? "facsimile" : "physical-only";
    wizard.pieces = [...wizard.pieces, createPiece(wizard.pieces, kind)];
    selected = wizard.pieces.length - 1;
  }

  // Uploaded encodings whose piece was removed: they are still held by the
  // wizard, so their pieces can be re-added rather than being lost.
  const unusedEncodings = $derived(
    wizard.encodings.filter(
      (encoding) => !wizard.pieces.some((p) => p.encodingName === encoding.name),
    ),
  );

  function readdEncoding(name: string) {
    wizard.pieces = [...wizard.pieces, createEncodedPiece(wizard.pieces, name)];
    selected = wizard.pieces.length - 1;
  }

  // Removing a piece is confirmed in place: the first press arms the button,
  // the second removes. An encoded piece cannot be re-added without discarding
  // the setup, so an accidental press must not already be a loss.
  let confirmingRemove = $state<string | null>(null);

  function removePiece(index: number) {
    const piece = wizard.pieces[index];
    if (confirmingRemove !== piece.id) {
      confirmingRemove = piece.id;
      return;
    }
    confirmingRemove = null;
    wizard.pieces = wizard.pieces.filter((_, i) => i !== index);
    selected = Math.max(0, Math.min(selected, wizard.pieces.length - 1));
  }

  // Bulk page actions, always scoped to the selected piece.
  let bulkNotice = $state<string | null>(null);
  let confirmingClear = $state(false);

  function assignAllPages() {
    confirmingClear = false;
    const { blocked, blockers } = coverPages(
      wizard.pieces,
      selected,
      pages.map((_, i) => i),
      pages,
    );
    const one = blocked.length === 1;
    bulkNotice = blocked.length
      ? `Page${one ? "" : "s"} ${formatRanges(blocked.map((s) => s + 1))} ${one ? "has" : "have"} ` +
        `regions of ${blockers.join(", ")}. Remove them first to give ` +
        `${one ? "the page" : "those pages"} to ${label}.`
      : null;
  }

  function clearRegions() {
    if (!confirmingClear) {
      confirmingClear = true;
      return;
    }
    confirmingClear = false;
    bulkNotice = null;
    const piece = wizard.pieces[selected];
    if (piece) piece.zones = [];
  }

  function copyFromPiece(index: number) {
    const from = wizard.pieces[index];
    if (!from || index === selected) return;
    // The title names this piece, so it is the one field not carried over.
    const title = wizard.pieces[selected].meta.title;
    wizard.pieces[selected].meta = { ...copyMetadata(from.meta), title };
  }

  function copyFromSource() {
    // The title names this piece, so a title already given stays; an empty one
    // takes the source's.
    const title = wizard.pieces[selected].meta.title.trim() || wizard.source.title;
    wizard.pieces[selected].meta = { ...copyMetadata(wizard.source), title };
  }

  const piece = $derived(wizard.pieces[selected]);
  const label = $derived(piece ? piece.meta.title.trim() || piece.id : "");
  const covered = $derived(piece ? pagesCovered(piece) : []);
  // A facsimile piece with no regions would produce no tasks at all, so it
  // blocks finishing unless marked as having none on purpose.
  const unmarked = $derived(
    wizard.pieces.filter((p) => p.kind === "facsimile" && p.zones.length === 0 && !p.noRegions),
  );

  const labelOf = (p: (typeof wizard.pieces)[number]) => p.meta.title.trim() || p.id;
  const rangeOf = (p: (typeof wizard.pieces)[number]) => {
    if (p.kind === "encoded") return "encoding";
    if (p.kind === "physical-only") {
      return p.pages ? `${p.pages} page${p.pages === 1 ? "" : "s"}` : "physical only";
    }
    const on = pagesCovered(p);
    if (on.length) return `pages ${formatRanges(on.map((s) => s + 1))}`;
    return p.noRegions ? "no regions, on purpose" : "no regions";
  };

  // The page count of a physical piece; empty or invalid input means unknown.
  function setPageCount(value: string) {
    const n = Math.floor(Number(value));
    wizard.pieces[selected].pages = Number.isFinite(n) && n > 0 ? n : undefined;
  }

  const railStatus = $derived.by(() => {
    const count = `${wizard.pieces.length} piece${wizard.pieces.length === 1 ? "" : "s"}`;
    if (!wizard.images.length) return count;
    const marked = new Set(wizard.pieces.flatMap((p) => p.zones.map((z) => z.surface)));
    const open = wizard.images.filter((_, i) => !marked.has(i)).length;
    return `${count} · ${open ? `${open} page${open === 1 ? "" : "s"} uncovered` : "all pages covered"}`;
  });

  function selectPiece(index: number) {
    selected = index;
    bulkNotice = null;
    confirmingClear = false;
    confirmingRemove = null;
  }
</script>

{#snippet material()}
  <PieceZoneEditor bind:pieces={wizard.pieces} {pages} selectedPiece={selected} />
{/snippet}

<WizardCard
  step="pieces"
  heading={wizard.images.length ? "Mark the pieces" : "Describe the pieces"}
  intro="The separate works in this source. Each becomes its own score and its own set of tasks."
  status={railStatus}
  material={pages.length ? material : undefined}
  onBack={previousStep}
  backDisabled={busy}
  onNext={last ? () => finisher.run() : nextStep}
  nextDisabled={busy || !wizard.pieces.length || unmarked.length > 0}
  nextLabel={!last ? "Continue" : busy ? "Working…" : finisher.error ? "Retry" : "Finish"}
  nextIcon={!last ? "arrow-right" : busy ? null : finisher.error ? "arrow-right" : "check"}
  finish={last}
>
  <div class="pieces-head">
    <span class="pieces-count">Pieces · {wizard.pieces.length}</span>
    <button type="button" class="pill pill-sm" onclick={addPiece}>+ Add piece</button>
  </div>

  <div class="pieces">
    {#each wizard.pieces as p, i (p.id)}
      <div class="piece" class:selected={selected === i} style="--piece: {pieceColour(i)}">
        <div class="piece-row">
          <button type="button" class="piece-head" onclick={() => selectPiece(i)}>
            <span class="swatch"></span>
            <span class="name" class:plain={selected !== i}>{labelOf(p)}</span>
            <span class="range">{rangeOf(p)}</span>
          </button>
          {#if wizard.pieces.length > 1}
            {#if confirmingRemove === p.id}
              <button
                type="button"
                class="btn btn-danger delete"
                onclick={() => removePiece(i)}
                disabled={busy}
              >
                Really remove {labelOf(p)}?
              </button>
            {:else}
              <button
                type="button"
                class="btn btn-icon btn-danger delete"
                onclick={() => removePiece(i)}
                disabled={busy}
                aria-label="Remove {labelOf(p)}"
                title="Remove this piece"
              >
                ×
              </button>
            {/if}
          {/if}
        </div>
        {#if selected === i && p.kind === "facsimile" && pages.length}
          <div class="piece-actions">
            <button type="button" class="pill pill-sm" onclick={assignAllPages} disabled={busy}>
              Assign all pages
            </button>
            <button
              type="button"
              class="pill pill-sm"
              class:confirming={confirmingClear}
              onclick={clearRegions}
              disabled={busy || !p.zones.length}
            >
              {confirmingClear ? "Really clear all regions?" : "Clear regions"}
            </button>
            {#if !p.zones.length}
              <button
                type="button"
                class="pill pill-sm"
                class:on={p.noRegions}
                onclick={() => (wizard.pieces[i].noRegions = !p.noRegions)}
                disabled={busy}
                title="This piece covers no regions of the source on purpose; it gets no tasks."
              >
                No regions on purpose
              </button>
            {/if}
          </div>
          {#if bulkNotice}
            <p class="msg-warn bulk-notice" role="status">{bulkNotice}</p>
          {/if}
        {/if}
      </div>
    {/each}
  </div>

  {#if unusedEncodings.length}
    <div class="unused">
      {#each unusedEncodings as encoding (encoding.name)}
        <div class="unused-row">
          <span class="unused-name">
            <code>{encoding.name}</code> is uploaded but belongs to no piece.
          </span>
          <button
            type="button"
            class="pill pill-sm"
            onclick={() => readdEncoding(encoding.name)}
            disabled={busy}
          >
            Add as a piece
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if piece}
    <div class="piece-meta" style="--piece: {pieceColour(selected)}">
    <MetadataForm bind:meta={wizard.pieces[selected].meta} variant="piece">
      {#snippet heading()}
        <span class="meta-for">
          Metadata for <span style="color: {pieceColour(selected)}">{label}</span>
        </span>
      {/snippet}
      {#snippet subhead()}
        <div class="copy-row">
          <button type="button" class="pill pill-sm" onclick={copyFromSource}>
            Copy from the source
          </button>
          {#if wizard.pieces.length > 1}
            <select
              class="copy-select"
              value=""
              aria-label="Copy the metadata from another piece"
              onchange={(e) => {
                const el = e.currentTarget;
                copyFromPiece(Number(el.value));
                el.value = "";
              }}
            >
              <option value="" disabled>Copy from piece…</option>
              {#each wizard.pieces as other, i (other.id)}
                {#if i !== selected}
                  <option value={i}>{labelOf(other)}</option>
                {/if}
              {/each}
            </select>
          {/if}
        </div>
      {/snippet}
    </MetadataForm>

    {#if piece.kind === "facsimile"}
      <p class="covered">
        <strong style="color: {pieceColour(selected)}">{label}</strong>
        {#if covered.length}
          covers page{covered.length === 1 ? "" : "s"}
          {formatRanges(covered.map((p) => p + 1))}. Adjust its regions in the
          pane on the left.
        {:else if piece.noRegions}
          covers no regions on purpose and gets no tasks.
        {:else}
          has no regions marked yet. Mark them in the pane on the left.
        {/if}
      </p>
    {:else if piece.kind === "physical-only"}
      <p class="covered">
        <strong style="color: {pieceColour(selected)}">{label}</strong>
        is transcribed from the physical source — encoding starts from a blank
        score.
      </p>
      <label class="field pages-field">
        Pages in this piece
        <input
          class="input pages-input"
          type="number"
          min="1"
          step="1"
          value={piece.pages ?? ""}
          oninput={(e) => setPageCount((e.target as HTMLInputElement).value)}
          disabled={busy}
        />
        <span class="hint">
          Optional. With a page count, each page becomes its own encoding task;
          without one, the piece is a single task.
        </span>
      </label>
    {:else}
      <p class="covered">
        <strong style="color: {pieceColour(selected)}">{label}</strong>
        comes from the uploaded encoding <code>{piece.encodingName}</code>.
      </p>
    {/if}
    </div>
  {:else}
    <p class="covered">Add a piece to describe what this campaign encodes.</p>
  {/if}

  {#if unmarked.length}
    <p class="msg-warn" role="status">
      {unmarked.map((p) => p.meta.title.trim() || p.id).join(", ")}
      {unmarked.length === 1 ? "has" : "have"} no regions marked, so
      {unmarked.length === 1 ? "it" : "they"} would produce no tasks. Mark
      regions, or mark the piece as having no regions on purpose, to finish.
    </p>
  {/if}

  {#if finisher.error}
    <p class="msg-error" role="alert">{finisher.error}</p>
  {/if}
  <ProgressSteps log={finisher.log} />
</WizardCard>

<style>
  .pieces-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
  }
  .pieces-count {
    flex: 1;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .pieces {
    display: grid;
    gap: 7px;
    margin-top: 9px;
  }
  .piece {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  .piece:hover:not(.selected) {
    border-color: var(--accent);
  }
  .piece.selected {
    border: 1.5px solid var(--piece);
    background: color-mix(in srgb, var(--piece) 7%, var(--card));
  }
  .piece-row {
    display: flex;
    align-items: center;
  }
  .piece-head {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    box-sizing: border-box;
    cursor: pointer;
    font: inherit;
    color: inherit;
    text-align: left;
    padding: 9px 12px;
    background: none;
    border: none;
  }
  .swatch {
    flex: none;
    width: 13px;
    height: 13px;
    border-radius: 3px;
    background: var(--piece);
  }
  .name {
    flex: 1;
    font-size: 13.5px;
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.plain {
    color: var(--ink-soft);
  }
  .range {
    font-size: 11.5px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  /* The remove control stays quiet until hovered; the confirmation is the
     same small size in the danger colour. */
  .delete {
    flex: none;
    margin-right: 10px;
    min-height: 22px;
    font-size: 11.5px;
    padding: 2px 9px;
  }
  .delete.btn-icon {
    width: 22px;
    font-size: 15px;
    border-radius: 6px;
    color: var(--ink-faint);
    border-color: transparent;
    background: transparent;
  }
  .delete.btn-icon:hover:not(:disabled) {
    color: var(--danger);
    border-color: var(--danger-line);
    background: var(--danger-bg);
  }
  .piece-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    padding: 0 12px 10px 35px;
  }
  .piece-actions .pill:hover:not(:disabled):not(.confirming) {
    color: var(--piece);
    border-color: var(--piece);
  }
  /* The on state is an outline in the piece's colour, not the solid blue of
     a selected view pill, which clashes with the piece tints. */
  .piece-actions .pill.on {
    font-weight: 600;
    color: var(--piece);
    border-color: var(--piece);
    background: color-mix(in srgb, var(--piece) 10%, var(--card));
  }
  .piece-actions .confirming {
    color: var(--danger);
    border-color: var(--danger);
  }
  .bulk-notice {
    margin: 0;
    padding: 0 12px 10px 35px;
    font-size: 11.5px;
  }
  .meta-for {
    font-size: 13px;
    font-weight: 600;
  }
  .copy-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 11px;
  }
  /* Styled as a pill, like the copy button beside it. */
  .copy-select {
    font: 11.5px var(--font);
    padding: 4px 11px;
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 999px;
    max-width: 220px;
  }
  /* The selected piece's metadata, framed in the piece's colour like its
     entry in the list above. */
  .piece-meta {
    margin-top: 16px;
    padding: 0 14px 14px;
    border: 1.5px solid var(--piece);
    border-radius: 10px;
    background: color-mix(in srgb, var(--piece) 5%, var(--card));
  }
  .covered {
    margin: 12px 0 0;
    font-size: 12px;
    color: var(--ink-faint);
  }
  .pages-field {
    margin-top: 11px;
  }
  .pages-input {
    max-width: 110px;
  }
  .unused {
    display: grid;
    gap: 7px;
    margin-top: 9px;
  }
  .unused-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 12px;
    border: 1px dashed var(--line-strong);
    border-radius: 8px;
  }
  .unused-name {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--ink-soft);
    overflow-wrap: anywhere;
  }
</style>
