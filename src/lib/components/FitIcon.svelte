<!--
  Zoom-to-fit glyphs for the score toolbars: two bounds with a double arrow
  between them — side to side for the width fit, top to bottom for the
  whole-page fit.
-->
<script lang="ts">
  let { kind }: { kind: "width" | "page" } = $props();
</script>

<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if kind === "width"}
    <path d="M3 5v14M21 5v14M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3" />
  {:else}
    <path d="M5 3h14M5 21h14M12 7v10M9 10l3-3 3 3M9 14l3 3 3-3" />
  {/if}
</svg>
