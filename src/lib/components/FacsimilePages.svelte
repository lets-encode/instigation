<!--
  The campaign's page images, in rows beside the metadata steps so the organiser
  can read the source while describing it. How many pages a row holds is the
  zoom: one per row fills the pane with a single page.

  The images are the pages the pages step committed, as object URLs —
  the committed copies are in the repository, but reading them back would cost
  a round trip per page for something already in memory. Using the prepared
  pages rather than the raw upload also covers PDFs and IIIF canvases, whose
  page images exist nowhere else in the browser. The URLs are revoked when the
  panel goes away.

  Pages always sit on white: a scanned score is ink on paper, and tinting it to
  match a dark UI would misrepresent the source.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import type { PageImage } from "$lib/prepare-images.ts";
  import SidePane from "./SidePane.svelte";
  import PagesPerRow from "./PagesPerRow.svelte";

  let { pages }: { pages: PageImage[] } = $props();

  let perRow = $state(1);

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
  <SidePane label="Source pages">
    <div class="pane-bar">
      <span class="count">{pages.length} page{pages.length === 1 ? "" : "s"}</span>
      <PagesPerRow bind:value={perRow} />
    </div>

    <div class="page-grid" style="--per-row: {perRow}">
      {#each urls as url, i (url)}
        <figure>
          <img src={url} alt="Page {i + 1}" />
          <figcaption>{i + 1}</figcaption>
        </figure>
      {/each}
    </div>
  </SidePane>
{/if}

<style>
  .count {
    font-size: 0.8rem;
    color: var(--ink-faint);
  }
  img {
    display: block;
    width: 100%;
    height: auto;
    /* Scanned pages keep their own white ground in either theme. */
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
  }
</style>
