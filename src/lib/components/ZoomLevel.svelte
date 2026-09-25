<!--
  Zoom for a pane of pages, in percent. The pages' grid is laid out at this
  share of the pane's width, so above 100% it grows past the pane and scrolls.

  A fit keeps the zoom at a computed value until the slider is moved: the width
  fit is 100%; the page fit is the zoom the pane's owner computes with
  `fitPageZoom`, at which a whole page is visible top to bottom.
-->
<script module lang="ts">
  /**
   * The zoom, in percent, at which the tallest page of a material grid fits the
   * body top to bottom. The grid's padding, gap and the height a tile needs
   * beyond its image (caption and border) are the ones ui.css and the page
   * figures give them. Capped at the width fit, so a page never grows past the
   * body's width.
   */
  export function fitPageZoom(
    bodyW: number,
    bodyH: number,
    perRow: number,
    aspects: number[],
  ): number {
    const PAD = 16;
    const GAP = 14;
    const TILE_EXTRA = 20;
    const aspect = Math.max(...aspects.filter((a) => a > 0));
    if (!bodyW || !bodyH || !isFinite(aspect)) return 100;
    const tileW = (bodyH - 2 * PAD - TILE_EXTRA) / aspect;
    const gridW = tileW * perRow + GAP * (perRow - 1) + 2 * PAD;
    return Math.min(100, Math.max(1, Math.floor((gridW / bodyW) * 100)));
  }
</script>

<script lang="ts">
  import FitIcon from "./FitIcon.svelte";

  let {
    value = $bindable(),
    least = 50,
    most = 400,
    fitPage,
    fit = $bindable(null),
  }: {
    /** Percent, between `least` and `most`. */
    value: number;
    least?: number;
    most?: number;
    /** The page-fit zoom in percent. Without it there is no page fit. */
    fitPage?: number;
    /** The fit in force, if any. */
    fit?: "width" | "page" | null;
  } = $props();

  $effect(() => {
    if (fit === "width") value = 100;
    else if (fit === "page" && fitPage !== undefined)
      value = Math.max(least, fitPage);
  });

  // The slider runs on a log scale: equal drags multiply the zoom equally,
  // so the low end moves in fine steps and the high end in coarse ones.
  const STOPS = 100;
  const pos = $derived(
    Math.round((Math.log(value / least) / Math.log(most / least)) * STOPS),
  );
  const setPos = (p: number) =>
    (value = Math.round(least * (most / least) ** (p / STOPS)));
</script>

<span class="zoomctl">
  <input
    class="zoomslider"
    type="range"
    aria-label="Zoom"
    aria-valuetext={`${value}%`}
    min={0}
    max={STOPS}
    step={1}
    value={pos}
    oninput={(e) => {
      setPos(Number((e.target as HTMLInputElement).value));
      fit = null;
    }}
  />
  <span class="zval">{value}%</span>
  <button
    type="button"
    class="tbtn tbtn-icon"
    class:on={fit === "width"}
    onclick={() => (fit = "width")}
    aria-label="Fit the page width"
    title="Fit the page width to the pane"><FitIcon kind="width" /></button
  >
  {#if fitPage !== undefined}
    <button
      type="button"
      class="tbtn tbtn-icon"
      class:on={fit === "page"}
      onclick={() => (fit = "page")}
      aria-label="Fit the whole page"
      title="Fit the whole page in the pane, top to bottom"
      ><FitIcon kind="page" /></button
    >
  {/if}
</span>

<style>
  .zoomctl {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
