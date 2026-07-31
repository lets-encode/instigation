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
    busy ? "Working…" : hasUpload ? "Continue →" : "Continue without images",
  );

  // What the rail reports while this step is open.
  const railStatus = $derived.by(() => {
    const parts: string[] = [];
    if (wizard.files.length)
      parts.push(`${wizard.files.length} file${wizard.files.length === 1 ? "" : "s"} added`);
    if (manifestUrl) parts.push("IIIF manifest");
    return parts.join(" · ") || "adding material";
  });

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
  intro="Drop material in the pane on the left, or point at a IIIF manifest. You pick which pages to keep next."
  status={railStatus}
  onBack={previousStep}
  backDisabled={busy}
  onNext={continueToNextStep}
  nextDisabled={!canContinue}
  nextLabel={continueLabel}
>
  {#snippet material()}
    <FileDropzone bind:files={wizard.files} />
  {/snippet}

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

  <div class="spacer"></div>

  {#if hasUpload && !busy && !log.steps.length}
    <div class="status-box">
      {wizard.files.length
        ? `${wizard.files.length} file${wizard.files.length === 1 ? "" : "s"} ready`
        : "1 manifest ready"} — pages are read when you continue.
    </div>
  {/if}

  {#if error}
    <p class="msg-error" role="alert">{error}</p>
  {/if}
  <ProgressSteps {log} />

  <!-- Last before the footer, so it keeps its place when the report above it
       changes: the acknowledgement gates Continue and sits right above it. -->
  {#if hasUpload}
    <label class="ack">
      <input type="checkbox" bind:checked={wizard.copyrightAccepted} />
      <span>{COPYRIGHT_ACKNOWLEDGEMENT.text}</span>
    </label>
  {/if}
</WizardCard>

<style>
  .manifest {
    margin-top: 22px;
  }
  .ack {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin-top: 14px;
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--warn);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    border-radius: 8px;
    cursor: pointer;
  }
  .ack input {
    margin-top: 2px;
  }
  /* Pushes the status report to the card's foot, above the buttons. */
  .spacer {
    flex: 1;
  }
</style>
