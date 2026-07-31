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
  import { IMAGE_DIR, resolvePages, blobToBase64 } from "$lib/prepare-images.ts";
  import {
    wizard,
    draftSnapshot,
    saveDraft,
    nextStep,
    previousStep,
  } from "$lib/wizard.svelte.ts";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import type { FileChange } from "$lib/forge/types.ts";
  import WizardCard from "./WizardCard.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";
  import PagesPerRow from "./PagesPerRow.svelte";

  let busy = $state(false);
  let error = $state<string | null>(null);
  // Whether the commit has been attempted here and stopped part way, which is
  // what makes the next press a retry of it.
  let failed = $state(false);
  const log = new ProgressLog();

  let perRow = $state(4);

  // The page a range selection is measured from: the last one clicked on its own.
  let anchor: number | null = null;
  // The page being dragged, and the one it is currently over.
  let dragIndex = $state<number | null>(null);
  let overIndex = $state<number | null>(null);

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

  // Only an attempt that stopped part way is a retry. A repository that already
  // exists otherwise — a setup continued from a draft, a second pass through this
  // step — is committed to the same way a new one is, so it reads the same.
  const continueLabel = $derived(
    busy
      ? "Working…"
      : failed
        ? "Retry"
        : chosen.length
          ? `Use ${chosen.length} page${chosen.length === 1 ? "" : "s"}`
          : "Continue without pages",
  );

  // The material toolbar names what the pages came from.
  const sourceName = $derived(
    wizard.files.length === 1
      ? wizard.files[0].name
      : wizard.files.length
        ? `${wizard.files.length} files`
        : wizard.iiifManifestUrl.trim() || "",
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
    failed = false;
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
        // The repository exists from here on, whatever happens next. The draft is
        // stored on a debounce as entries change, which is too late for this: a
        // setup continued without it would try to create a second repository
        // under a name this one already has.
        saveDraft(user.login, draftSnapshot());

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

      // Pages the repository holds that this selection does not: the chosen ones
      // are committed over the paths they had, but a shorter selection, or one
      // whose pages are named differently, would leave the rest behind. The
      // repository is asked rather than this browser, so pages committed by an
      // attempt whose images are not held here are removed too.
      //
      // Only a run that had pages to choose from removes any: a continued setup
      // cannot pick its files again, and reaches this step with nothing chosen,
      // which says nothing about what the campaign's pages should be.
      let stale: string[] = [];
      if (wizard.candidates.length) {
        log.step("Reading the pages already committed", { timed: false });
        const held = await f.getDirDownloadUrls(repo.owner, repo.name, IMAGE_DIR);
        stale = Object.keys(held)
          .map((name) => `${IMAGE_DIR}/${name}`)
          .filter((path) => !images.some((image) => image.path === path));
      }

      if (images.length || stale.length) {
        log.step(`Committing ${images.length} image(s)`);
        const files: FileChange[] = [];
        for (const image of images) {
          log.detail(`encoding ${files.length + 1}/${images.length}`);
          files.push({
            path: image.path,
            contentBase64: await blobToBase64(image.blob),
          });
        }
        if (stale.length) log.detail(`removing ${stale.length} page(s) not kept`);
        log.detail(`uploading 0/${images.length}`);
        await f.commitFiles(
          repo.owner,
          repo.name,
          files,
          wizard.images.length ? "Update source images" : "Add source images",
          {
            deletePaths: stale,
            onUpload: (done, total) => log.detail(`uploading ${done}/${total}`),
          },
        );
      }
      // Only a run that had pages to choose from replaces what the step already
      // produced. A continued setup, whose files cannot be picked again, keeps
      // the images the repository already holds instead of emptying them.
      if (wizard.candidates.length) wizard.images = images;
      // Which pages the repository holds has just changed; the draft records
      // their paths, and is read back against the repository when a setup is
      // continued, so it is stored before the step moves on.
      saveDraft(user.login, draftSnapshot());

      log.done();
      busy = false;
      nextStep();
    } catch (err) {
      console.error("Pages step failed:", (err as Error).message);
      error = wizard.repo
        ? `The repository ${wizard.repo.full_name} was created, but the upload didn't finish: ${(err as Error).message}`
        : `Could not commit the pages: ${(err as Error).message}`;
      log.fail();
      failed = true;
      busy = false;
    }
  }
</script>

<WizardCard
  step="pages"
  heading="Choose the pages"
  intro="Keep what gets encoded, in reading order. Only the pages you keep are downloaded at full size and committed."
  status="{chosen.length} of {wizard.candidates.length} kept"
  materialHint="There are no page images in this upload."
  onBack={previousStep}
  backDisabled={busy}
  onNext={commitAndContinue}
  nextDisabled={busy}
  nextLabel={continueLabel}
>
  {#snippet material()}
    {#if wizard.candidates.length}
      <div class="material-card">
        <div class="material-toolbar">
          {#if sourceName}
            <span class="toolbar-name">{sourceName}</span>
          {/if}
          <div class="toolbar-gap"></div>
          <PagesPerRow bind:value={perRow} />
          <div class="toolbar-rule"></div>
          <button type="button" class="tbtn" onclick={() => setAll(true)} disabled={busy}>
            Keep all
          </button>
          <button type="button" class="tbtn" onclick={() => setAll(false)} disabled={busy}>
            Keep none
          </button>
        </div>
        <ol class="material-body material-grid" style="--per-row: {perRow}">
          {#each wizard.candidates as page, i (page.id)}
            <li
              class:out={!page.include}
              class:dragging={dragIndex === i}
              class:drop-before={dragIndex !== null && overIndex === i && dragIndex > i}
              class:drop-after={dragIndex !== null && overIndex === i && dragIndex < i}
              ondragover={(e) => {
                if (dragIndex === null) return;
                // Accepting the drag is what makes this position a drop target.
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                overIndex = i;
              }}
              ondragleave={() => {
                if (overIndex === i) overIndex = null;
              }}
              ondrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) move(dragIndex, i);
                dragIndex = null;
                overIndex = null;
              }}
            >
              <button
                type="button"
                class="thumb"
                aria-pressed={page.include}
                disabled={busy}
                title={page.label}
                draggable={!busy}
                onclick={(e) => toggle(i, e.shiftKey)}
                ondragstart={(e) => {
                  dragIndex = i;
                  // Firefox starts a drag only once the transfer carries data.
                  e.dataTransfer?.setData("text/plain", String(i));
                  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                }}
                ondragend={() => {
                  dragIndex = null;
                  overIndex = null;
                }}
              >
                <!-- An image is draggable in its own right, which would drag the
                     picture instead of the page. -->
                <img src={urls[i]} alt={page.label} draggable="false" />
                <span class="mark" aria-hidden="true">
                  {page.include ? numbers[i] : "—"}
                </span>
                {#if !page.include}
                  <span class="left-out" aria-hidden="true"><span>left out</span></span>
                {/if}
              </button>
              <span class="page-caption">p. {i + 1}</span>
            </li>
          {/each}
        </ol>
      </div>
    {/if}
  {/snippet}

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
    <div class="count-row">
      <span class="count">{chosen.length}</span>
      <span class="count-of">of {wizard.candidates.length} pages kept</span>
    </div>
    <div class="progress">
      <div
        class="progress-fill"
        style="width: {wizard.candidates.length
          ? (chosen.length / wizard.candidates.length) * 100
          : 0}%"
      ></div>
    </div>
    <ul class="how">
      <li>Click a page to keep or leave it out</li>
      <li>Shift-click marks a whole run</li>
      <li>Drag a page to move it</li>
    </ul>
  {/if}

  <div class="spacer"></div>

  {#if error}
    <p class="msg-error" role="alert">{error}</p>
  {/if}
  <ProgressSteps {log} />
</WizardCard>

<style>
  .note {
    margin: 22px 0 0;
    font-size: 13.5px;
    color: var(--ink-soft);
  }
  .count-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 22px;
  }
  .count {
    font-size: 34px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .count-of {
    font-size: 14px;
    color: var(--ink-faint);
  }
  .progress {
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    margin-top: 10px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .how {
    list-style: none;
    margin: 22px 0 0;
    padding: 0;
    display: grid;
    gap: 9px;
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .spacer {
    flex: 1;
  }

  /* ---- Page tiles in the material pane ---- */
  ol.material-grid {
    list-style: none;
    margin: 0;
  }
  li {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  li.dragging {
    opacity: 0.4;
  }
  /* Where the dragged page lands: before or after the page it is over. */
  li.drop-before::before,
  li.drop-after::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    width: 3px;
    background: var(--accent);
    border-radius: 2px;
    z-index: 1;
  }
  li.drop-before::before {
    left: -8px;
  }
  li.drop-after::after {
    right: -8px;
  }
  .thumb {
    position: relative;
    display: block;
    width: 100%;
    padding: 0;
    background: var(--facsimile-paper);
    border: 1px solid var(--accent-line);
    border-radius: 6px;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    cursor: pointer;
    /* Safari drags an element from a form control only when told to. */
    -webkit-user-drag: element;
  }
  li.out .thumb {
    border-color: var(--line);
    opacity: 0.8;
  }
  li.out img {
    opacity: 0.55;
  }
  .thumb img {
    display: block;
    width: 100%;
    /* The preview takes its tile's width, so the zoom level sets how large a
       page is shown; the proportions of a page hold it to a fixed height. */
    aspect-ratio: 0.73;
    object-fit: contain;
  }
  .mark {
    position: absolute;
    top: 8px;
    left: 8px;
    box-sizing: border-box;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: #fff;
    background: var(--accent-btn);
    border-radius: 10px;
  }
  li.out .mark {
    color: var(--ink-faint);
    background: var(--line);
  }
  /* Diagonal stripes and a pill over a page that is left out. */
  .left-out {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: repeating-linear-gradient(
      45deg,
      rgba(121, 128, 154, 0.08) 0 8px,
      transparent 8px 16px
    );
  }
  .left-out span {
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-faint);
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    padding: 3px 10px;
  }
</style>
