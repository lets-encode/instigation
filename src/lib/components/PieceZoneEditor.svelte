<!--
  Mark which regions of the page images belong to which piece.

  A sibling of the measure zone editor: the same SVG rectangle model (draw on
  the background, drag to move, corner handle to resize, arrow keys to nudge),
  but the rectangles are far coarser — one per stretch of a page a piece
  occupies — and each is coloured and labelled by its piece. Regions drawn while
  a piece is selected belong to that piece, so a piece can span several pages
  and two pieces can share one.

  Every page is laid out at once in a left-to-right strip, so a piece that runs
  across a page break can be marked without paging back and forth.

  Coordinates are the page image's own pixels, which is what the detector
  returns boxes in, so no rescaling is needed when the boxes are partitioned.
-->
<script lang="ts">
  import { pieceColour, type Piece, type PieceZone } from "$lib/pieces.ts";
  import BottomPane from "./BottomPane.svelte";

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

  let zoom = $state(1);
  let svgEls: SVGSVGElement[] = [];
  let failed = $state<Record<number, boolean>>({});

  // The region being drawn, moved or resized, addressed by page, piece and
  // index within that piece so the reference survives a re-render.
  type Drag = {
    kind: "draw" | "move" | "resize";
    page: number;
    piece: number;
    zone: number;
    sx: number;
    sy: number;
    origin: PieceZone;
  };
  let drag: Drag | null = null;
  let selectedZone = $state<{ piece: number; zone: number } | null>(null);

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
    piece.zones.push({ surface, ulx: x, uly: y, lrx: x, lry: y });
    const zone = piece.zones.length - 1;
    selectedZone = { piece: selectedPiece, zone };
    drag = {
      kind: "draw",
      page: surface,
      piece: selectedPiece,
      zone,
      sx: x,
      sy: y,
      origin: { ...piece.zones[zone] },
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

  function handlePointerDown(e: PointerEvent, surface: number, p: number, z: number) {
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
    };
  }

  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const page = pages[drag.page];
    if (!page) return;
    const { x, y } = svgXY(e, drag.page);
    const zone = pieces[drag.piece].zones[drag.zone];
    const minSize = minSizeOn(drag.page);
    if (drag.kind === "move") {
      const w = drag.origin.lrx - drag.origin.ulx;
      const h = drag.origin.lry - drag.origin.uly;
      zone.ulx = Math.max(0, Math.min(page.width - w, drag.origin.ulx + (x - drag.sx)));
      zone.uly = Math.max(0, Math.min(page.height - h, drag.origin.uly + (y - drag.sy)));
      zone.lrx = zone.ulx + w;
      zone.lry = zone.uly + h;
    } else {
      // draw and resize both pull the lower-right corner.
      zone.lrx = Math.max(zone.ulx + minSize, x);
      zone.lry = Math.max(zone.uly + minSize, y);
    }
  }

  function pointerUp() {
    if (!drag) return;
    const { kind, page, piece, zone } = drag;
    drag = null;
    if (kind !== "draw") return;
    const drawn = pieces[piece].zones[zone];
    const minSize = minSizeOn(page);
    // A tiny rectangle was a click on the background, not a region.
    if (drawn.lrx - drawn.ulx < minSize || drawn.lry - drawn.uly < minSize) {
      pieces[piece].zones.splice(zone, 1);
      selectedZone = null;
    }
  }

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
    zone.ulx = Math.max(0, Math.min(page.width - w, zone.ulx + dx));
    zone.uly = Math.max(0, Math.min(page.height - h, zone.uly + dy));
    zone.lrx = zone.ulx + w;
    zone.lry = zone.uly + h;
  }

  function removeZone(p: number, z: number) {
    pieces[p].zones.splice(z, 1);
    selectedZone = null;
  }

  /** Cover the given pages with one whole-page region each for the selected piece. */
  function cover(surfaces: number[]) {
    const piece = pieces[selectedPiece];
    if (!piece || piece.kind !== "facsimile") return;
    piece.zones = [
      ...piece.zones.filter((zone) => !surfaces.includes(zone.surface)),
      ...surfaces.map((surface) => ({
        surface,
        ulx: 0,
        uly: 0,
        lrx: pages[surface].width,
        lry: pages[surface].height,
      })),
    ];
    selectedZone = null;
  }

  const labelFor = (p: number) => pieces[p].meta.title.trim() || pieces[p].id;
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} />

{#if pages.length}
  <BottomPane label="Piece regions">
    <div class="strip-bar">
      <p class="hint">
        Drag on a page to mark where
        <strong style="color: {pieceColour(selectedPiece)}">{labelFor(selectedPiece)}</strong>
        begins and ends. A piece can cover several pages, and two pieces can share one.
      </p>

      <div class="tools">
        <button type="button" class="btn btn-quiet" onclick={() => cover(pages.map((_, i) => i))}>
          Assign all pages to this piece
        </button>
        {#if selectedZone}
          <button
            type="button"
            class="btn btn-quiet"
            onclick={() => removeZone(selectedZone!.piece, selectedZone!.zone)}
          >
            Remove region
          </button>
        {/if}
        <button type="button" class="btn btn-quiet" onclick={() => (zoom = Math.max(zoom / 1.25, 0.5))} aria-label="Zoom out">−</button>
        <span class="zoomlabel">{Math.round(zoom * 100)}%</span>
        <button type="button" class="btn btn-quiet" onclick={() => (zoom = Math.min(zoom * 1.25, 4))} aria-label="Zoom in">+</button>
      </div>
    </div>

    <div class="page-strip">
      {#each pages as page, i (page.url)}
        <figure style="height: {100 * zoom}%">
          {#if failed[i]}
            <p class="msg-error-inline">Page {i + 1} could not be displayed.</p>
          {/if}
          <svg
            bind:this={svgEls[i]}
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
              onerror={() => (failed[i] = true)}
            />
            {#each zonesOn(i) as { zone, p, z } (`${p}:${z}`)}
              {@const fs = Math.max(page.width / 40, 12)}
              {@const label = labelFor(p)}
              <rect
                class="zone"
                class:selected={selectedZone?.piece === p && selectedZone?.zone === z}
                style="--piece: {pieceColour(p)}"
                role="button"
                tabindex={0}
                aria-label={`${label}: region on page ${i + 1}`}
                x={zone.ulx}
                y={zone.uly}
                width={Math.max(0, zone.lrx - zone.ulx)}
                height={Math.max(0, zone.lry - zone.uly)}
                onpointerdown={(e) => zonePointerDown(e, i, p, z)}
                onkeydown={(e) => zoneKeydown(e, i, p, z)}
              />
              <rect
                class="labelbg"
                style="--piece: {pieceColour(p)}"
                x={zone.ulx + 4}
                y={zone.uly + 4}
                width={label.length * fs * 0.6 + fs}
                height={fs * 1.5}
                rx={fs * 0.25}
              />
              <text class="label" x={zone.ulx + 4 + fs * 0.5} y={zone.uly + 4 + fs * 1.1} font-size={fs}>
                {label}
              </text>
              {#if selectedZone?.piece === p && selectedZone?.zone === z}
                <circle
                  class="handle"
                  style="--piece: {pieceColour(p)}"
                  role="button"
                  tabindex={0}
                  aria-label={`${label}: resize region`}
                  cx={zone.lrx}
                  cy={zone.lry}
                  r={Math.max(10, page.width / 90)}
                  onpointerdown={(e) => handlePointerDown(e, i, p, z)}
                />
              {/if}
            {/each}
          </svg>
          <figcaption>
            <span>{i + 1}</span>
            <button type="button" class="btn btn-quiet" onclick={() => cover([i])}>Whole page</button>
          </figcaption>
        </figure>
      {/each}
    </div>
  </BottomPane>
{:else}
  <p class="hint standalone">
    This campaign has no page images, so there are no regions to mark.
  </p>
{/if}

<style>
  .strip-bar {
    gap: 1rem;
    flex-wrap: wrap;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--ink-soft);
  }
  /* The pane's buttons sit on its tinted background, so they carry a fill. */
  button {
    background: var(--card);
  }
  .zoomlabel {
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 0;
  }
  .hint.standalone {
    padding: 0.75rem 1.5rem;
  }
  figcaption {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  figcaption button {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
  }
  svg {
    display: block;
    flex: 1;
    min-height: 0;
    width: auto;
    /* Scanned pages keep their own white ground in either theme. */
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    touch-action: none;
  }
  .zone {
    fill: var(--piece);
    fill-opacity: var(--zone-fill-alpha);
    stroke: var(--piece);
    stroke-width: 3;
    cursor: move;
  }
  .zone:hover,
  .zone.selected {
    fill-opacity: calc(var(--zone-fill-alpha) * 1.6);
    stroke-width: 5;
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
    stroke-width: 3;
    cursor: nwse-resize;
  }
</style>
