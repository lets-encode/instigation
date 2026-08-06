<!--
  Setups started in this browser and not finished. The wizard mirrors its entries
  into the browser's storage as they are entered, so one can be picked up here.

  Continuing loads the entries back into the wizard and opens it at /new, on
  the step the setup was left on. When the campaign's repository already
  exists, the page images it holds are read back from it first: their bytes
  are not kept between visits.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth, forge } from "$lib/auth.svelte.ts";
  import {
    MissingDraftImageError,
    discardDraft,
    fetchDraftImages,
    readDraft,
    resumableDrafts,
    type WizardDraft,
  } from "$lib/wizard-draft.ts";
  import { releaseClaim } from "$lib/campaign-resolve.ts";
  import { WIZARD_STEPS, applyDraft, stepIndex } from "$lib/wizard.svelte.ts";
  import type { PageImage } from "$lib/prepare-images.ts";

  let drafts = $state<WizardDraft[]>([]);
  let busy = $state<string | null>(null);
  let confirming = $state<string | null>(null);
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    const owner = auth.user?.login;
    drafts = owner ? resumableDrafts(owner) : [];
  });

  /** "step x of y" for the step a draft was left on. */
  function stepLine(draft: WizardDraft): string {
    const step = draft.entries?.step;
    if (!step) return "";
    return `wizard step ${stepIndex(step) + 1} of ${WIZARD_STEPS.length}`;
  }

  async function continueSetup(draft: WizardDraft) {
    if (busy) return;
    error = null;
    confirming = null;
    busy = draft.handle;
    try {
      // The listing is read once, and this setup may have been finished or
      // discarded in another tab since. The stored record decides, not the row.
      const stored = readDraft(draft.handle);
      if (!stored) {
        drafts = drafts.filter((d) => d.handle !== draft.handle);
        throw new Error("it has since been finished or discarded in this browser");
      }
      const paths = stored.entries.imagePaths;
      let images: PageImage[] = [];
      if (stored.repo && paths.length) {
        const client = forge();
        if (!client) throw new Error("you are no longer signed in");
        try {
          images = await fetchDraftImages(
            client,
            stored.repo,
            paths,
            (done, total) => (progress = `Loading page ${done} of ${total}…`),
          );
        } catch (err) {
          // Pages that are not in the repository any more cannot be read back,
          // but they can be uploaded again: the setup continues from the upload
          // step, which is where applyDraft puts a setup without its images.
          if (!(err instanceof MissingDraftImageError)) throw err;
          images = [];
        }
      }
      applyDraft(stored, images);
      await goto("/new");
    } catch (err) {
      console.error("Continuing a setup failed:", (err as Error).message);
      error = `Could not continue “${draft.handle}”: ${(err as Error).message}`;
    }
    busy = null;
    progress = null;
  }

  async function discard(draft: WizardDraft) {
    discardDraft(draft.handle);
    drafts = drafts.filter((d) => d.handle !== draft.handle);
    confirming = null;
    // Give the name back, so it is free again straight away instead of staying
    // reserved until the reservation runs out on its own.
    if (draft.claim) await releaseClaim(draft.claim.name, draft.claim.token);
  }
</script>

{#if drafts.length}
  <section class="drafts">
    {#each drafts as draft (draft.handle)}
      <div class="drow">
        <span class="dlabel">Drafts</span>
        <span class="dline">
          {draft.entries?.title?.trim() || draft.handle} — {stepLine(draft)} ·
          {draft.handle}
        </span>
        <button
          type="button"
          class="linkish"
          onclick={() => continueSetup(draft)}
          disabled={busy !== null}
        >
          {busy === draft.handle ? "Working…" : "Resume →"}
        </button>
        <span class="spacer"></span>
        {#if confirming === draft.handle}
          <span class="dnote">
            {#if draft.repo}
              Discarding frees the name but leaves the repository
              <a href={draft.repo.html_url} target="_blank" rel="noreferrer"
                >{draft.repo.full_name}</a
              > — delete it yourself if you don't want it.
            {/if}
          </span>
          <button
            type="button"
            class="linkish danger"
            onclick={() => discard(draft)}
            disabled={busy !== null}
          >
            Discard for good
          </button>
        {:else}
          <button
            type="button"
            class="linkish quiet"
            onclick={() => (confirming = draft.handle)}
            disabled={busy !== null}
          >
            Discard
          </button>
        {/if}
      </div>
    {/each}

    {#if error}
      <p class="msg-error" role="alert">{error}</p>
    {/if}
    {#if progress}
      <p class="msg-progress" role="status" aria-live="polite">{progress}</p>
    {/if}
  </section>
{/if}

<style>
  .drafts {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .drow {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: color-mix(in srgb, var(--card) 70%, transparent);
    border: 1px dashed var(--line-input);
    border-radius: 10px;
    min-width: 0;
  }
  .dlabel {
    font-size: 12px;
    font-weight: 700;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .dline {
    font-size: 13px;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dnote {
    font-size: 12px;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .dnote a {
    color: var(--link);
  }
  .spacer {
    flex: 1;
  }
  .linkish {
    flex: none;
    font: 600 12.5px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .linkish.quiet {
    color: var(--ink-faint);
    font-weight: 400;
  }
  .linkish.danger {
    color: var(--danger);
  }
  .linkish:hover:not(:disabled) {
    text-decoration: underline;
  }
  .linkish:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
