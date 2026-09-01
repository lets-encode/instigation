<!--
  The score viewer: one MEI shown as its facsimile pages, as the encoding
  rendered by Verovio, or both side by side, with book-style paging and zoom
  shared by the panes. The pane choice is a per-browser preference (see
  preview-pane.ts), so it carries from one preview to the next.

  A caller can pass a measure range to highlight, which marks those measures in
  both panes.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import type { MeasureBox } from "$lib/mei-facsimile.ts";
  import { resolveFacsimileImageUrls } from "$lib/facsimile-images.ts";
  import { buildSpreads } from "$lib/page-spreads.ts";
  import { getVerovio, loadedVerovio, renderPage } from "$lib/verovio-render.ts";
  import { readPreviewPane, writePreviewPane } from "$lib/preview-pane.ts";
  import type { PreviewPane } from "$lib/preview-pane.ts";

  let {
    owner,
    repo,
    fragment,
    startPage = 0,
    anchor = null,
    initialPane = null,
    initialZones = true,
    onmeasureselect,
    trailing,
  }: {
    owner: string;
    repo: string;
    /** Repo path of the score to show; changing it loads the other score. */
    fragment: string;
    /** The page the preview opens at, 0-based. */
    startPage?: number;
    /** A measure range to highlight in both panes. */
    anchor?: { page: number; m1: number; m2: number } | null;
    /** The pane the preview opens with; null uses the stored per-browser choice. */
    initialPane?: PreviewPane | null;
    /** Whether the measure-zone overlay starts visible. */
    initialZones?: boolean;
    /** Reports the selected measure's label; null when deselected. */
    onmeasureselect?: (label: string | null) => void;
    /** Extra controls rendered at the toolbar's end. */
    trailing?: Snippet;
  } = $props();

  /** One facsimile page in the preview: image plus its measure zones. */
  type PreviewPage = {
    url: string;
    w: number;
    h: number;
    zones: { box: MeasureBox; label: string }[];
  };
  let preview = $state<{
    /** The fragment this state belongs to — a late load for another one is dropped. */
    key: string;
    loading: boolean;
    error?: string;
    /** The facsimile pages, when the score references any. */
    facs?: PreviewPage[];
    /** Verovio page count; 0 = nothing to render yet. */
    pageCount: number;
    /** Rendered encoding pages, filled lazily per spread (1-based). */
    svgs: Record<number, string>;
  } | null>(null);

  // Display state: which panes show, book-style paging and zoom shared by them,
  // and the zone overlay toggle.
  // svelte-ignore state_referenced_locally -- an initial value by contract
  let pvPane = $state<PreviewPane>(initialPane ?? readPreviewPane());
  let pvView = $state<"single" | "double">("single");
  let pvFirstOnRight = $state(true);
  let pvFirstVisible = $state(0);
  let pvZoom = $state(1);
  // svelte-ignore state_referenced_locally -- an initial value by contract
  let showZones = $state(initialZones);

  // Scores without a facsimile only have the render to show.
  const pane = $derived(preview?.facs?.length ? pvPane : "enc");
  const facsVisible = $derived(pane === "facs" || pane === "both");
  const encVisible = $derived(pane === "enc" || pane === "both");

  function setPane(choice: PreviewPane) {
    pvPane = choice;
    writePreviewPane(choice);
  }

  const PV_ZOOM_MIN = 0.5;
  const PV_ZOOM_MAX = 4;
  // The slider runs on a log scale: equal drags multiply the zoom equally,
  // so the low end moves in fine steps and the high end in coarse ones.
  const PV_ZOOM_STOPS = 100;
  const pvZoomPos = $derived(
    Math.round(
      (Math.log(pvZoom / PV_ZOOM_MIN) / Math.log(PV_ZOOM_MAX / PV_ZOOM_MIN)) * PV_ZOOM_STOPS,
    ),
  );
  const setPvZoomPos = (p: number) =>
    (pvZoom =
      Math.round(PV_ZOOM_MIN * (PV_ZOOM_MAX / PV_ZOOM_MIN) ** (p / PV_ZOOM_STOPS) * 100) / 100);

  const pvPageTotal = $derived(
    preview ? Math.max(preview.facs?.length ?? 0, preview.pageCount) : 0,
  );
  const pvSpreads = $derived(buildSpreads(pvPageTotal, pvView, pvFirstOnRight));
  const pvSpreadIndex = $derived(
    Math.max(
      0,
      pvSpreads.findIndex((sp) => sp.pages.includes(pvFirstVisible)),
    ),
  );
  const pvSpread = $derived(pvSpreads[pvSpreadIndex] ?? { pages: [] });
  const pvSpreadLabel = $derived(
    pvSpread.pages.length === 2
      ? `Pages ${pvSpread.pages[0] + 1}–${pvSpread.pages[1] + 1} of ${pvPageTotal}`
      : `Page ${(pvSpread.pages[0] ?? 0) + 1} of ${pvPageTotal}`,
  );

  // The selected measure, linking the panes: clicking a zone on the facsimile
  // or a measure on the rendered encoding highlights it on both. Zone labels
  // and Verovio's data-n both carry the measure's number (@n), so the label is
  // the shared key.
  let selected = $state<string | null>(null);
  function selectMeasure(label: string | null) {
    selected = selected === label ? null : label;
    onmeasureselect?.(selected);
    if (selected) {
      const p = pageOfMeasure(selected);
      if (p >= 0 && !pvSpread.pages.includes(p)) showPage(p);
    }
  }
  // A click on the rendered encoding, resolved to the measure it landed in.
  // SVG only hit-tests painted strokes, so a click between the staff lines
  // reaches no measure element — those fall back to the measures' bounding
  // boxes, making the whole measure rectangle the hit area.
  function encClick(e: MouseEvent) {
    let n = (e.target as Element)
      .closest?.("g.measure")
      ?.getAttribute("data-n");
    if (!n) {
      for (const g of (e.currentTarget as Element).querySelectorAll(
        "g.measure[data-n]",
      )) {
        const r = g.getBoundingClientRect();
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        ) {
          n = g.getAttribute("data-n");
          break;
        }
      }
    }
    if (n) selectMeasure(n);
  }

  // Whether a facsimile zone falls in the anchored measure range (zone labels
  // carry the measure numbers).
  function zoneFlagged(label: string): boolean {
    if (!anchor) return false;
    const a = anchor;
    return (label.match(/\d+/g) ?? []).some((s) => {
      const n = Number(s);
      return n >= a.m1 && n <= a.m2;
    });
  }
  // Mark the anchored and the selected measures on a rendered encoding page —
  // Verovio writes each measure's number as data-n.
  function flagSvg(svg: string): string {
    const a = anchor;
    const sel = selected;
    if (!svg || (!a && sel === null)) return svg;
    try {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      // A failed parse yields a parsererror document, not an exception — the
      // page then shows unflagged rather than serialised error text.
      if (doc.querySelector("parsererror")) return svg;
      for (const g of doc.querySelectorAll("g.measure")) {
        const label = g.getAttribute("data-n") ?? "";
        const n = Number(label);
        if (a && Number.isFinite(n) && n >= a.m1 && n <= a.m2)
          g.classList.add("m-flag");
        if (sel !== null && label === sel) g.classList.add("m-sel");
      }
      return new XMLSerializer().serializeToString(doc);
    } catch {
      return svg;
    }
  }
  // Marked-up pages, derived so the DOMParser round trip re-runs only when the
  // rendered pages, the anchor or the selection move — not on every overlay
  // re-render.
  const flaggedSvgs = $derived.by(() => {
    const out: Record<number, string> = {};
    if (!preview) return out;
    for (const [n, svg] of Object.entries(preview.svgs)) {
      out[Number(n)] = flagSvg(svg);
    }
    return out;
  });

  // Render the encoding pages the current spread needs (kept for later visits).
  function renderSpread() {
    const tk = loadedVerovio();
    if (!preview || preview.loading || !tk || preview.pageCount === 0) return;
    let added = false;
    const svgs = { ...preview.svgs };
    for (const p of pvSpread.pages) {
      const n = p + 1;
      if (n <= preview.pageCount && !svgs[n]) {
        svgs[n] = renderPage(tk, n);
        added = true;
      }
    }
    if (added) preview = { ...preview, svgs };
  }
  function pvGo(delta: number) {
    const next = pvSpreads[pvSpreadIndex + delta];
    if (!next) return;
    pvFirstVisible = next.pages[0];
    renderSpread();
  }
  function pvSetView(v: "single" | "double") {
    pvView = v;
    renderSpread();
  }
  function pvSetFirstOnRight(on: boolean) {
    pvFirstOnRight = on;
    renderSpread();
  }

  /**
   * Which page a measure sits on, read from the facsimile's zone labels; -1
   * when the score has no facsimile to say.
   */
  export function pageOfMeasure(label: string): number {
    return (
      preview?.facs?.findIndex((pg) => pg.zones.some((z) => z.label === label)) ??
      -1
    );
  }

  /** Turn to a page (0-based) and render what it needs. */
  export function showPage(page: number) {
    if (page < 0 || page >= pvPageTotal) return;
    pvFirstVisible = page;
    renderSpread();
  }

  /** The first page the preview currently shows, 0-based. */
  export function currentPage(): number {
    return pvSpread.pages[0] ?? 0;
  }

  /** Show or hide the measure zones on the facsimile. */
  export function setZones(on: boolean) {
    showZones = on;
  }

  // Preview both sides of the score: the facsimile pages (when the score
  // references any) and the rendered encoding (when it holds measures).
  async function loadPreview(path: string, from: number) {
    const f = readForge();
    preview = {
      key: path,
      loading: true,
      pageCount: 0,
      svgs: {},
    };
    pvFirstVisible = 0;
    // A selection belongs to the score it was made on.
    if (selected !== null) {
      selected = null;
      onmeasureselect?.(null);
    }
    try {
      const mei = await f.getRepoFile(owner, repo, path);
      if (mei == null) throw new Error(`Could not read ${path}.`);
      const parsed = parseFacsimileMei(mei);

      let facs: PreviewPage[] | undefined;
      if (parsed.pages.length) {
        const urls = await resolveFacsimileImageUrls(
          f,
          owner,
          repo,
          path,
          parsed.pages.map((page) => page.image),
        );
        // A facsimile whose images are all unreachable (an encoding uploaded
        // without its page images) gets no facsimile pane — there is nothing
        // to show on it.
        if (urls.some((url) => url)) {
          facs = parsed.pages.map((pg, index) => ({
            url: urls[index],
            w: pg.width,
            h: pg.height,
            zones: pg.zones.map((z) => ({ box: z.box, label: z.label })),
          }));
        }
      }

      // A score without facsimile pages is rendered as-is; a facsimile score
      // only once its measures exist (stage A has nothing to render). With
      // encoded breaks Verovio paginates on the <pb/> elements, so encoding
      // pages line up with the facsimile pages.
      let pageCount = 0;
      if (!parsed.pages.length || parsed.hasMeasures) {
        const tk = await getVerovio();
        tk.setOptions({ breaks: parsed.hasBreaks ? "encoded" : "auto" });
        if (!tk.loadData(mei)) throw new Error(`Verovio could not parse ${path}.`);
        pageCount = tk.getPageCount();
      }

      if (preview?.key === path) {
        preview = {
          key: path,
          loading: false,
          facs,
          pageCount,
          svgs: {},
        };
        const total = Math.max(facs?.length ?? 0, pageCount);
        pvFirstVisible = Math.min(from, Math.max(0, total - 1));
        renderSpread();
      }
    } catch (e) {
      if (preview?.key === path)
        preview = {
          key: path,
          loading: false,
          error: `Preview failed: ${(e as Error).message}`,
          pageCount: 0,
          svgs: {},
        };
    }
  }

  // The score loads when the preview opens, and again when another score is
  // put in front of it.
  $effect(() => {
    const path = fragment;
    untrack(() => loadPreview(path, startPage));
  });
</script>

<div class="preview">
  <div class="ptoolbar">
    {#if preview?.facs?.length}
      <!-- Where the toolbar is too narrow for the labels, the buttons carry
           their icon alone; the label stays for screen readers. -->
      <div class="seg paneseg">
        <button
          type="button"
          class:on={pane === "facs"}
          onclick={() => setPane("facs")}
          title="Show the page images of the source"
          ><span class="ico" aria-hidden="true">▤</span><span class="lbl"
            >Facsimile</span
          ></button
        >
        <button
          type="button"
          class:on={pane === "enc"}
          onclick={() => setPane("enc")}
          title="Show the encoding rendered as notation"
          ><span class="ico" aria-hidden="true">♪</span><span class="lbl"
            >Rendered encoding</span
          ></button
        >
        <button
          type="button"
          class:on={pane === "both"}
          onclick={() => setPane("both")}
          title="Show the facsimile and the rendered encoding next to each other"
          ><span class="ico" aria-hidden="true">⧉</span><span class="lbl"
            >Side by side</span
          ></button
        >
      </div>
    {/if}
    <button
      type="button"
      class="btn btn-icon"
      onclick={() => pvGo(-1)}
      disabled={pvSpreadIndex <= 0}
      aria-label="Previous page">‹</button
    >
    <span class="pglabel">{pvSpreadLabel}</span>
    <button
      type="button"
      class="btn btn-icon"
      onclick={() => pvGo(1)}
      disabled={pvSpreadIndex >= pvSpreads.length - 1}
      aria-label="Next page">›</button
    >
    <div class="seg" title="How many pages the viewer shows at once">
      <button
        type="button"
        class:on={pvView === "single"}
        onclick={() => pvSetView("single")}>1 page</button
      >
      <button
        type="button"
        class:on={pvView === "double"}
        onclick={() => pvSetView("double")}>2 pages</button
      >
    </div>
    {#if pvView === "double"}
      <label
        class="pcheck"
        title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens"
      >
        <input
          type="checkbox"
          checked={pvFirstOnRight}
          onchange={(e) =>
            pvSetFirstOnRight((e.target as HTMLInputElement).checked)}
        />
        Page 1 right
      </label>
    {/if}
    <span class="mspacer"></span>
    {#if facsVisible}
      <button
        type="button"
        class="chip-switch"
        class:on={showZones}
        onclick={() => (showZones = !showZones)}
        title="Show or hide the measure zones on the facsimile"
        ><span class="sw"></span>Measure zones</button
      >
    {/if}
    {#if selected !== null}
      <button
        type="button"
        class="tchip on"
        onclick={() => selectMeasure(selected)}
        title="Clear the measure selection">m. {selected} ✕</button
      >
    {/if}
    <span class="vline"></span>
    <input
      class="zoomslider"
      type="range"
      aria-label="Zoom"
      aria-valuetext={`${Math.round(pvZoom * 100)}%`}
      min={0}
      max={PV_ZOOM_STOPS}
      step={1}
      value={pvZoomPos}
      oninput={(e) => setPvZoomPos(Number((e.target as HTMLInputElement).value))}
    />
    <span class="zval mono">{Math.round(pvZoom * 100)}%</span>
    <button
      type="button"
      class="tbtn"
      onclick={() => (pvZoom = 1)}
      title="Reset the zoom so a page fits the pane">Fit</button
    >
    {@render trailing?.()}
  </div>
  <div class="pbody-panes">
    {#if !preview || preview.loading}
      <p class="muted pnote">Loading the score…</p>
    {:else if preview.error}
      <p class="perr">{preview.error}</p>
    {:else}
      {#if facsVisible && preview.facs?.length}
        <div class="pane">
          <div class="pv-scroll" class:noh={pvZoom <= 1}>
            <div
              class="pv-spread"
              class:hug-right={pane === "both"}
              style={`width:${pvZoom * 100}%`}
            >
              {#if pvSpread.lonelySide === "right"}<div class="pv-spacer"></div>{/if}
              {#each pvSpread.pages as p (p)}
                {@const pg = preview.facs[p]}
                <figure class="pv-page">
                  {#if pg}
                    <svg
                      viewBox={`0 0 ${pg.w} ${pg.h}`}
                      role="img"
                      aria-label={`Facsimile page ${p + 1}`}
                    >
                      {#if pg.url}
                        <image href={pg.url} width={pg.w} height={pg.h} />
                      {:else}
                        <rect width={pg.w} height={pg.h} fill="#f3f3f0" />
                      {/if}
                      {#if showZones}
                        {#each pg.zones as z, zi (zi)}
                          <rect
                            class="pv-zone"
                            vector-effect="non-scaling-stroke"
                            class:flagged={anchor &&
                              p + 1 === anchor.page &&
                              zoneFlagged(z.label)}
                            class:sel={selected === z.label}
                            role="button"
                            tabindex={0}
                            aria-label={`Measure ${z.label}: highlight in both panes`}
                            x={z.box.ulx}
                            y={z.box.uly}
                            width={z.box.lrx - z.box.ulx}
                            height={z.box.lry - z.box.uly}
                            onclick={() => selectMeasure(z.label)}
                            onkeydown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                selectMeasure(z.label);
                              }
                            }}
                          />
                          <text
                            class="pv-zonelabel"
                            class:flagged={anchor &&
                              p + 1 === anchor.page &&
                              zoneFlagged(z.label)}
                            class:sel={selected === z.label}
                            x={z.box.ulx + 6}
                            y={z.box.uly + 30}>{z.label}</text
                          >
                        {/each}
                      {/if}
                    </svg>
                    <figcaption class="mono">page {p + 1}</figcaption>
                  {/if}
                </figure>
              {/each}
              {#if pvSpread.lonelySide === "left"}<div class="pv-spacer"></div>{/if}
            </div>
          </div>
          <div class="pane-cap">Facsimile</div>
        </div>
      {/if}
      {#if encVisible && preview.pageCount > 0}
        <div class="pane">
          <div class="pv-scroll" class:noh={pvZoom <= 1}>
            <div
              class="pv-spread"
              class:hug-left={pane === "both"}
              style={`width:${pvZoom * 100}%`}
            >
              {#if pvSpread.lonelySide === "right"}<div class="pv-spacer"></div>{/if}
              {#each pvSpread.pages as p (p)}
                <!-- The click lands on whichever rendered measure it hit; the
                     keyboard path to selection is the facsimile zones. -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class="pv-page enc" onclick={encClick}>
                  {#if p < preview.pageCount}
                    {@html flaggedSvgs[p + 1] ?? ""}
                  {/if}
                </div>
              {/each}
              {#if pvSpread.lonelySide === "left"}<div class="pv-spacer"></div>{/if}
            </div>
          </div>
          <div class="pane-cap">Current encoding — rendered with Verovio</div>
        </div>
      {:else if encVisible && preview.facs?.length}
        <div class="pane">
          <p class="muted pnote">
            No encoding to render yet — the measures are generated when the
            measure correction is submitted.
          </p>
          <div class="pane-cap">Current encoding</div>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .muted {
    color: var(--ink-faint);
  }
  .mspacer {
    flex: 1;
  }
  .preview {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    /* The toolbar reacts to the width of the preview, which is narrower than
       the window wherever a rail sits beside it. */
    container-type: inline-size;
  }

  /* -------------------------------------------------------------- toolbar */
  .ptoolbar {
    height: 44px;
    flex: none;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow-sm);
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 10px;
    overflow-x: auto;
  }
  .paneseg {
    flex: none;
  }
  .paneseg .ico {
    display: none;
    font-size: 14px;
    line-height: 1;
  }
  /* Below this the labels no longer fit beside the paging and zoom controls, so
     the pane buttons keep their icon and hide their label from sight only. */
  @container (max-width: 900px) {
    .paneseg button {
      padding: 4px 10px;
    }
    .paneseg .ico {
      display: inline-block;
    }
    .paneseg .lbl {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  }
  .pcheck {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  /* ---------------------------------------------------------------- panes */
  .pbody-panes {
    flex: 1;
    min-height: 0;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    border-radius: 10px;
    display: flex;
    gap: 10px;
    padding: 10px 10px 4px;
  }
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-height: 0;
  }
  .pane-cap {
    font-size: 10.5px;
    color: var(--ink-faint);
    text-align: center;
    flex: none;
    padding-bottom: 2px;
  }
  .pnote,
  .perr {
    margin: 0;
    padding: 14px;
    font-size: 12px;
  }
  .perr {
    color: var(--danger);
  }
  .pv-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  /* At 100% zoom and below the spread fits the pane's width, so no sideways
     scrollbar can appear (a vertical scrollbar that takes up space would
     otherwise provoke one). */
  .pv-scroll.noh {
    overflow-x: hidden;
  }
  /* Its width is the zoom level, so it must be free to fall below the pane's
     width — no min-width. Centred, so the fold of a two-page spread sits in the
     middle of the pane and a lone page keeps its side of it. */
  .pv-spread {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    box-sizing: border-box;
    margin-inline: auto;
  }
  /* Side by side, the two panes' pages meet in the middle rather than each
     centring in its own half. */
  .pv-spread.hug-right {
    margin-right: 0;
  }
  .pv-spread.hug-left {
    margin-left: 0;
  }
  .pv-spacer,
  .pv-page {
    flex: 1 1 0;
    min-width: 0;
  }
  .pv-page {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .pv-page > svg {
    width: 100%;
    height: auto;
    display: block;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--facsimile-paper);
  }
  /* The rendered pages are paper: they stay light in both themes. */
  .pv-page.enc :global(svg) {
    width: 100%;
    height: auto;
    display: block;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fdfdfe;
  }
  .pv-page figcaption {
    font-size: 10px;
    color: var(--ink-faint);
    text-align: center;
  }
  /* Strokes are screen pixels — the markup sets
     vector-effect="non-scaling-stroke" — so they stay even at every zoom. */
  .pv-zone {
    fill: rgba(109, 195, 255, 0.12);
    stroke: rgba(37, 99, 201, 0.55);
    stroke-width: 1.5;
    cursor: pointer;
  }
  .pv-zone.flagged {
    fill: rgba(180, 35, 24, 0.1);
    stroke: #b42318;
    stroke-width: 2.5;
  }
  .pv-zone.sel {
    fill: rgba(37, 99, 201, 0.18);
    stroke: #2563c9;
    stroke-width: 2.5;
  }
  .pv-zonelabel {
    font:
      24px ui-monospace,
      monospace;
    fill: #1a1a1a;
    paint-order: stroke;
    stroke: #fff;
    stroke-width: 4;
  }
  .pv-zonelabel.flagged {
    fill: #b42318;
    font-weight: 600;
  }
  .pv-zonelabel.sel {
    fill: #2563c9;
    font-weight: 600;
  }
  /* The whole page is clickable (clicks resolve to a measure's bounding
     box), so the cursor says so everywhere on it. */
  .pv-page.enc :global(svg) {
    cursor: pointer;
  }
  .pv-page.enc :global(g.measure.m-flag *) {
    fill: #b42318;
    stroke: #b42318;
  }
  /* The selection wins over a fail flag where both mark the same measure. */
  .pv-page.enc :global(g.measure.m-sel *) {
    fill: #2563c9;
    stroke: #2563c9;
  }
</style>
