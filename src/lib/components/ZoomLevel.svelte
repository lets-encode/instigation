<!--
  Zoom for a pane of pages, in percent. The pages' grid is laid out at this
  share of the pane's width, so above 100% it grows past the pane and scrolls.
-->
<script lang="ts">
  let {
    value = $bindable(),
    least = 50,
    most = 400,
  }: {
    /** Percent, between `least` and `most`. */
    value: number;
    least?: number;
    most?: number;
  } = $props();

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
    type="range"
    aria-label="Zoom"
    aria-valuetext={`${value}%`}
    min={0}
    max={STOPS}
    step={1}
    value={pos}
    oninput={(e) => setPos(Number((e.target as HTMLInputElement).value))}
  />
  <span class="level">{value}%</span>
</span>

<style>
  .zoomctl {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input[type="range"] {
    width: 120px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .level {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    white-space: nowrap;
    min-width: 38px;
    text-align: right;
  }
</style>
