<!--
  Wizard step 3: what the campaign is built from — page images, PDFs, existing
  encodings, a IIIF manifest, or nothing at all.

  Continuing reads the upload: a PDF is rasterised to one page per document page,
  a manifest's canvases are listed, and each page gets a small preview. Nothing
  is fetched at committing size — the next step chooses which of these pages the
  campaign keeps, and creates the repository from that choice. An upload with no
  page images has nothing to choose, so that step is skipped: the repository is
  created here instead and the flow continues at the source step. Reading a long
  source is the expensive part of this step, so coming back to it and continuing
  again with the same upload keeps the pages already read.
-->
<script lang="ts">
  import { auth, forge } from "$lib/auth.svelte.ts";
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
  import { ensureCampaignRepo } from "$lib/campaign-repo.ts";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import WizardCard from "./WizardCard.svelte";
  import FileDropzone from "./FileDropzone.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";

  let busy = $state(false);
  let error = $state<string | null>(null);
  // Whether creating the repository stopped part way, which is what makes the
  // next press a retry of it.
  let failed = $state(false);
  const log = new ProgressLog();

  const manifestUrl = $derived(wizard.iiifManifestUrl.trim());
  const hasUpload = $derived(wizard.files.length > 0 || manifestUrl !== "");
  // The acknowledgement is about material being published, so it only applies
  // when there is material.
  const canContinue = $derived(
    !busy && (!hasUpload || wizard.copyrightAccepted),
  );
  const continueLabel = $derived(
    busy
      ? "Working…"
      : failed
        ? "Retry"
        : hasUpload
          ? "Continue →"
          : "Continue without images",
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

  // An upload with no page images skips the pages step, so the repository that
  // step would have created is created here before moving on. Idempotent — a
  // retry, or a setup whose repository already exists, passes straight through.
  async function continueWithoutPages(): Promise<void> {
    const user = auth.user;
    const f = forge();
    if (!user || !f) {
      error = "You are signed out. Log in with GitHub to continue.";
      return;
    }
    busy = true;
    failed = false;
    try {
      await ensureCampaignRepo(f, user.login, ({ step, detail }) => {
        if (step) log.step(step);
        if (detail) log.detail(detail);
      });
      log.done();
      busy = false;
      nextStep();
    } catch (err) {
      console.error("Upload step failed:", (err as Error).message);
      error = `Could not create the campaign's repository: ${(err as Error).message}`;
      log.fail();
      failed = true;
      busy = false;
    }
  }

  async function continueToNextStep() {
    error = null;
    if (!hasUpload) {
      wizard.candidates = [];
      wizard.uploadKey = "";
      log.clear();
      await continueWithoutPages();
      return;
    }
    // The same upload as last time: its pages are still held, previews and all.
    // One that offered no pages needs no re-reading either — only the
    // repository it continues into (a retry lands here).
    if (wizard.uploadKey === uploadKey && uploadKey !== "") {
      if (wizard.candidates.length) {
        nextStep();
        return;
      }
      log.clear();
      await continueWithoutPages();
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

      // Nothing but encodings to choose between: the pages step is skipped, so
      // the repository is created before the flow continues past it.
      if (!wizard.candidates.length) {
        busy = false;
        await continueWithoutPages();
        return;
      }

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
  intro="Drop material here, or point at a IIIF manifest. You pick which pages to keep next."
  status={railStatus}
>
  <FileDropzone bind:files={wizard.files} />

  <div class="divider" aria-hidden="true">
    <span>or from a IIIF server</span>
  </div>

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
      working if the source server does not.
    </span>
  </label>

  {#if error}
    <p class="msg-error" role="alert">{error}</p>
  {/if}
  <ProgressSteps {log} />

  <!-- The footer is this step's own: the acknowledgement gating Continue sits
       on the buttons' row, left of them. -->
  {#snippet footer()}
    {#if hasUpload}
      <label class="ack">
        <input type="checkbox" bind:checked={wizard.copyrightAccepted} />
        <span>{COPYRIGHT_ACKNOWLEDGEMENT.text}</span>
      </label>
    {/if}
    <button
      type="button"
      class="btn btn-lg btn-secondary"
      onclick={previousStep}
      disabled={busy}
    >
      Back
    </button>
    <button
      type="button"
      class="btn btn-lg btn-primary"
      onclick={continueToNextStep}
      disabled={!canContinue}
    >
      {continueLabel}
    </button>
  {/snippet}
</WizardCard>

<style>
  .divider {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 22px;
  }
  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line);
  }
  .divider span {
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .manifest {
    margin-top: 14px;
  }
  .ack {
    display: flex;
    align-items: flex-start;
    align-self: center;
    gap: 9px;
    margin-right: auto;
    max-width: 480px;
    font-size: 12.5px;
    font-weight: 400;
    line-height: 1.5;
    color: var(--ink-soft);
    cursor: pointer;
  }
  .ack input {
    margin-top: 2px;
  }
</style>
