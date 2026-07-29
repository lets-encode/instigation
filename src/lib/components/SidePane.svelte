<!--
  The right-hand half of a split screen: a region held against the right edge of
  the surface, with a divider along its left edge that drags to resize it.

  It is sized in pixels rather than as a fraction so a size chosen by dragging
  survives a window resize, and capped so the pane beside it stays usable.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  // A starting width taken from the window, so both panes are usable before
  // anything is dragged. Server rendering has no window to measure, and falls
  // back to a width the client replaces as it hydrates.
  const startingWidth = () =>
    typeof window === "undefined"
      ? 560
      : Math.round(Math.min(Math.max(window.innerWidth * 0.45, 320), 720));

  let {
    label,
    width = $bindable(startingWidth()),
    children,
  }: {
    /** Names the region for assistive technology. */
    label: string;
    width?: number;
    children: Snippet;
  } = $props();

  let resizing = false;
  function startResize(e: PointerEvent) {
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (!resizing) return;
    // The pane is anchored to the right, so it grows as the pointer moves left.
    // The ceiling matches the CSS max-width, so dragging and the starting size
    // agree on the limit.
    width = Math.min(Math.max(window.innerWidth - e.clientX, 260), window.innerWidth * 0.75);
  }
  function endResize(e: PointerEvent) {
    resizing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }
</script>

<!-- The width goes through a custom property so the stacked layout can drop it. -->
<section class="pane" style="--pane-width: {width}px" aria-label={label}>
  <div
    class="grip"
    role="separator"
    aria-label="Resize {label}"
    aria-orientation="vertical"
    onpointerdown={startResize}
    onpointermove={onResize}
    onpointerup={endResize}
    onpointercancel={endResize}
  ></div>

  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .pane {
    display: flex;
    flex: none;
    width: var(--pane-width);
    /* Caps the width so the pane beside it stays usable on narrow windows. */
    max-width: 75%;
    border-left: 1px solid var(--line);
    background: var(--bg-alt);
  }
  /* The divider between the two panes: a grab bar with a centred handle. */
  .grip {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    cursor: ew-resize;
    touch-action: none;
    border-right: 1px solid var(--line);
  }
  .grip::before {
    content: "";
    width: 3px;
    height: 2.5rem;
    border-radius: 999px;
    background: var(--line);
  }
  .grip:hover::before {
    background: var(--accent);
  }
  .body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  /* Stacked under the pane it was beside, on a window too narrow to hold both:
     it takes the full width and a share of the height, and the divider goes,
     since there is no width left to trade. The same width is the breakpoint in
     ui.css, which is where the stacking happens. */
  @media (max-width: 52rem) {
    .pane {
      width: auto;
      max-width: none;
      max-height: 60vh;
      border-left: none;
      border-top: 1px solid var(--line);
    }
    .grip {
      display: none;
    }
  }
</style>
