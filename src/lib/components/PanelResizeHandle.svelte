<!--
  The drag bar on the side panel's edge: on its left edge beside the content,
  dragging left widens the panel; on its top edge when docked below the
  content, dragging up raises it. The size is clamped to the viewport and
  persisted per browser when the drag ends (side-panels.ts).
-->
<script lang="ts">
  import {
    clampPanelHeight,
    clampPanelWidth,
    writeSidePanel,
    type SidePanelState,
  } from "$lib/side-panels.ts";

  let {
    label,
    panel = $bindable(),
    docked = false,
  }: {
    /** The separator's accessible name. */
    label: string;
    panel: SidePanelState;
    /** The panel is docked below the content: the bar drags its height. */
    docked?: boolean;
  } = $props();

  let resizing = $state(false);
  let start = 0;
  let startSize = 0;

  function begin(e: PointerEvent) {
    // Keeps the drag from starting a text selection in the panel.
    e.preventDefault();
    resizing = true;
    start = docked ? e.clientY : e.clientX;
    startSize = docked ? panel.height : panel.width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!resizing) return;
    if (docked)
      panel.height = clampPanelHeight(
        startSize + (start - e.clientY),
        window.innerHeight,
      );
    else
      panel.width = clampPanelWidth(
        startSize + (start - e.clientX),
        window.innerWidth,
      );
  }
  function end() {
    if (!resizing) return;
    resizing = false;
    writeSidePanel({ ...panel });
  }
</script>

<div
  class="handle"
  class:docked
  class:active={resizing}
  role="separator"
  aria-orientation={docked ? "horizontal" : "vertical"}
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
  /* Docked: a grip centred on the panel's top edge, tall enough to touch. */
  .handle.docked {
    align-self: center;
    margin: 0;
    width: 64px;
    height: 20px;
    background: none;
    opacity: 1;
    cursor: row-resize;
  }
  .handle:hover,
  .handle.active {
    background: var(--accent);
    opacity: 0.8;
  }
  .handle.docked:hover,
  .handle.docked.active {
    background: none;
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
  .handle.docked::after {
    content: none;
  }
  .handle.docked::before {
    left: 14px;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--line-input);
  }
  .handle.docked:hover::before,
  .handle.docked.active::before {
    background: var(--accent);
  }
</style>
