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
    class="btn btn-icon"
    aria-label="Fewer pages per row"
    disabled={value <= 1}
    onclick={() => value--}
  >
    −
  </button>
  <span class="per-row">{value} per row</span>
  <button
    type="button"
    class="btn btn-icon"
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
    gap: 4px;
  }
  .per-row {
    font-size: 12px;
    padding: 0 2px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    white-space: nowrap;
  }
</style>
