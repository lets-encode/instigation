<!--
  How many pages a row of previews holds. A tile takes an equal share of the
  width it has, so fewer per row shows each page larger: this is the zoom for
  every screen that lays pages out in rows.
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

<span class="zoom">
  <button
    type="button"
    class="btn btn-quiet"
    aria-label="Show the pages smaller"
    disabled={value >= most}
    onclick={() => value++}
  >
    −
  </button>
  <span class="per-row">{value} per row</span>
  <button
    type="button"
    class="btn btn-quiet"
    aria-label="Show the pages larger"
    disabled={value <= 1}
    onclick={() => value--}
  >
    +
  </button>
</span>

<style>
  .zoom {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  button {
    padding: 0.1rem 0.5rem;
    line-height: 1.2;
    /* Reads on a tinted pane as well as on a card. */
    background: var(--card);
  }
  .per-row {
    font-size: 0.8rem;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    white-space: nowrap;
  }
</style>
