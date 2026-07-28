<!--
  Wizard step 3: what the campaign is built from — page images, PDFs, existing
  encodings, a IIIF manifest, or nothing at all.

  Continuing reads the upload: a PDF is rasterised to one page per document page,
  a manifest's canvases are listed, and each page gets a small preview. Nothing
  is fetched at committing size and no repository exists yet — the next step
  chooses which of these pages the campaign keeps, and creates the repository
  from that choice. Reading a long source is the expensive part of this step, so
  coming back to it and continuing again with the same upload keeps the pages
  already read.
-->
<script lang="ts">
  import { provider } from "$lib/forge/config.ts";
  import {
    prepareCandidates,
    fetchIiifCanvases,
    type IiifCanvas,
  } from "$lib/prepare-images.ts";
  import {
    wizard,
    nextStep,
    previousStep,
    COPYRIGHT_ACKNOWLEDGEMENT,
  } from "$lib/wizard.svelte.ts";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import WizardCard from "./WizardCard.svelte";
  import FileDropzone from "./FileDropzone.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";

  let busy = $state(false);
  let error = $state<string | null>(null);
  const log = new ProgressLog();

  const manifestUrl = $derived(wizard.iiifManifestUrl.trim());
  const hasUpload = $derived(wizard.files.length > 0 || manifestUrl !== "");
  // The acknowledgement is about material being published, so it only applies
  // when there is material.
  const canContinue = $derived(
    !busy && (!hasUpload || wizard.copyrightAccepted),
  );
  const continueLabel = $derived(
    busy ? "Working…" : hasUpload ? "Continue" : "Continue without images",
  );

  // What the pages already read were read from. A file is identified by name and
  // size, which is what the dropzone treats as one file too.
  const uploadKey = $derived(
    [...wizard.files.map((f) => `${f.name}:${f.size}`), manifestUrl].join("|"),
  );

  async function continueToNextStep() {
    error = null;
    if (!hasUpload) {
      wizard.candidates = [];
      wizard.uploadKey = "";
      nextStep();
      return;
    }
    // The same upload as last time: its pages are still held, previews and all.
    if (wizard.candidates.length && wizard.uploadKey === uploadKey) {
      nextStep();
      return;
    }

    busy = true;
    log.clear();
    try {
      let canvases: IiifCanvas[] = [];
      if (manifestUrl) {
        log.step("Reading the IIIF manifest");
        canvases = await fetchIiifCanvases(manifestUrl, provider.brokerUrl);
        log.detail(`${canvases.length} canvas(es)`);
      }

      const prepared = await prepareCandidates(
        wizard.files,
        canvases,
        ({ step, detail }) => {
          if (step) log.step(step);
          if (detail) log.detail(detail);
        },
        { brokerUrl: provider.brokerUrl },
      );
      // Everything is kept to begin with, so an upload that is all of the source
      // needs no choosing.
      wizard.candidates = prepared.candidates.map((page) => ({
        ...page,
        include: true,
      }));
      wizard.encodings = prepared.encodings;
      wizard.uploadKey = uploadKey;

      log.done();
      busy = false;
      nextStep();
    } catch (err) {
      console.error("Upload step failed:", (err as Error).message);
      error = `Could not read the upload: ${(err as Error).message}`;
      log.fail();
      busy = false;
    }
  }
</script>

<WizardCard
  step="upload"
  heading="Add your source"
  intro="Page images or a PDF to encode from, an existing encoding, or a IIIF manifest. You can combine them, or continue without any."
  onBack={previousStep}
  backDisabled={busy}
  onNext={continueToNextStep}
  nextDisabled={!canContinue}
  nextLabel={continueLabel}
>
  <FileDropzone bind:files={wizard.files} />

  <label class="field manifest">
    IIIF manifest URL
    <input
      class="input"
      bind:value={wizard.iiifManifestUrl}
      placeholder="https://…/manifest.json"
      type="url"
    />
    <span class="hint">
      Its canvases are downloaded and committed with the campaign, so it keeps
      working if the source server does not. You pick which of them on the next
      step.
    </span>
  </label>

  {#if hasUpload}
    <label class="ack">
      <input type="checkbox" bind:checked={wizard.copyrightAccepted} />
      <span>{COPYRIGHT_ACKNOWLEDGEMENT.text}</span>
    </label>
  {/if}

  {#if error}
    <p class="msg-error" role="alert">{error}</p>
  {/if}
  <ProgressSteps {log} />
</WizardCard>

<style>
  .manifest {
    margin-top: 1.5rem;
  }
  .ack {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    margin-top: 1.5rem;
    font-size: 0.9rem;
    color: var(--ink-soft);
  }
  .ack input {
    margin-top: 0.2rem;
  }
</style>
