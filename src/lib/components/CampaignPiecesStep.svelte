<!--
  Wizard step 6: the works within the source. Each piece gets its own metadata
  and, when it is read from the facsimile, the regions of the pages it covers.

  Pieces are seeded from what the upload produced — one per uploaded encoding,
  plus a single facsimile piece for the page images — so a source holding one
  work needs no editing here.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { auth, forge } from "$lib/auth.svelte.ts";
  import { provider, automation, measureDetectorUrl } from "$lib/forge/config.ts";
  import { registerCampaign } from "$lib/campaign-resolve.ts";
  import { imageSize } from "$lib/prepare-images.ts";
  import { startDetection } from "$lib/measure-detection.ts";
  import {
    buildCampaignConfig,
    configToYaml,
    buildTaskCsv,
    buildStateCsv,
    buildLockCsv,
    buildHistoryCsv,
    buildCommentCsv,
    piecePath,
    type PieceSurfaces,
  } from "$lib/campaign-init.ts";
  import { buildPieceHead } from "$lib/source-metadata.ts";
  import {
    buildBlankScoreMei,
    buildFacsimileMei,
    initialFacsimileModel,
    relinkFacsimileImages,
    replaceMeiHead,
  } from "$lib/mei-facsimile.ts";
  import {
    copyMetadata,
    coverPages,
    createEncodedPiece,
    createPiece,
    formatRanges,
    initialPieces,
    pagesCovered,
    partitionPages,
    pieceColour,
    type DetectedPage,
  } from "$lib/pieces.ts";
  import {
    wizard,
    previousStep,
    clearFinishedSetup,
    COPYRIGHT_ACKNOWLEDGEMENT,
  } from "$lib/wizard.svelte.ts";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import type { FileChange } from "$lib/forge/types.ts";
  import WizardCard from "./WizardCard.svelte";
  import MetadataForm from "./MetadataForm.svelte";
  import PieceZoneEditor from "./PieceZoneEditor.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";

  let selected = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const log = new ProgressLog();
  // Detection is the slow, failure-prone half of Finish. Its result is kept so
  // a retry after a commit failure does not re-run the detector.
  let detected: DetectedPage[] | null = null;

  // Seed the pieces the first time the step is opened; returning from a later
  // step must not discard edits.
  if (!wizard.pieces.length) {
    wizard.pieces = initialPieces(
      wizard.encodings.map((encoding) => encoding.name),
      wizard.images.length > 0,
    );
  }

  // The pages are final once this step opens, so detection starts now and runs
  // while the pieces are described — the piece regions play no part in it.
  // Leaving the step stops pages that have not started; finished pages stay
  // cached by content, so coming back re-detects only pages that changed.
  const detection = startDetection(wizard.images, measureDetectorUrl);
  onDestroy(() => detection.cancel());

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

  function copyFromPrevious() {
    const previous = wizard.pieces[selected - 1];
    if (!previous) return;
    // The title names this piece, so it is the one field not carried over.
    const title = wizard.pieces[selected].meta.title;
    wizard.pieces[selected].meta = { ...copyMetadata(previous.meta), title };
  }

  function copyFromSource() {
    wizard.pieces[selected].meta = copyMetadata(wizard.source);
  }

  /**
   * Collect every page's detection result, awaiting any the background pass
   * has not finished. One result per page image, not per piece: two pieces
   * sharing a page share its measures. Pages the detector fails on come back
   * empty rather than failing the whole campaign.
   */
  async function detectAllPages(): Promise<DetectedPage[]> {
    const pagesOut: DetectedPage[] = [];
    for (const [i, image] of wizard.images.entries()) {
      const name = image.path.split("/").pop() ?? `${i + 1}.jpg`;
      log.step(`Detecting measures on page ${i + 1} of ${wizard.images.length}`);
      log.detail(name);
      const { width, height, boxes, tookMs } = await detection.page(i);
      log.detail(
        boxes.length
          ? `${name}: ${boxes.length} measure(s) found`
          : `${name}: no measures found`,
      );
      // Detection runs in the background and two pages at a time, so how long
      // this await took says nothing; the job reports its own duration.
      log.done(tookMs);
      // graphic @target is resolved relative to the score file, which sits in
      // the piece's own directory (sources/<piece>/score.mei); the images are
      // shared by every piece and committed at sources/img/.
      pagesOut.push({ image: `../img/${name}`, width, height, boxes });
    }
    return pagesOut;
  }

  async function finish() {
    error = null;
    const user = auth.user;
    const f = forge();
    const repo = wizard.repo;
    const claim = wizard.claim;
    if (busy) return;
    if (!user || !f) {
      error = "You are no longer signed in. Log in again to finish the campaign.";
      return;
    }
    if (!claim) {
      // The name is reserved by the first step and registered here; without it
      // the campaign would have nowhere to live.
      error =
        "This campaign has no name reserved. Go back to the first step and continue from there.";
      return;
    }
    if (!repo) {
      // Reaching here without a repository means the upload/pages step did not
      // complete; saying so beats a button that does nothing.
      error =
        "This campaign has no repository yet. Go back to the upload step and continue from there.";
      return;
    }

    busy = true;
    log.clear();
    try {
      if (!detected) detected = await detectAllPages();

      // Every piece is published under the campaign's licence, so it is stated
      // in each piece's header as well as in the config.
      const license = wizard.license;
      const split = partitionPages(wizard.pieces, detected);
      // The committed pages, as an uploaded encoding's facsimile is relinked to
      // them: detection has already measured every one at its committed size.
      const images = detected.map((page) => ({
        target: page.image,
        width: page.width,
        height: page.height,
      }));
      const surfaces: PieceSurfaces = {};
      const scores: FileChange[] = [];

      wizard.pieces.forEach((piece, i) => {
        const name = piece.meta.title.trim() || piece.id;
        // Building a score is a string operation: it reports what it did, not
        // how long it took.
        log.step(`Building the score for ${name} (${i + 1} of ${wizard.pieces.length})`, {
          timed: false,
        });
        const head = buildPieceHead(
          {
            title: piece.meta.title,
            composer: piece.meta.composer,
            license,
          },
          wizard.source,
          { creator: user.login },
        );
        if (piece.kind === "encoded") {
          const encoding = wizard.encodings.find((e) => e.name === piece.encodingName);
          if (!encoding) throw new Error(`The encoding for ${piece.id} is no longer available.`);
          log.detail(`from the encoding ${encoding.name}`);
          // An uploaded encoding's facsimile references the files and pixel
          // sizes it was authored against, so it is pointed at the pages this
          // campaign committed: surface n to page n, coordinates scaled with it.
          const relinked = relinkFacsimileImages(encoding.mei, images);
          scores.push({ path: piecePath(piece.id), content: replaceMeiHead(relinked, head) });
          return;
        }
        if (piece.kind === "physical-only") {
          // A blank score to transcribe the physical source into. A known page
          // count writes one page-break marker per page, matching the per-page
          // tasks planTasks derives from config; no measure-correction pre-task
          // exists, since there is no facsimile to correct measures on.
          const count = piece.pages ?? 0;
          log.detail(
            count > 0
              ? `blank score, ${count} page(s) from the physical source`
              : "blank score, transcribed from the physical source",
          );
          scores.push({ path: piecePath(piece.id), content: buildBlankScoreMei(head, count) });
          return;
        }
        // Stage A: facsimile and labelled zones only. The measure body is
        // generated once this piece's measure-correction pre-task validates.
        const model = initialFacsimileModel(split[i].pages, {});
        log.detail(
          `${split[i].pages.length} page(s), ${split[i].measuredSurfaces.length} with measures`,
        );
        scores.push({
          path: piecePath(piece.id),
          content: buildFacsimileMei({ ...model, headXml: head }),
        });
        surfaces[piece.id] = split[i].measuredSurfaces;
      });

      const config = buildCampaignConfig(
        {
          name: wizard.handle.trim(),
          title: wizard.title.trim(),
          description: wizard.description.trim(),
          license,
          sourceKind: wizard.images.length
            ? "facsimile"
            : wizard.encodings.length
              ? "mei-template"
              : "physical-only",
          sourceHeader: {
            title: wizard.source.title,
            composer: wizard.source.composer,
            publisher: wizard.source.publisher,
            date: wizard.source.date,
          },
          images: wizard.images.map((image) => image.path),
          rightsAcknowledged: wizard.copyrightAccepted
            ? COPYRIGHT_ACKNOWLEDGEMENT.version
            : "",
          pieces: wizard.pieces.map((piece) => ({
            id: piece.id,
            kind: piece.kind,
            path: piecePath(piece.id),
            ...(piece.kind === "physical-only" && piece.pages
              ? { pages: piece.pages }
              : {}),
            zones: piece.zones.map((zone) => ({
              // config records the source's page numbers, 1-based.
              surface: zone.surface + 1,
              ulx: Math.round(zone.ulx),
              uly: Math.round(zone.uly),
              lrx: Math.round(zone.lrx),
              lry: Math.round(zone.lry),
            })),
            header: { title: piece.meta.title, composer: piece.meta.composer },
          })),
        },
        String(user.id),
        automation,
        repo.id,
      );

      const files: FileChange[] = [
        { path: "config.yaml", content: configToYaml(config) },
        ...scores,
        { path: "tracking/task.csv", content: buildTaskCsv(config, surfaces) },
        { path: "tracking/state.csv", content: buildStateCsv(config, surfaces) },
        { path: "tracking/lock.csv", content: buildLockCsv() },
        { path: "tracking/history.csv", content: buildHistoryCsv() },
        { path: "tracking/comment.csv", content: buildCommentCsv() },
      ];
      log.step(`Committing the campaign (${files.length} file(s))`);
      await f.commitFiles(repo.owner, repo.name, files, "Initialise campaign");

      // There is a campaign now, so the name it was reserved under becomes its
      // address. This is the reservation being cashed in, not a race: the name
      // has been held since the first step. It can only fail if the reservation
      // ran out and somebody else took the name in the meantime — in which case
      // the setup stays resumable rather than being marked finished.
      log.step(`Registering the campaign name “${claim.name}”`);
      const registration = await registerCampaign(
        claim.name,
        repo.id,
        provider.id,
        claim.token,
      );
      if (registration !== "ok") {
        error =
          registration === "conflict"
            ? `The reservation of “${claim.name}” ran out and the name went to another campaign. Everything was committed to ${repo.full_name}, but it cannot be reached under that name.`
            : `Everything was committed to ${repo.full_name}, but the name “${claim.name}” could not be registered, so the campaign has no address yet. Try again.`;
        busy = false;
        log.fail();
        return;
      }

      // The topic is what puts a campaign in the listing, so a campaign missing it
      // is not finished and the setup stays open. Retrying runs this whole step
      // again, which both the commit and the registration tolerate.
      log.step("Adding it to the list of campaigns");
      try {
        await f.setRepoTopics(repo.owner, repo.name, [provider.repoTopic]);
      } catch (err) {
        console.error("Could not tag the campaign with its topic:", (err as Error).message);
        error =
          `Everything was committed to ${repo.full_name} and “${claim.name}” is registered, so ` +
          `the campaign already works at /${claim.name}. It is not in the list of ` +
          `campaigns yet, so the setup stays open — retry to add it: ${(err as Error).message}`;
        busy = false;
        log.fail();
        return;
      }

      // The campaign is committed, reachable and listed, so the setup is done: it
      // is cleared once the campaign has opened, since emptying the wizard while
      // this step is still on screen would show the first step again.
      log.done();
      await goto(`/${repo.name}`);
      clearFinishedSetup();
    } catch (err) {
      console.error("Finishing the campaign failed:", (err as Error).message);
      error = `Could not finish the campaign: ${(err as Error).message}`;
      busy = false;
      log.fail();
    }
  }

  const piece = $derived(wizard.pieces[selected]);
  const label = $derived(piece ? piece.meta.title.trim() || piece.id : "");
  const covered = $derived(piece ? pagesCovered(piece) : []);
  // A facsimile piece with no regions would produce no tasks at all.
  const unmarked = $derived(
    wizard.pieces.filter((p) => p.kind === "facsimile" && p.zones.length === 0),
  );

  const labelOf = (p: (typeof wizard.pieces)[number]) => p.meta.title.trim() || p.id;
  const rangeOf = (p: (typeof wizard.pieces)[number]) => {
    if (p.kind === "encoded") return "encoding";
    if (p.kind === "physical-only") {
      return p.pages ? `${p.pages} page${p.pages === 1 ? "" : "s"}` : "physical only";
    }
    const on = pagesCovered(p);
    return on.length ? `pages ${formatRanges(on.map((s) => s + 1))}` : "no regions";
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
  onNext={finish}
  nextDisabled={busy || !wizard.pieces.length}
  nextLabel={busy ? "Working…" : error ? "Retry" : "Finish ✓"}
  finish
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
                class="delete confirming"
                onclick={() => removePiece(i)}
                disabled={busy}
              >
                Really remove {labelOf(p)}?
              </button>
            {:else}
              <button
                type="button"
                class="delete"
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
    <MetadataForm bind:meta={wizard.pieces[selected].meta}>
      {#snippet heading()}
        <span class="meta-for">
          Metadata for <span style="color: {pieceColour(selected)}">{label}</span>
        </span>
      {/snippet}
    </MetadataForm>

    <div class="copy-row">
      <button type="button" class="pill pill-sm" onclick={copyFromSource}>
        Copy from the source
      </button>
      {#if selected > 0}
        <button type="button" class="pill pill-sm" onclick={copyFromPrevious}>
          Copy from previous piece
        </button>
      {/if}
    </div>

    {#if piece.kind === "facsimile"}
      <p class="covered">
        <strong style="color: {pieceColour(selected)}">{label}</strong>
        {#if covered.length}
          covers page{covered.length === 1 ? "" : "s"}
          {formatRanges(covered.map((p) => p + 1))}. Adjust its regions in the
          pane on the left.
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
  {:else}
    <p class="covered">Add a piece to describe what this campaign encodes.</p>
  {/if}

  {#if unmarked.length}
    <p class="msg-warn" role="status">
      {unmarked.map((p) => p.meta.title.trim() || p.id).join(", ")}
      {unmarked.length === 1 ? "has" : "have"} no regions marked, so
      {unmarked.length === 1 ? "it" : "they"} would produce no tasks.
    </p>
  {/if}

  {#if error}
    <p class="msg-error" role="alert">{error}</p>
  {/if}
  <ProgressSteps {log} />
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
  .delete {
    flex: none;
    cursor: pointer;
    width: 22px;
    height: 22px;
    margin-right: 8px;
    font-size: 12px;
    color: var(--ink-faint);
    background: none;
    border: none;
  }
  .delete:hover {
    color: var(--danger);
  }
  .delete.confirming {
    width: auto;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    padding: 3px 10px;
    color: var(--danger);
    border: 1px solid var(--danger-line);
    border-radius: 999px;
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
