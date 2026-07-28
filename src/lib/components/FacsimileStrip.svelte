<!--
  A continuous left-to-right strip of the campaign's page images, filling the
  lower pane beneath the metadata steps so the organiser can read the source
  while describing it.

  The images are the pages the pages step committed, as object URLs —
  the committed copies are in the repository, but reading them back would cost
  a round trip per page for something already in memory. Using the prepared
  pages rather than the raw upload also covers PDFs and IIIF canvases, whose
  page images exist nowhere else in the browser. The URLs are revoked when the
  strip goes away.

  Pages always sit on white: a scanned score is ink on paper, and tinting it to
  match a dark UI would misrepresent the source.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import type { PageImage } from "$lib/prepare-images.ts";
  import BottomPane from "./BottomPane.svelte";

  let { pages }: { pages: PageImage[] } = $props();

  let zoom = $state(1);

  // Each page's shape decides how wide its slot in the strip is, and it is only
  // known once the browser has decoded the image, so it is read from there.
  let ratios = $state<Record<number, string>>({});

  // One object URL per page, cached so a re-render hands the same <img> the same
  // src. Revoking eagerly when the list changes would pull the URL out from
  // under an image that has not finished decoding, so they are all released
  // together when the strip is destroyed instead.
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
  <BottomPane label="Source pages">
    <div class="strip-bar">
      <span class="count">{pages.length} page{pages.length === 1 ? "" : "s"}</span>
      <div class="zoom">
        <button
          type="button"
          class="btn btn-quiet"
          onclick={() => (zoom = Math.max(zoom / 1.25, 0.25))}
          aria-label="Zoom out"
        >
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          class="btn btn-quiet"
          onclick={() => (zoom = Math.min(zoom * 1.25, 4))}
          aria-label="Zoom in"
        >
          +
        </button>
      </div>
    </div>

    <div class="page-strip">
      {#each urls as url, i (url)}
        <figure style="height: {100 * zoom}%; --page-ratio: {ratios[i] ?? 'auto'}">
          <img
            src={url}
            alt="Page {i + 1}"
            onload={(e) =>
              (ratios[i] = `${e.currentTarget.naturalWidth} / ${e.currentTarget.naturalHeight}`)}
          />
          <figcaption>{i + 1}</figcaption>
        </figure>
      {/each}
    </div>
  </BottomPane>
{/if}

<style>
  .strip-bar {
    font-size: 0.8rem;
    color: var(--ink-faint);
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .zoom button {
    line-height: 1;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    background: var(--card);
    border-radius: 4px;
  }
  img {
    /* Takes the height the figure has left over the caption, and the width that
       follows from it. */
    flex: 1;
    min-height: 0;
    width: auto;
    max-width: 100%;
    display: block;
    /* Scanned pages keep their own white ground in either theme. */
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
  }
</style>
