<!--
  The drag bar on a right-docked side panel's left edge: dragging left widens
  the panel. The width is clamped to the viewport and persisted per browser
  when the drag ends (side-panels.ts).
-->
<script lang="ts">
  import {
    clampPanelWidth,
    writeSidePanel,
    type SidePanelId,
    type SidePanelState,
  } from "$lib/side-panels.ts";

  let {
    id,
    label,
    panel = $bindable(),
    hidden = false,
  }: {
    id: SidePanelId;
    /** The separator's accessible name. */
    label: string;
    panel: SidePanelState;
    hidden?: boolean;
  } = $props();

  let resizing = $state(false);
  let startX = 0;
  let startWidth = 0;

  function begin(e: PointerEvent) {
    // Keeps the drag from starting a text selection in the panel.
    e.preventDefault();
    resizing = true;
    startX = e.clientX;
    startWidth = panel.width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!resizing) return;
    panel.width = clampPanelWidth(
      startWidth + (startX - e.clientX),
      window.innerWidth,
    );
  }
  function end() {
    if (!resizing) return;
    resizing = false;
    writeSidePanel(id, { ...panel });
  }
</script>

<div
  class="handle"
  class:active={resizing}
  {hidden}
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  onpointerdown={begin}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
></div>

<style>
  /* The host row's gap spaces the bar from the content; the right margin
     mirrors it towards the panel. */
  .handle {
    flex: none;
    align-self: stretch;
    margin: 12px 14px 12px 0;
    width: 6px;
    border-radius: 3px;
    background: var(--line-input);
    opacity: 0.65;
    cursor: col-resize;
    touch-action: none;
    position: relative;
  }
  .handle[hidden] {
    display: none;
  }
  .handle:hover,
  .handle.active {
    background: var(--accent);
    opacity: 0.8;
  }
  /* The embossed double line marking the bar as draggable. */
  .handle::before,
  .handle::after {
    content: "";
    position: absolute;
    top: 50%;
    width: 1px;
    height: 26px;
    transform: translateY(-50%);
    border-radius: 1px;
    background: var(--card);
  }
  .handle::before {
    left: 1.5px;
  }
  .handle::after {
    right: 1.5px;
  }
</style>
