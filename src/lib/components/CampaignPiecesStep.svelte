<!--
  Wizard step 4: the works within the source. Each piece gets its own metadata
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
    replaceMeiHead,
  } from "$lib/mei-facsimile.ts";
  import {
    copyMetadata,
    createPiece,
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
  import type { FileChange } from "$lib/forge/types.ts";
  import WizardCard from "./WizardCard.svelte";
  import MetadataForm from "./MetadataForm.svelte";
  import PieceZoneEditor from "./PieceZoneEditor.svelte";

  let selected = $state(0);
  let busy = $state(false);
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);
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
   * Detect measures once per page image, not once per piece: two pieces sharing
   * a page would otherwise have the page analysed twice, and the detector is a
   * shared service. Pages the detector fails on come back empty rather than
   * failing the whole campaign.
   */
  async function detectAllPages(): Promise<DetectedPage[]> {
    const { detectMeasures } = await import("$lib/facsimile-detect.ts");
    const { sortReadingOrder } = await import("$lib/mei-facsimile.ts");
    const pagesOut: DetectedPage[] = [];
    for (const [i, image] of wizard.images.entries()) {
      progress = `Detecting measures on page ${i + 1} of ${wizard.images.length}…`;
      const name = image.path.split("/").pop() ?? `${i + 1}.jpg`;
      const { width, height } = await imageSize(image.blob);
      const normalised = await detectMeasures(image.blob, name, measureDetectorUrl);
      // The detector returns 0..1 coordinates; regions and zones are in pixels.
      const boxes = sortReadingOrder(normalised ?? []).map((b) => ({
        ulx: b.ulx * width,
        uly: b.uly * height,
        lrx: b.lrx * width,
        lry: b.lry * height,
      }));
      pagesOut.push({ image: `img/${name}`, width, height, boxes });
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
      // Reaching here without a repository means the upload step did not
      // complete; saying so beats a button that does nothing.
      error =
        "This campaign has no repository yet. Go back to the upload step and complete it first.";
      return;
    }

    busy = true;
    try {
      if (!detected) detected = await detectAllPages();

      progress = "Building the scores…";
      // Every piece is published under the campaign's licence, so it is stated
      // in each piece's header as well as in the config.
      const license = wizard.license;
      const split = partitionPages(wizard.pieces, detected);
      const surfaces: PieceSurfaces = {};
      const scores: FileChange[] = [];

      wizard.pieces.forEach((piece, i) => {
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
          scores.push({ path: piecePath(piece.id), content: replaceMeiHead(encoding.mei, head) });
          return;
        }
        // Stage A: facsimile and labelled zones only. The measure body is
        // generated once this piece's measure-correction pre-task validates.
        const model = initialFacsimileModel(split[i].pages, {});
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

      progress = "Committing the campaign…";
      await f.commitFiles(
        repo.owner,
        repo.name,
        [
          { path: "config.yaml", content: configToYaml(config) },
          ...scores,
          { path: "tracking/task.csv", content: buildTaskCsv(config, surfaces) },
          { path: "tracking/state.csv", content: buildStateCsv(config, surfaces) },
          { path: "tracking/lock.csv", content: buildLockCsv() },
          { path: "tracking/history.csv", content: buildHistoryCsv() },
        ],
        "Initialise campaign",
      );

      // There is a campaign now, so the name it was reserved under becomes its
      // address. This is the reservation being cashed in, not a race: the name
      // has been held since the first step. It can only fail if the reservation
      // ran out and somebody else took the name in the meantime — in which case
      // the setup stays resumable rather than being marked finished.
      progress = "Registering the campaign name…";
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
        progress = null;
        return;
      }

      // The topic is what puts a campaign in the listing, so a campaign missing it
      // is not finished and the setup stays open. Retrying runs this whole step
      // again, which both the commit and the registration tolerate.
      progress = "Adding it to the list of campaigns…";
      try {
        await f.setRepoTopics(repo.owner, repo.name, [provider.repoTopic]);
      } catch (err) {
        console.error("Could not tag the campaign with its topic:", (err as Error).message);
        error =
          `Everything was committed to ${repo.full_name} and “${claim.name}” is registered, so ` +
          `the campaign already works at /campaign/${claim.name}. It is not in the list of ` +
          `campaigns yet, so the setup stays open — retry to add it: ${(err as Error).message}`;
        busy = false;
        progress = null;
        return;
      }

      // The campaign is committed, reachable and listed, so the setup is done: it
      // is cleared once the campaign has opened, since emptying the wizard while
      // this step is still on screen would show the first step again.
      await goto(`/campaign/${repo.name}`);
      clearFinishedSetup();
    } catch (err) {
      console.error("Finishing the campaign failed:", (err as Error).message);
      error = `Could not finish the campaign: ${(err as Error).message}`;
      busy = false;
      progress = null;
    }
  }

  const piece = $derived(wizard.pieces[selected]);
  const covered = $derived(piece ? pagesCovered(piece) : []);
  // A facsimile piece with no regions would produce no tasks at all.
  const unmarked = $derived(
    wizard.pieces.filter((p) => p.kind === "facsimile" && p.zones.length === 0),
  );
</script>

<!-- Two panes over the full height: the pieces and their metadata scroll in the
     top one, the region editor holds the bottom one. -->
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
        <h2>Metadata for this piece</h2>
        <MetadataForm bind:meta={wizard.pieces[selected].meta} />

        {#if piece.kind === "facsimile"}
          <p class="covered">
            {#if covered.length}
              Covers page{covered.length === 1 ? "" : "s"}
              {covered.map((p) => p + 1).join(", ")}. Mark the regions in the pane
              below.
            {:else}
              No regions marked yet. Mark them in the pane below.
            {/if}
          </p>
        {:else}
          <p class="covered">
            From the uploaded encoding <code>{piece.encodingName}</code>. It is
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
      {#if progress}
        <p class="msg-progress" role="status" aria-live="polite">{progress}</p>
      {/if}
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
