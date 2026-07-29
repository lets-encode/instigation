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
    piecePath,
    type PieceSurfaces,
  } from "$lib/campaign-init.ts";
  import { buildPieceHead } from "$lib/source-metadata.ts";
  import {
    buildFacsimileMei,
    initialFacsimileModel,
    relinkFacsimileImages,
    replaceMeiHead,
  } from "$lib/mei-facsimile.ts";
  import {
    copyMetadata,
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
  // with the pixel size the regions are expressed in. Released on destroy.
  const objectUrls: string[] = [];
  let pages = $state<{ url: string; width: number; height: number }[]>([]);
  $effect(() => {
    let cancelled = false;
    (async () => {
      const built = [];
      for (const image of wizard.images) {
        const { width, height } = await imageSize(image.blob);
        const url = URL.createObjectURL(image.blob);
        objectUrls.push(url);
        built.push({ url, width, height });
      }
      if (!cancelled) pages = built;
    })();
    return () => {
      cancelled = true;
    };
  });
  onDestroy(() => objectUrls.forEach((url) => URL.revokeObjectURL(url)));

  function addPiece() {
    wizard.pieces = [...wizard.pieces, createPiece(wizard.pieces)];
    selected = wizard.pieces.length - 1;
  }

  function removePiece(index: number) {
    wizard.pieces = wizard.pieces.filter((_, i) => i !== index);
    selected = Math.max(0, Math.min(selected, wizard.pieces.length - 1));
  }

  function copyFromPrevious() {
    const previous = wizard.pieces[selected - 1];
    if (!previous) return;
    // The title names this piece, so it is the one field not carried over.
    const title = wizard.pieces[selected].meta.title;
    wizard.pieces[selected].meta = { ...copyMetadata(previous.meta), title };
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
      const { width, height, boxes } = await detection.page(i);
      log.detail(
        boxes.length
          ? `${name}: ${boxes.length} measure(s) found`
          : `${name}: no measures found`,
      );
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
      // Reaching here without a repository means the pages step did not
      // complete; saying so beats a button that does nothing.
      error =
        "This campaign has no repository yet. Go back to the pages step and complete it first.";
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
          sourceKind: wizard.images.length ? "facsimile" : "mei-template",
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
          `the campaign already works at /campaign/${claim.name}. It is not in the list of ` +
          `campaigns yet, so the setup stays open — retry to add it: ${(err as Error).message}`;
        busy = false;
        log.fail();
        return;
      }

      // The campaign is committed, reachable and listed, so the setup is done: it
      // is cleared once the campaign has opened, since emptying the wizard while
      // this step is still on screen would show the first step again.
      log.done();
      await goto(`/campaign/${repo.name}`);
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
</script>

<!-- Two panes side by side over the full height: the pieces and their metadata
     scroll in the left one, the region editor holds the right one. -->
<div class="pane-split">
  <div class="pane-scroll">
    <WizardCard
      step="pieces"
      heading="Mark the pieces"
      intro="The separate works in this source. Each becomes its own score and its own set of tasks."
      onBack={previousStep}
      backDisabled={busy}
      onNext={finish}
      nextDisabled={busy || !wizard.pieces.length}
      nextLabel={busy ? "Working…" : error ? "Retry" : "Finish"}
    >
      <ul class="pieces">
        {#each wizard.pieces as p, i (p.id)}
          <li>
            <button
              type="button"
              class="tab"
              class:active={selected === i}
              style="--piece: {pieceColour(i)}"
              onclick={() => (selected = i)}
            >
              <span class="swatch"></span>
              <span class="name">{p.meta.title.trim() || p.id}</span>
              <span class="kind">{p.kind === "encoded" ? "encoding" : `${pagesCovered(p).length} page(s)`}</span>
            </button>
            {#if wizard.pieces.length > 1}
              <button
                type="button"
                class="btn btn-quiet btn-danger"
                onclick={() => removePiece(i)}
                aria-label="Remove {p.id}"
              >
                ×
              </button>
            {/if}
          </li>
        {/each}
      </ul>

      <div class="actions">
        <button type="button" class="btn btn-quiet" onclick={addPiece}>Add piece</button>
        {#if selected > 0}
          <button type="button" class="btn btn-quiet" onclick={copyFromPrevious}>
            Copy metadata from previous piece
          </button>
        {/if}
      </div>

      {#if piece}
        <h2>
          Metadata for <span style="color: {pieceColour(selected)}">{label}</span>
        </h2>
        <MetadataForm bind:meta={wizard.pieces[selected].meta} />

        {#if piece.kind === "facsimile"}
          <p class="covered">
            <strong style="color: {pieceColour(selected)}">{label}</strong>
            {#if covered.length}
              covers page{covered.length === 1 ? "" : "s"}
              {formatRanges(covered.map((p) => p + 1))}. Mark the regions in the pane
              beside this one.
            {:else}
              has no regions marked yet. Mark them in the pane beside this one.
            {/if}
          </p>
        {:else}
          <p class="covered">
            <strong style="color: {pieceColour(selected)}">{label}</strong>
            comes from the uploaded encoding <code>{piece.encodingName}</code>. It is
            committed whole, so it needs no regions.
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
  </div>

  {#if piece?.kind === "facsimile"}
    <PieceZoneEditor bind:pieces={wizard.pieces} {pages} selectedPiece={selected} />
  {/if}
</div>

<style>
  .pieces {
    list-style: none;
    margin: 0 0 0.75rem;
    padding: 0;
    display: grid;
    gap: 0.4rem;
  }
  .pieces li {
    display: flex;
    align-items: stretch;
    gap: 0.35rem;
  }
  .tab {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    font: inherit;
    text-align: left;
    padding: 0.5rem 0.75rem;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  .tab.active {
    border-color: var(--piece);
    background: var(--bg-tint);
  }
  .swatch {
    flex: none;
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 3px;
    background: var(--piece);
  }
  .name {
    flex: 1;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .kind {
    font-size: 0.8rem;
    color: var(--ink-faint);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }
  .covered {
    margin: 0.6rem 0 0;
    font-size: 0.85rem;
    color: var(--ink-faint);
  }
  h2 {
    margin: 1.75rem 0 1rem;
    font-size: 1rem;
  }
</style>
