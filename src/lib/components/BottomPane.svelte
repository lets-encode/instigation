<!--
  The lower half of a split screen: a region held at the bottom of the surface,
  with a divider along its top edge that drags to resize it.

  It is sized in pixels rather than as a fraction so a size chosen by dragging
  survives a window resize, and capped so the pane above stays usable.
-->
<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    label,
    height = $bindable(420),
    children,
  }: {
    /** Names the region for assistive technology. */
    label: string;
    height?: number;
    children: Snippet;
  } = $props();

  let resizing = false;
  function startResize(e: PointerEvent) {
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (!resizing) return;
    // The pane is anchored to the bottom, so it grows as the pointer rises.
    // The ceiling matches the CSS max-height, so dragging and the starting
    // size agree on the limit.
    height = Math.min(Math.max(window.innerHeight - e.clientY, 140), window.innerHeight * 0.7);
  }
  function endResize(e: PointerEvent) {
    resizing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }
</script>

<section class="pane" style="height: {height}px" aria-label={label}>
  <div
    class="grip"
    role="separator"
    aria-label="Resize {label}"
    aria-orientation="horizontal"
    onpointerdown={startResize}
    onpointermove={onResize}
    onpointerup={endResize}
    onpointercancel={endResize}
  ></div>

  {@render children()}
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    flex: none;
    /* Caps the starting height so the pane above stays usable on short windows. */
    max-height: 70vh;
    border-top: 1px solid var(--line);
    background: var(--bg-alt);
  }
  /* The divider between the two panes: a grab bar with a centred handle. */
  .grip {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 12px;
    cursor: ns-resize;
    touch-action: none;
    border-bottom: 1px solid var(--line);
  }
  .grip::before {
    content: "";
    width: 2.5rem;
    height: 3px;
    border-radius: 999px;
    background: var(--line);
  }
  .grip:hover::before {
    background: var(--accent);
  }
</style>
