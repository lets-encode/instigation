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

  const STEP = 25;
</script>

<span class="stepper">
  <button
    type="button"
    aria-label="Zoom out"
    disabled={value <= least}
    onclick={() => (value = Math.max(least, value - STEP))}
  >
    −
  </button>
  <span class="level">{value}%</span>
  <button
    type="button"
    aria-label="Zoom in"
    disabled={value >= most}
    onclick={() => (value = Math.min(most, value + STEP))}
  >
    +
  </button>
</span>

<style>
  .stepper {
    display: flex;
    align-items: center;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--card);
  }
  button {
    cursor: pointer;
    width: 30px;
    height: 30px;
    font: 15px var(--font);
    color: var(--ink-soft);
    background: var(--card);
    border: none;
  }
  button:hover:not(:disabled) {
    background: var(--bg-alt);
  }
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .level {
    font-size: 12px;
    line-height: 30px;
    padding: 0 8px;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    white-space: nowrap;
    min-width: 38px;
    text-align: center;
  }
</style>
