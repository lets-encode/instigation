<!--
  Wizard step 4: which pages of the upload the campaign encodes, and in what
  order. A source is routinely larger than the part of it being encoded — a few
  pages of a long PDF, one piece out of a digitised volume — so the pages the
  previous step read are shown here as previews to choose between, and can be
  moved into reading order.

  This is where the campaign repository is created, under the name the first step
  reserved: on Continue the chosen pages are fetched or rendered at committing
  size — and only those, so an unchosen page costs nothing — and committed, so
  later steps work against a real repository. The reservation keeps the name
  through all of this; it is registered as a campaign by the final step, once
  there is a campaign to register. Configuration, tracking tables and the piece
  MEIs are written there too, not here. Because the repository outlives a failure
  after it exists, a retry re-runs only the commit rather than creating a second
  one.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { auth, forge } from "$lib/auth.svelte.ts";
  import { provider } from "$lib/forge/config.ts";
  import { resolvePages, blobToBase64 } from "$lib/prepare-images.ts";
  import { wizard, nextStep, previousStep } from "$lib/wizard.svelte.ts";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import type { FileChange } from "$lib/forge/types.ts";
  import WizardCard from "./WizardCard.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";

  let busy = $state(false);
  let error = $state<string | null>(null);
  const log = new ProgressLog();

  // The page a range selection is measured from: the last one clicked on its own.
  let anchor: number | null = null;
  let dragIndex = $state<number | null>(null);

  // One object URL per preview, cached so a re-render — a reorder, a change of
  // selection — hands the same <img> the same src. They are all released together
  // when the step goes away.
  const objectUrls = new Map<Blob, string>();
  const urls = $derived(
    wizard.candidates.map((page) => {
      let url = objectUrls.get(page.preview);
      if (!url) {
        url = URL.createObjectURL(page.preview);
        objectUrls.set(page.preview, url);
      }
      return url;
    }),
  );
  onDestroy(() => {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  });

  const chosen = $derived(wizard.candidates.filter((page) => page.include));
  // The number each kept page is committed under, so the numbering shown is the
  // one the campaign will have. A page left out has none.
  const numbers = $derived.by(() => {
    let n = 0;
    return wizard.candidates.map((page) => (page.include ? ++n : 0));
  });

  // The repository's "About" carries the campaign's title and description
  // together. GitHub rejects a description longer than 350 characters.
  const repoAbout = $derived(
    [wizard.title.trim(), wizard.description.trim()]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 350),
  );

  // A repository from a failed attempt means the commit is being retried.
  const continueLabel = $derived(
    busy
      ? "Working…"
      : wizard.repo
        ? "Retry"
        : chosen.length
          ? `Use ${chosen.length} page${chosen.length === 1 ? "" : "s"}`
          : "Continue without pages",
  );

  /**
   * Keep or leave out a page. Holding shift extends from the page last clicked
   * on its own, so a run of pages in a long source is chosen in two clicks.
   */
  function toggle(index: number, extend: boolean) {
    const include = !wizard.candidates[index].include;
    const from = extend && anchor !== null ? Math.min(anchor, index) : index;
    const to = extend && anchor !== null ? Math.max(anchor, index) : index;
    for (let i = from; i <= to; i++) wizard.candidates[i].include = include;
    anchor = index;
  }

  function setAll(include: boolean) {
    for (const page of wizard.candidates) page.include = include;
    anchor = null;
  }

  /** Move a page to another position, taking the rest along. */
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= wizard.candidates.length) return;
    const pages = [...wizard.candidates];
    const [page] = pages.splice(from, 1);
    pages.splice(to, 0, page);
    wizard.candidates = pages;
    anchor = null;
  }

  async function commitAndContinue() {
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

    busy = true;
    log.clear();
    try {
      // Fetching and rendering happens before the repository is created, so an
      // upload that cannot be read leaves nothing behind.
      const pages = chosen.map(({ include, ...page }) => page);
      const images = pages.length
        ? await resolvePages(
            pages,
            ({ step, detail }) => {
              if (step) log.step(step);
              if (detail) log.detail(detail);
            },
            { brokerUrl: provider.brokerUrl },
          )
        : [];

      // The repository may already exist from an earlier attempt that failed
      // after creating it; reuse it rather than creating a second one.
      let repo = wizard.repo;
      if (!repo) {
        log.step("Creating the repository");
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

        // The listing topic is not stamped here: it marks a campaign, and this
        // repository is not one until the final step has set it up.
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

      // Generating from a template is asynchronous — wait until the repo has
      // contents before committing onto it.
      log.step("Waiting for the repository");
      await f.waitForRepoContents(
        repo.owner,
        repo.name,
        "templates/score.template.mei",
      );

      if (images.length) {
        log.step(`Committing ${images.length} image(s)`);
        const files: FileChange[] = [];
        for (const image of images) {
          log.detail(`encoding ${image.path} (${files.length + 1} of ${images.length})`);
          files.push({
            path: image.path,
            contentBase64: await blobToBase64(image.blob),
          });
        }
        log.detail("uploading");
        await f.commitFiles(repo.owner, repo.name, files, "Add source images");
      }
      // Only a run that had pages to choose from replaces what the step already
      // produced. A continued setup, whose files cannot be picked again, keeps
      // the images the repository already holds instead of emptying them.
      if (wizard.candidates.length) wizard.images = images;

      log.done();
      busy = false;
      nextStep();
    } catch (err) {
      console.error("Pages step failed:", (err as Error).message);
      error = wizard.repo
        ? `The repository ${wizard.repo.full_name} was created, but the upload didn't finish: ${(err as Error).message}`
        : `Could not commit the pages: ${(err as Error).message}`;
      log.fail();
      busy = false;
    }
  }
</script>

<WizardCard
  step="pages"
  heading="Choose the pages"
  intro="Keep the pages the campaign encodes and put them in reading order. Only the pages you keep are downloaded at full size and committed."
  onBack={previousStep}
  backDisabled={busy}
  onNext={commitAndContinue}
  nextDisabled={busy}
  nextLabel={continueLabel}
>
  {#if !wizard.candidates.length}
    <p class="note">
      There are no page images in this upload.
      {#if wizard.encodings.length}
        Its {wizard.encodings.length} encoding(s) become pieces in their own
        right, and need no pages chosen.
      {/if}
      Continuing creates the campaign's repository.
    </p>
  {:else}
    <div class="bar">
      <span class="count">
        {chosen.length} of {wizard.candidates.length} pages kept
      </span>
      <span class="controls">
        <button
          type="button"
          class="btn btn-quiet"
          onclick={() => setAll(true)}
          disabled={busy}
        >
          Keep all
        </button>
        <button
          type="button"
          class="btn btn-quiet"
          onclick={() => setAll(false)}
          disabled={busy}
        >
          Keep none
        </button>
      </span>
    </div>
    <p class="hint">
      Click a page to keep it or leave it out; shift-click to do the same to a
      run of pages. Drag a page, or use its arrows, to move it.
    </p>

    <ol class="grid">
      {#each wizard.candidates as page, i (page.id)}
        <li
          class:out={!page.include}
          class:dragging={dragIndex === i}
          draggable={!busy}
          ondragstart={() => (dragIndex = i)}
          ondragend={() => (dragIndex = null)}
          ondragover={(e) => e.preventDefault()}
          ondrop={(e) => {
            e.preventDefault();
            if (dragIndex !== null) move(dragIndex, i);
            dragIndex = null;
          }}
        >
          <button
            type="button"
            class="thumb"
            aria-pressed={page.include}
            disabled={busy}
            title={page.label}
            onclick={(e) => toggle(i, e.shiftKey)}
          >
            <img src={urls[i]} alt={page.label} />
            <span class="mark" aria-hidden="true">
              {page.include ? numbers[i] : "—"}
            </span>
          </button>
          <span class="label">{page.label}</span>
          <span class="move">
            <button
              type="button"
              class="btn btn-quiet"
              disabled={busy || i === 0}
              aria-label="Move {page.label} earlier"
              onclick={() => move(i, i - 1)}
            >
              ←
            </button>
            <button
              type="button"
              class="btn btn-quiet"
              disabled={busy || i === wizard.candidates.length - 1}
              aria-label="Move {page.label} later"
              onclick={() => move(i, i + 1)}
            >
              →
            </button>
          </span>
        </li>
      {/each}
    </ol>
  {/if}

  {#if error}
    <p class="msg-error" role="alert">{error}</p>
  {/if}
  <ProgressSteps {log} />
</WizardCard>

<style>
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .count {
    font-size: 0.9rem;
    font-weight: 600;
  }
  .controls {
    display: flex;
    gap: 0.4rem;
  }
  .grid {
    /* A long source is many pages, so the grid scrolls inside the card rather
       than pushing the step's controls out of reach. */
    max-height: 55vh;
    overflow: auto;
    list-style: none;
    margin: 1rem 0 0;
    padding: 0.25rem;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
    gap: 0.75rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg-alt);
  }
  .grid li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
  }
  .grid li.dragging {
    opacity: 0.4;
  }
  .thumb {
    position: relative;
    display: block;
    width: 100%;
    padding: 0.25rem;
    background: var(--card);
    border: 2px solid var(--accent);
    border-radius: 6px;
    cursor: pointer;
  }
  li.out .thumb {
    border-color: var(--line);
  }
  li.out img {
    opacity: 0.35;
  }
  .thumb img {
    display: block;
    width: 100%;
    height: 7rem;
    object-fit: contain;
    /* Scanned pages keep their own white ground in either theme. */
    background: var(--facsimile-paper);
  }
  .mark {
    position: absolute;
    top: 0.35rem;
    left: 0.35rem;
    min-width: 1.3rem;
    padding: 0 0.2rem;
    font-size: 0.75rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    /* Reads against the accent in either theme, as the step header's dots do. */
    color: var(--card);
    background: var(--accent);
    border-radius: 999px;
  }
  li.out .mark {
    color: var(--ink-soft);
    background: var(--line);
  }
  .label {
    max-width: 100%;
    font-size: 0.72rem;
    color: var(--ink-faint);
    text-align: center;
    overflow-wrap: anywhere;
  }
  .move {
    display: flex;
    gap: 0.2rem;
  }
  .move button {
    padding: 0.1rem 0.4rem;
    line-height: 1.2;
  }
</style>
