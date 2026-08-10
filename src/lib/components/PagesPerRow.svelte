<!--
  How many pages a row of previews holds. A tile takes an equal share of the
  width it has, so fewer per row shows each page larger.
-->
<script lang="ts">
  let {
    value = $bindable(),
    most = 5,
  }: {
    /** Pages per row, between 1 and `most`. */
    value: number;
    most?: number;
  } = $props();
</script>

<span class="stepper">
  <button
    type="button"
    aria-label="Fewer pages per row"
    disabled={value <= 1}
    onclick={() => value--}
  >
    −
  </button>
  <span class="per-row">{value} per row</span>
  <button
    type="button"
    aria-label="More pages per row"
    disabled={value >= most}
    onclick={() => value++}
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
  .per-row {
    font-size: 12px;
    line-height: 30px;
    padding: 0 8px;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    white-space: nowrap;
  }
</style>
