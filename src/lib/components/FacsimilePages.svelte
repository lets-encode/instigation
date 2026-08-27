<!--
  The campaign's page images, filling the material pane beside the metadata
  step so the organiser can read the source while describing it. The pages are
  committed by this point: this view is for reference, nothing here edits
  them. How many pages a row holds is the zoom: one per row fills the pane
  with a single page.

  The images are the pages the pages step committed, as object URLs —
  the committed copies are in the repository, but reading them back would cost
  a round trip per page for something already in memory. Using the prepared
  pages rather than the raw upload also covers PDFs and IIIF canvases, whose
  page images exist nowhere else in the browser. The URLs are revoked when the
  panel goes away.

  Pages always sit on paper-light ground: a scanned score is ink on paper, and
  tinting it to match a dark UI would misrepresent the source.
-->
<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import type { PageImage } from "$lib/prepare-images.ts";
  import PagesPerRow from "./PagesPerRow.svelte";
  import ZoomLevel from "./ZoomLevel.svelte";

  // `toolbar` renders extra controls at the end of the toolbar.
  let { pages, toolbar }: { pages: PageImage[]; toolbar?: Snippet } = $props();

  // One page per row: the imprint has to be readable while it is copied into
  // the form beside it.
  let perRow = $state(1);
  let zoom = $state(100);

  // One object URL per page, cached so a re-render hands the same <img> the same
  // src. Revoking eagerly when the list changes would pull the URL out from
  // under an image that has not finished decoding, so they are all released
  // together when the panel is destroyed instead.
  const objectUrls = new Map<Blob, string>();
  const urls = $derived(
    pages.map((page) => {
      let url = objectUrls.get(page.blob);
      if (!url) {
        url = URL.createObjectURL(page.blob);
        objectUrls.set(page.blob, url);
      }
      return url;
    })
  );
  onDestroy(() => {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  });
</script>

{#if pages.length}
  <div class="material-card">
    <div class="material-toolbar">
      <span
        class="toolbar-name"
        title="The pages kept in the Pages step, shown here to read from while filling the form."
        >{pages.length} page{pages.length === 1 ? "" : "s"}</span
      >
      <div class="toolbar-gap"></div>
      <PagesPerRow bind:value={perRow} />
      <ZoomLevel bind:value={zoom} />
      {#if toolbar}{@render toolbar()}{/if}
    </div>
    <div class="material-body">
      <div class="material-grid" style="--per-row: {perRow}; width: {zoom}%">
        {#each urls as url, i (url)}
          <figure>
            <img src={url} alt="Page {i + 1}" />
            <figcaption class="page-caption">p. {i + 1}</figcaption>
          </figure>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  figure {
    min-width: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  img {
    display: block;
    width: 100%;
    height: auto;
    box-sizing: border-box;
    /* Scanned pages keep their own light ground in either theme. */
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: var(--shadow-sm);
  }
</style>
