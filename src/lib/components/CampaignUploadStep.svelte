<!--
  Wizard step 2: what the campaign is built from — page images, PDFs, existing
  encodings, a IIIF manifest, or nothing at all.

  This is where the campaign repository is created: on Continue the upload is
  prepared and the page images are committed, so later steps work against a real
  repository. The repository is created under the name the first step reserved,
  and that same name is registered against it once it exists, so the repository
  name and the campaign's address are one value rather than two that agree.
  Configuration, tracking tables and the piece MEIs are written by the final
  step, not here. Because the repository outlives a failure after it exists, a
  retry re-runs only the commit rather than creating a second one.
-->
<script lang="ts">
  import { auth, forge } from "$lib/auth.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import { registerCampaign } from "$lib/campaign-resolve.ts";
  import {
    prepareImages,
    fetchIiifCanvasUrls,
    blobToBase64,
  } from "$lib/prepare-images.ts";
  import {
    wizard,
    nextStep,
    previousStep,
    COPYRIGHT_ACKNOWLEDGEMENT,
  } from "$lib/wizard.svelte.ts";
  import type { FileChange } from "$lib/forge/types.ts";
  import WizardCard from "./WizardCard.svelte";
  import FileDropzone from "./FileDropzone.svelte";

  let busy = $state(false);
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);

  // The repository's "About" carries the campaign's title and description
  // together. GitHub rejects a description longer than 350 characters.
  const repoAbout = $derived(
    [wizard.title.trim(), wizard.description.trim()]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 350),
  );

  const hasUpload = $derived(
    wizard.files.length > 0 || wizard.iiifManifestUrl.trim() !== "",
  );
  // The acknowledgement is about material being published, so it only applies
  // when there is material.
  const canContinue = $derived(
    !busy && (!hasUpload || wizard.copyrightAccepted),
  );
  // A repository from a failed attempt means the commit is being retried.
  const continueLabel = $derived(
    busy
      ? "Working…"
      : wizard.repo
        ? "Retry"
        : hasUpload
          ? "Continue"
          : "Continue without images",
  );

  async function continueToNextStep() {
    error = null;
    const user = auth.user;
    const f = forge();
    if (!user || !f) return;

    // The held name is the campaign's name, for the repository and the registry
    // alike. Without it there is nothing to create the repository under.
    const claim = wizard.claim;
    if (!claim) {
      error =
        "This campaign has no name reserved yet. Go back to the first step and continue from there.";
      return;
    }

    // Nothing to upload: the repository is still created, so later steps have
    // somewhere to write.
    busy = true;
    try {
      const manifestUrl = wizard.iiifManifestUrl.trim();
      let canvasUrls: string[] = [];
      if (manifestUrl) {
        progress = "Reading the IIIF manifest…";
        canvasUrls = await fetchIiifCanvasUrls(manifestUrl, provider.brokerUrl);
      }

      progress = "Preparing your upload…";
      const prepared = hasUpload
        ? await prepareImages(
            wizard.files,
            canvasUrls,
            (_done, _total, note) => (progress = note || progress),
            { brokerUrl: provider.brokerUrl },
          )
        : { images: [], encodings: [] };

      // The repository may already exist from an earlier attempt that failed
      // after creating it; reuse it rather than creating a second one.
      let repo = wizard.repo;
      if (!repo) {
        progress = "Creating the repository…";
        const created = await f.createRepoFromTemplate({
          templateOwner: provider.template.owner,
          templateRepo: provider.template.repo,
          owner: user.login,
          name: claim.name,
          description: repoAbout,
          isPrivate: false,
        });
        repo = {
          owner: created.owner.login,
          name: created.name,
          full_name: created.full_name,
          html_url: created.html_url,
          id: created.id,
        };
        wizard.repo = repo;

        // Tag it so it shows up in the listing (non-fatal: repo already exists).
        try {
          await f.setRepoTopics(repo.owner, repo.name, [provider.repoTopic]);
        } catch (err) {
          console.warn("Could not tag new repo with topic:", (err as Error).message);
        }
        // Give the campaign's Actions a read/write token (non-fatal for org limits).
        try {
          await f.setActionsWorkflowPermissions(repo.owner, repo.name);
        } catch (err) {
          console.warn(
            "Could not set Actions workflow permissions:",
            (err as Error).message,
          );
        }
      }

      // Turn the held name into the live campaign now that there is a repo id to
      // register it against. The name was held from the first step, so this is
      // the claim being cashed in rather than a race being run: it can only fail
      // if the hold ran out and somebody else took the name meanwhile.
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
            ? `The reservation of “${claim.name}” ran out and the name went to another campaign. Your repository ${repo.full_name} was created, but no campaign can be reached under that name. Reload the page to start again under a different name; this repository can be deleted on ${provider.id}.`
            : `The repository ${repo.full_name} was created, but its name could not be registered, so the campaign would not be reachable at its address. Try again.`;
        progress = null;
        busy = false;
        return;
      }

      // Generating from a template is asynchronous — wait until the repo has
      // contents before committing onto it.
      progress = "Waiting for the repository…";
      await f.waitForRepoContents(
        repo.owner,
        repo.name,
        "templates/score.template.mei",
      );

      if (prepared.images.length) {
        progress = `Committing ${prepared.images.length} image(s)…`;
        const files: FileChange[] = [];
        for (const image of prepared.images) {
          files.push({
            path: image.path,
            contentBase64: await blobToBase64(image.blob),
          });
        }
        await f.commitFiles(repo.owner, repo.name, files, "Add source images");
      }
      // Only a run that had something to upload replaces what the step already
      // produced. A pass with nothing picked — a retry, or a continued setup,
      // whose files cannot be picked again — keeps the images the repository
      // already holds instead of emptying them.
      if (hasUpload) {
        wizard.images = prepared.images;
        // Converted encodings are written with the pieces in the final step, so
        // they only need carrying forward.
        wizard.encodings = prepared.encodings;
      }

      progress = null;
      busy = false;
      nextStep();
    } catch (err) {
      console.error("Upload step failed:", (err as Error).message);
      error = wizard.repo
        ? `The repository ${wizard.repo.full_name} was created, but the upload didn't finish: ${(err as Error).message}`
        : `Could not process the upload: ${(err as Error).message}`;
      progress = null;
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
      working if the source server does not.
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
  {#if progress}
    <p class="msg-progress" role="status" aria-live="polite">{progress}</p>
  {/if}
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
