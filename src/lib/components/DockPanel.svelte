<!--
  A dock panel of the campaign view: a panel that docks to the bottom, left
  or right edge of the area it shares with the board (header buttons switch
  the edge) and resizes by dragging its inner edge. The header carries the
  caller's snippet, the body its children; the layout persists per browser
  under the panel's id (see preview-dock.ts).
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { writeDockLayout, DOCK_MIN } from "$lib/preview-dock.ts";
  import type { DockId, DockLayout, DockSide } from "$lib/preview-dock.ts";

  let {
    layout = $bindable(),
    id,
    label,
    header,
    children,
    onclose,
  }: {
    /** Where the panel docks and how large it is; the campaign page lays the
        view out around it. */
    layout: DockLayout;
    /** The stored layout this panel persists to. */
    id: DockId;
    /** The panel's accessible name. */
    label: string;
    header: Snippet;
    children: Snippet;
    onclose: () => void;
  } = $props();

  const side = $derived(layout.side);
  const setSide = (s: DockSide) => {
    layout = { ...layout, side: s };
    writeDockLayout(id, layout);
  };

  // Resizing drags the panel's inner edge. The real growth limit is the
  // board's content-based minimum — the panel is a shrinkable flex item, so
  // it stops rendering larger at that point whatever size is asked of it.
  // This clamp only keeps the asked-for size within loose bounds, so a
  // stored size never balloons far past what a window can show.
  const BOARD_MIN_H = 160;
  const BOARD_MIN_W = 320;
  let root = $state<HTMLElement>();
  let resizing = $state(false);
  // Whole pixels: the clamp below compares stored (rounded) sizes against
  // this, and a fractional maximum would keep the comparison true forever.
  function maxSize(area: DOMRect): number {
    return Math.floor(
      side === "bottom"
        ? Math.max(DOCK_MIN, area.height - BOARD_MIN_H)
        : Math.max(DOCK_MIN, area.width - BOARD_MIN_W),
    );
  }
  function startResize(e: PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizing = true;
  }
  function moveResize(e: PointerEvent) {
    if (!resizing || !root?.parentElement) return;
    const area = root.parentElement.getBoundingClientRect();
    const max = maxSize(area);
    if (side === "bottom") {
      layout = {
        ...layout,
        height: Math.round(
          Math.min(max, Math.max(DOCK_MIN, area.bottom - e.clientY)),
        ),
      };
    } else {
      const width =
        side === "left" ? e.clientX - area.left : area.right - e.clientX;
      layout = {
        ...layout,
        width: Math.round(Math.min(max, Math.max(DOCK_MIN, width))),
      };
    }
  }
  function endResize() {
    if (!resizing) return;
    resizing = false;
    // Store what actually rendered — flexbox refuses growth past the board's
    // minimum, however far the drag asked.
    if (root) {
      const r = root.getBoundingClientRect();
      layout =
        side === "bottom"
          ? { ...layout, height: Math.round(r.height) }
          : { ...layout, width: Math.round(r.width) };
    }
    writeDockLayout(id, layout);
  }
  // A panel never larger than its clamp, whatever size was stored or however
  // the window shrinks since. The stored preference is left as it is, so a
  // window grown back gets it again.
  function clampSize() {
    if (!root?.parentElement) return;
    const max = maxSize(root.parentElement.getBoundingClientRect());
    if (side === "bottom" && layout.height > max)
      layout = { ...layout, height: Math.round(max) };
    else if (side !== "bottom" && layout.width > max)
      layout = { ...layout, width: Math.round(max) };
  }
  $effect(() => {
    void side;
    clampSize();
  });
</script>

<svelte:window onresize={clampSize} />

<section
  bind:this={root}
  class="dock {side}"
  style={side === "bottom"
    ? `height:${layout.height}px`
    : `width:${layout.width}px`}
  aria-label={label}
>
  <div
    class="grip {side}"
    class:active={resizing}
    onpointerdown={startResize}
    onpointermove={moveResize}
    onpointerup={endResize}
    onpointercancel={endResize}
    role="separator"
    aria-orientation={side === "bottom" ? "horizontal" : "vertical"}
    aria-label="Resize the panel"
  ></div>
  <div class="dhead">
    {@render header()}
    <span class="dspacer"></span>
    <div class="dockseg" role="group" aria-label="Panel position">
      <button
        type="button"
        class:on={side === "left"}
        onclick={() => setSide("left")}
        title="Dock the panel to the left"
        aria-label="Dock the panel to the left">◧</button
      >
      <button
        type="button"
        class:on={side === "bottom"}
        onclick={() => setSide("bottom")}
        title="Dock the panel to the bottom"
        aria-label="Dock the panel to the bottom">⬓</button
      >
      <button
        type="button"
        class:on={side === "right"}
        onclick={() => setSide("right")}
        title="Dock the panel to the right"
        aria-label="Dock the panel to the right">◨</button
      >
    </div>
    <button
      type="button"
      class="closebtn"
      onclick={onclose}
      title="Close"
      aria-label="Close the panel">✕</button
    >
  </div>
  <div class="dbody">
    {@render children()}
  </div>
</section>

<style>
  .dock {
    position: relative;
    /* Shrinkable, so the board's content-based minimum beside it always
       wins: the panel stops growing where the board's room ends. */
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--line);
    box-shadow: 0 1px 6px var(--shade);
    overflow: hidden;
    z-index: 5;
  }
  .dock.bottom {
    min-height: 260px;
    border-left: 0;
    border-right: 0;
    border-bottom: 0;
  }
  .dock.left {
    min-width: 260px;
    border-top: 0;
    border-bottom: 0;
    border-left: 0;
  }
  .dock.right {
    min-width: 260px;
    border-top: 0;
    border-bottom: 0;
    border-right: 0;
  }

  /* ----------------------------------------------------------- resize grip */
  .grip {
    position: absolute;
    z-index: 10;
    touch-action: none;
  }
  .grip.bottom {
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    cursor: row-resize;
  }
  .grip.left {
    top: 0;
    bottom: 0;
    right: 0;
    width: 6px;
    cursor: col-resize;
  }
  .grip.right {
    top: 0;
    bottom: 0;
    left: 0;
    width: 6px;
    cursor: col-resize;
  }
  .grip:hover,
  .grip.active {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  /* The embossed double line marking the handle as draggable. */
  .grip::before,
  .grip::after {
    content: "";
    position: absolute;
    border-radius: 1px;
    background: var(--line-strong);
  }
  .grip.bottom::before,
  .grip.bottom::after {
    width: 40px;
    height: 1px;
    left: calc(50% - 20px);
    box-shadow: 0 1px 0 var(--card);
  }
  .grip.bottom::before {
    top: 1px;
  }
  .grip.bottom::after {
    top: 4px;
  }
  .grip.left::before,
  .grip.left::after,
  .grip.right::before,
  .grip.right::after {
    width: 1px;
    height: 40px;
    top: calc(50% - 20px);
    box-shadow: 1px 0 0 var(--card);
  }
  .grip.left::before,
  .grip.right::before {
    left: 1px;
  }
  .grip.left::after,
  .grip.right::after {
    left: 4px;
  }

  /* ---------------------------------------------------------------- header */
  .dhead {
    flex: none;
    min-height: 46px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 16px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .dspacer {
    flex: 1;
  }
  .dockseg {
    display: flex;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 3px;
    gap: 2px;
    flex: none;
  }
  .dockseg button {
    font: 600 13px var(--font);
    line-height: 1;
    padding: 4px 10px;
    border-radius: 999px;
    border: 0;
    background: none;
    color: var(--ink-faint);
    cursor: pointer;
  }
  .dockseg button.on {
    background: var(--card);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.1);
  }
  .closebtn {
    font: 600 14px var(--font);
    line-height: 1;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
  }
  .closebtn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ------------------------------------------------------------------ body */
  .dbody {
    flex: 1;
    min-height: 0;
    display: flex;
  }
</style>
