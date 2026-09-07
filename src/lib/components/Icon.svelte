<!--
  One stroke icon set for the console: 24-unit grid, 2px round strokes,
  drawn in currentColor so it takes the text colour of its parent. Decorative
  by default (aria-hidden); pass a label when the icon stands alone.
-->
<script lang="ts">
  type Name =
    | "arrow-right"
    | "external"
    | "chevron-right"
    | "chevron-left"
    | "chevron-down"
    | "chevron-up"
    | "arrow-left"
    | "arrow-up"
    | "arrow-down"
    | "check"
    | "close"
    | "search"
    | "info"
    | "gear"
    | "facsimile"
    | "notes"
    | "side-by-side";
  let {
    name,
    size = 14,
    label = "",
  }: { name: Name; size?: number; label?: string } = $props();
  const paths: Record<Name, string> = {
    "arrow-right": "M5 12h14M13 6l6 6-6 6",
    external: "M7 17 17 7M8 7h9v9",
    "chevron-right": "M9 6l6 6-6 6",
    "chevron-left": "M15 6l-6 6 6 6",
    "chevron-down": "M6 9l6 6 6-6",
    "chevron-up": "M6 15l6-6 6 6",
    "arrow-left": "M19 12H5M11 6l-6 6 6 6",
    "arrow-up": "M12 19V5M6 11l6-6 6 6",
    "arrow-down": "M12 5v14M6 13l6 6 6-6",
    check: "M5 12.5l4.5 4.5L19 7.5",
    close: "M6 6l12 12M18 6 6 18",
    search: "M20 20l-3.5-3.5M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0z",
    info: "M12 11v5M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    gear: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
    facsimile: "M5 3h14v18H5zM8 8h8M8 12h8M8 16h5",
    notes: "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    "side-by-side": "M4 5h7v14H4zM13 5h7v14h-7z",
  };
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2.2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden={label ? undefined : "true"}
  aria-label={label || undefined}
  role={label ? "img" : undefined}
  focusable="false"
>
  <path d={paths[name]} />
</svg>

<style>
  .icon {
    display: inline-block;
    flex: none;
    vertical-align: -0.15em;
  }
</style>
