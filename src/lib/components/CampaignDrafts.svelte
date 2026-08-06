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

  /** The label of the step a draft was left on, for describing where it stopped. */
  function stepLabel(draft: WizardDraft): string {
    const step = draft.entries?.step;
    return (step && WIZARD_STEPS[stepIndex(step)]?.label) || "";
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
    <h2>Unfinished setups</h2>
    <ul>
      {#each drafts as draft (draft.handle)}
        <li>
          <div class="row">
            <span class="name">{draft.entries?.title?.trim() || draft.handle}</span>
            <span class="where" title="The step this setup was left on">
              {draft.handle} — stopped at {stepLabel(draft)}
            </span>
            <div class="controls">
              <button
                type="button"
                class="btn btn-soft"
                onclick={() => continueSetup(draft)}
                disabled={busy !== null}
              >
                {busy === draft.handle ? "Working…" : "Continue setup"}
              </button>
              {#if confirming === draft.handle}
                <button
                  type="button"
                  class="btn btn-quiet btn-danger"
                  onclick={() => discard(draft)}
                  disabled={busy !== null}
                >
                  Discard for good
                </button>
              {:else}
                <button
                  type="button"
                  class="btn btn-quiet"
                  onclick={() => (confirming = draft.handle)}
                  disabled={busy !== null}
                >
                  Discard
                </button>
              {/if}
            </div>
          </div>
          {#if draft.repo}
            <p class="repo">
              Its repository <a href={draft.repo.html_url} target="_blank" rel="noreferrer">
                {draft.repo.full_name}
              </a> exists already, and is completed by finishing the setup.
              {#if confirming === draft.handle}
                Discarding frees the name but leaves the repository — delete it
                yourself if you don't want it.
              {/if}
            </p>
          {/if}
        </li>
      {/each}
    </ul>

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
    max-width: 640px;
    margin: 0 auto 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--line);
  }
  h2 {
    font-size: 1.15rem;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .name {
    font-weight: 600;
  }
  .where {
    font-size: 0.8rem;
    color: var(--ink-faint);
  }
  .controls {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
  }
  .repo {
    margin: 0.35rem 0 0;
    font-size: 0.85rem;
    color: var(--ink-soft);
  }
</style>
