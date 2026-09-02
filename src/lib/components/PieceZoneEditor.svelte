<!--
  Mark which regions of the page images belong to which piece. Fills the
  material pane: a toolbar naming the piece being marked, and the pages in a
  grid under it.

  A sibling of the measure zone editor: the same SVG rectangle model (draw on
  the background, drag to move, corner handle to resize, arrow keys to nudge),
  but the rectangles are far coarser — one per stretch of a page a piece
  occupies — and each is coloured and labelled by its piece. Regions drawn while
  a piece is selected belong to that piece, so a piece can span several pages
  and two pieces can share one, as long as their regions do not overlap.

  Coordinates are the page image's own pixels, which is what the detector
  returns boxes in, so no rescaling is needed when the boxes are partitioned.
-->
<script lang="ts">
  import {
    overlappingPiece,
    pieceColour,
    type Piece,
    type PieceZone,
  } from "$lib/pieces.ts";
  import PagesPerRow from "./PagesPerRow.svelte";
  import ZoomLevel from "./ZoomLevel.svelte";

  let {
    pieces = $bindable(),
    pages,
    selectedPiece,
  }: {
    pieces: Piece[];
    /** One entry per page image, with its natural pixel size. */
    pages: { url: string; width: number; height: number }[];
    /** Index into `pieces`; regions are drawn for this piece. */
    selectedPiece: number;
  } = $props();

  // Drawing a region wants the width, so a row holds one page to begin with.
  let perRow = $state(1);
  let zoom = $state(100);
  // One entry per page, filled by bind:this. Reactive because binding writes
  // into it after the element is created.
  let svgEls = $state<SVGSVGElement[]>([]);
  // Rendered width per page, for converting screen pixels to page units so
  // labels and corner radii keep the same on-screen size at every zoom.
  let svgWidths = $state<number[]>([]);
  let failed = $state<Record<number, boolean>>({});

  // The region being drawn, moved or resized, addressed by page, piece and
  // index within that piece so the reference survives a re-render.
  type Corner = "nw" | "ne" | "sw" | "se";
  type Drag = {
    kind: "draw" | "move" | "resize";
    page: number;
    piece: number;
    zone: number;
    sx: number;
    sy: number;
    origin: PieceZone;
    /** Which corner a resize grabbed. */
    corner?: Corner;
    /** A draw creates its zone only once the pointer has moved a few screen
        pixels, so a plain click leaves nothing behind. */
    started?: boolean;
  };
  let drag: Drag | null = null;
  let selectedZone = $state<{ piece: number; zone: number } | null>(null);
  // What the last edit did or refused to do, shown until the next one.
  let notice = $state<string | null>(null);

  /** Regions on one page, with the piece each belongs to. */
  const zonesOn = (surface: number) =>
    pieces.flatMap((piece, p) =>
      piece.zones
        .map((zone, z) => ({ zone, p, z }))
        .filter(({ zone }) => zone.surface === surface),
    );

  // The smallest region worth keeping, and the minimum a resize may shrink to,
  // as a fraction of the page so it holds at any image size.
  const minSizeOn = (surface: number) => Math.max(pages[surface]?.width ?? 0, 1) * 0.02;

  function svgXY(e: PointerEvent, surface: number): { x: number; y: number } {
    const svg = svgEls[surface];
    const page = pages[surface];
    if (!svg || !page) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(page.width, ((e.clientX - rect.left) * page.width) / rect.width)),
      y: Math.max(0, Math.min(page.height, ((e.clientY - rect.top) * page.height) / rect.height)),
    };
  }

  function backgroundPointerDown(e: PointerEvent, surface: number) {
    selectedZone = null;
    const piece = pieces[selectedPiece];
    if (!piece || piece.kind !== "facsimile") return;
    const { x, y } = svgXY(e, surface);
    drag = {
      kind: "draw",
      page: surface,
      piece: selectedPiece,
      zone: -1,
      sx: x,
      sy: y,
      origin: { surface, ulx: x, uly: y, lrx: x, lry: y },
      started: false,
    };
  }

  function zonePointerDown(e: PointerEvent, surface: number, p: number, z: number) {
    e.stopPropagation();
    selectedZone = { piece: p, zone: z };
    const { x, y } = svgXY(e, surface);
    drag = {
      kind: "move",
      page: surface,
      piece: p,
      zone: z,
      sx: x,
      sy: y,
      origin: { ...pieces[p].zones[z] },
    };
  }

  function handlePointerDown(
    e: PointerEvent,
    surface: number,
    p: number,
    z: number,
    corner: Corner,
  ) {
    e.stopPropagation();
    selectedZone = { piece: p, zone: z };
    const { x, y } = svgXY(e, surface);
    drag = {
      kind: "resize",
      page: surface,
      piece: p,
      zone: z,
      sx: x,
      sy: y,
      origin: { ...pieces[p].zones[z] },
      corner,
    };
  }

  // An edge within a few screen pixels of another region's edge snaps to it,
  // so regions sit exactly side by side instead of overlapping by a stray
  // pixel, which would reject the region.
  function snapToNeighbours(zone: PieceZone, surface: number, skip: { piece: number; zone: number }) {
    const page = pages[surface];
    if (!page) return;
    const tolerance = 6 * (page.width / (svgWidths[surface] || 400));
    const xs: number[] = [];
    const ys: number[] = [];
    pieces.forEach((pc, p) =>
      pc.zones.forEach((o, z) => {
        if (o.surface !== surface || (p === skip.piece && z === skip.zone)) return;
        xs.push(o.ulx, o.lrx);
        ys.push(o.uly, o.lry);
      }),
    );
    const snap = (v: number, edges: number[]) => {
      let best = v;
      let dist = tolerance;
      for (const edge of edges) {
        const d = Math.abs(edge - v);
        if (d < dist) {
          dist = d;
          best = edge;
        }
      }
      return best;
    };
    zone.ulx = snap(zone.ulx, xs);
    zone.lrx = snap(zone.lrx, xs);
    zone.uly = snap(zone.uly, ys);
    zone.lry = snap(zone.lry, ys);
  }

  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const page = pages[drag.page];
    if (!page) return;
    const { x, y } = svgXY(e, drag.page);
    if (drag.kind === "draw" && !drag.started) {
      // No zone until the pointer has dragged ~4 screen pixels.
      const threshold = 4 * (page.width / (svgWidths[drag.page] || 400));
      if (Math.hypot(x - drag.sx, y - drag.sy) < threshold) return;
      const piece = pieces[drag.piece];
      piece.zones.push({ ...drag.origin });
      drag.zone = piece.zones.length - 1;
      drag.started = true;
      selectedZone = { piece: drag.piece, zone: drag.zone };
    }
    const zone = pieces[drag.piece].zones[drag.zone];
    const minSize = minSizeOn(drag.page);
    if (drag.kind === "move") {
      const w = drag.origin.lrx - drag.origin.ulx;
      const h = drag.origin.lry - drag.origin.uly;
      zone.ulx = Math.max(0, Math.min(page.width - w, drag.origin.ulx + (x - drag.sx)));
      zone.uly = Math.max(0, Math.min(page.height - h, drag.origin.uly + (y - drag.sy)));
      zone.lrx = zone.ulx + w;
      zone.lry = zone.uly + h;
      // Snapping shifts the whole region, keeping its size: whichever edge
      // snaps decides the shift.
      const snapped = { ...zone };
      snapToNeighbours(snapped, drag.page, { piece: drag.piece, zone: drag.zone });
      const dx = snapped.ulx !== zone.ulx ? snapped.ulx - zone.ulx : snapped.lrx - zone.lrx;
      const dy = snapped.uly !== zone.uly ? snapped.uly - zone.uly : snapped.lry - zone.lry;
      zone.ulx += dx;
      zone.lrx += dx;
      zone.uly += dy;
      zone.lry += dy;
    } else if (drag.kind === "draw") {
      // Drawing spans the start point and the pointer, in any direction.
      zone.ulx = Math.min(drag.sx, x);
      zone.lrx = Math.max(drag.sx, x, zone.ulx + minSize);
      zone.uly = Math.min(drag.sy, y);
      zone.lry = Math.max(drag.sy, y, zone.uly + minSize);
      snapToNeighbours(zone, drag.page, { piece: drag.piece, zone: drag.zone });
    } else {
      // Resizing moves the grabbed corner's two edges, never past the
      // opposite ones.
      const c = drag.corner ?? "se";
      if (c.includes("w")) zone.ulx = Math.min(drag.origin.lrx - minSize, x);
      else zone.lrx = Math.max(drag.origin.ulx + minSize, x);
      if (c.includes("n")) zone.uly = Math.min(drag.origin.lry - minSize, y);
      else zone.lry = Math.max(drag.origin.uly + minSize, y);
      snapToNeighbours(zone, drag.page, { piece: drag.piece, zone: drag.zone });
    }
  }

  function pointerUp() {
    if (!drag) return;
    const { kind, page, piece, zone: z, origin, started } = drag;
    drag = null;
    // A draw that never crossed the drag threshold was a plain click.
    if (kind === "draw" && !started) return;
    notice = null;
    const zone = pieces[piece].zones[z];
    const minSize = minSizeOn(page);
    // A tiny rectangle was a click on the background, not a region.
    if (kind === "draw" && (zone.lrx - zone.ulx < minSize || zone.lry - zone.uly < minSize)) {
      pieces[piece].zones.splice(z, 1);
      selectedZone = null;
      return;
    }
    const clash = overlappingPiece(pieces, piece, zone);
    if (clash === -1) return;
    notice = overlapNotice(clash, page);
    if (kind === "draw") {
      pieces[piece].zones.splice(z, 1);
      selectedZone = null;
    } else {
      Object.assign(zone, origin);
    }
  }

  const overlapNotice = (clash: number, surface: number) =>
    `Regions cannot overlap: ${labelFor(clash)} already covers part of that area on page ${surface + 1}.`;

  function zoneKeydown(e: KeyboardEvent, surface: number, p: number, z: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectedZone = { piece: p, zone: z };
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      removeZone(p, z);
      return;
    }
    const page = pages[surface];
    if (!e.key.startsWith("Arrow") || !page) return;
    e.preventDefault();
    selectedZone = { piece: p, zone: z };
    const zone = pieces[p].zones[z];
    const step = e.shiftKey ? 20 : 4;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    const w = zone.lrx - zone.ulx;
    const h = zone.lry - zone.uly;
    const ulx = Math.max(0, Math.min(page.width - w, zone.ulx + dx));
    const uly = Math.max(0, Math.min(page.height - h, zone.uly + dy));
    const moved = { surface, ulx, uly, lrx: ulx + w, lry: uly + h };
    const clash = overlappingPiece(pieces, p, moved);
    notice = clash === -1 ? null : overlapNotice(clash, surface);
    if (clash === -1) Object.assign(zone, moved);
  }

  function removeZone(p: number, z: number) {
    pieces[p].zones.splice(z, 1);
    selectedZone = null;
    notice = null;
  }

  const labelFor = (p: number) => pieces[p].meta.title.trim() || pieces[p].id;
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

<div class="material-card">
  <div class="material-toolbar">
    <span class="drag-hint">
      {#if pieces[selectedPiece]?.kind === "facsimile"}
        Drag on a page to give a region to
        <strong style="color: {pieceColour(selectedPiece)}">{labelFor(selectedPiece)}</strong>
      {:else}
        <strong style="color: {pieceColour(selectedPiece)}">{labelFor(selectedPiece)}</strong>
        is an uploaded encoding — it needs no regions
      {/if}
    </span>
    <div class="toolbar-gap"></div>
    <PagesPerRow bind:value={perRow} />
    <ZoomLevel bind:value={zoom} />
  </div>

  {#if notice}
    <p class="msg-warn notice" role="status">{notice}</p>
  {/if}

  <div class="material-body">
    <div class="material-grid" style="--per-row: {perRow}; width: {zoom}%">
    {#each pages as page, i (page.url)}
      {@const scale = (svgWidths[i] || 400) / page.width}
      {@const rx = 6 / scale}
      <figure>
        {#if failed[i]}
          <p class="msg-error-inline">Page {i + 1} could not be displayed.</p>
        {/if}
        <svg
          bind:this={svgEls[i]}
          bind:clientWidth={svgWidths[i]}
          viewBox={`0 0 ${page.width} ${page.height}`}
          style="aspect-ratio: {page.width} / {page.height}"
          role="application"
          aria-label={`Page ${i + 1}: piece regions`}
          onpointerdown={(e) => backgroundPointerDown(e, i)}
        >
          <image
            href={page.url}
            width={page.width}
            height={page.height}
            style="clip-path: inset(0 round {rx}px)"
            onerror={() => (failed[i] = true)}
          />
          {#each zonesOn(i) as { zone, p, z } (`${p}:${z}`)}
            {@const fs =
              Math.min(13, Math.max(9, (svgWidths[i] || 400) / 30)) / scale}
            {@const label = labelFor(p)}
            {@const zw = Math.max(0, zone.lrx - zone.ulx)}
            {@const pillW = Math.min(
              label.length * fs * 0.6 + fs,
              Math.max(0, zw - 2 * rx),
            )}
            {@const btnX = Math.max(zone.ulx + 4 / scale, zone.lrx - 27 / scale)}
            {@const btnBelowLabel = btnX < zone.ulx + rx + pillW + 6 / scale}
            {@const btnY = btnBelowLabel
              ? zone.uly + rx + fs * 1.5 + 6 / scale
              : zone.uly + 7 / scale}
            <rect
              class="zone"
              class:selected={selectedZone?.piece === p && selectedZone?.zone === z}
              style="--piece: {pieceColour(p)}"
              vector-effect="non-scaling-stroke"
              role="button"
              tabindex={0}
              aria-label={`${label}: region on page ${i + 1}`}
              x={zone.ulx}
              y={zone.uly}
              width={Math.max(0, zone.lrx - zone.ulx)}
              height={Math.max(0, zone.lry - zone.uly)}
              rx={rx}
              onpointerdown={(e) => zonePointerDown(e, i, p, z)}
              onkeydown={(e) => zoneKeydown(e, i, p, z)}
            />
            <clipPath id={`pillclip-${i}-${p}-${z}`}>
              <rect
                x={zone.ulx + rx}
                y={zone.uly + rx}
                width={pillW}
                height={fs * 1.5}
                rx={fs * 0.75}
              />
            </clipPath>
            <rect
              class="labelbg"
              style="--piece: {pieceColour(p)}"
              x={zone.ulx + rx}
              y={zone.uly + rx}
              width={pillW}
              height={fs * 1.5}
              rx={fs * 0.75}
            />
            <text
              class="label"
              clip-path={`url(#pillclip-${i}-${p}-${z})`}
              x={zone.ulx + rx + fs * 0.5}
              y={zone.uly + rx + fs * 1.1}
              font-size={fs}
            >
              {label}
            </text>
            {#if selectedZone?.piece === p && selectedZone?.zone === z}
              <!-- A delete button pinned inside the region's top-right corner,
                   drawn in screen pixels via the inverse-scale transform. -->
              <g
                class="delbtn"
                role="button"
                tabindex={0}
                aria-label={`${label}: remove region`}
                transform={`translate(${btnX}, ${btnY}) scale(${1 / scale})`}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => removeZone(p, z)}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    removeZone(p, z);
                  }
                }}
              >
                <rect width="20" height="20" rx="6" />
                <path
                  d="M5.2 6.4h9.6 M8.3 6.2V4.8h3.4v1.4 M6.4 6.6l.5 8.8h6.2l.5-8.8 M8.7 8.8v4.4 M11.3 8.8v4.4"
                />
              </g>
              {#each [
                { corner: "nw", name: "top-left", cx: zone.ulx, cy: zone.uly },
                { corner: "ne", name: "top-right", cx: zone.lrx, cy: zone.uly },
                { corner: "sw", name: "bottom-left", cx: zone.ulx, cy: zone.lry },
                { corner: "se", name: "bottom-right", cx: zone.lrx, cy: zone.lry },
              ] as const as h (h.corner)}
                <circle
                  class="handle"
                  class:nesw={h.corner === "ne" || h.corner === "sw"}
                  style="--piece: {pieceColour(p)}"
                  vector-effect="non-scaling-stroke"
                  role="button"
                  tabindex={0}
                  aria-label={`${label}: resize region (${h.name} corner)`}
                  cx={h.cx}
                  cy={h.cy}
                  r={5 / scale}
                  onpointerdown={(e) => handlePointerDown(e, i, p, z, h.corner)}
                />
              {/each}
            {/if}
          {/each}
        </svg>
          <figcaption class="page-caption">p. {i + 1}</figcaption>
        </figure>
      {/each}
    </div>
  </div>
</div>

<style>
  .drag-hint {
    font-size: 12px;
    color: var(--ink-soft);
  }
  .notice {
    margin: 0;
    padding: 6px 16px;
    border-bottom: 1px solid var(--line);
  }
  figure {
    min-width: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  svg {
    display: block;
    /* The page takes its column's width; the inline aspect-ratio, which is the
       page image's own, then decides its height. */
    width: 100%;
    height: auto;
    box-sizing: border-box;
    /* Scanned pages keep their own light ground in either theme. */
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: var(--shadow-sm);
    touch-action: none;
    /* Strokes are centred on their edge, so a region flush with the page
       boundary paints half its outline outside the viewBox; without this it
       is clipped and corners go missing. */
    overflow: visible;
  }
  .zone {
    fill: var(--piece);
    fill-opacity: var(--zone-fill-alpha);
    stroke: var(--piece);
    /* The markup sets vector-effect="non-scaling-stroke" (as an attribute —
       CSS support for it is inconsistent), so this width is screen pixels:
       the outline stays crisp at every zoom level. */
    stroke-width: 2;
    cursor: move;
  }
  .zone:hover,
  .zone.selected {
    fill-opacity: calc(var(--zone-fill-alpha) * 1.6);
    stroke-width: 3.5;
  }
  .zone:focus-visible {
    outline: none;
    stroke-dasharray: 8 4;
  }
  .labelbg {
    fill: var(--piece);
    pointer-events: none;
  }
  .label {
    fill: #fff;
    font-weight: 600;
    pointer-events: none;
  }
  .handle {
    fill: var(--card);
    stroke: var(--piece);
    stroke-width: 2;
    cursor: nwse-resize;
  }
  .handle.nesw {
    cursor: nesw-resize;
  }
  .delbtn {
    cursor: pointer;
  }
  .delbtn rect {
    fill: var(--card);
    stroke: var(--line-input);
  }
  .delbtn:hover rect,
  .delbtn:focus-visible rect {
    stroke: var(--danger);
  }
  .delbtn path {
    fill: none;
    stroke: var(--danger);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
</style>
