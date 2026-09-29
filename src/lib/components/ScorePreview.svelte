<!--
  The score viewer: one MEI shown as its facsimile pages, as the encoding
  rendered by Verovio, or both side by side, as scrolling rows of one or two
  pages with zoom shared by the panes. The pane choice is a per-browser preference (see
  preview-pane.ts), so it carries from one preview to the next.

  A caller can pass a measure range to highlight, which marks those measures in
  both panes.
-->
<script module lang="ts">
  // Once the user picks a view or flips the recto toggle, the choice holds for
  // every score opened in this session; before that, each score opens in its
  // default view. Module-level so it survives the component being remounted.
  let viewChosen = false;
</script>

<script lang="ts">
  import { type MeasureAnchor } from "$lib/campaign-tables.ts";
  import Icon from "$lib/components/Icon.svelte";
  import { tick, untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import type { MeasureBox } from "$lib/mei-facsimile.ts";
  import { resolveFacsimileImageUrls } from "$lib/facsimile-images.ts";
  import {
    buildSpreads,
    defaultSpreadView,
    pagesLabelCh,
    shownPagesLabel,
  } from "$lib/page-spreads.ts";
  import {
    applyAnchor,
    readAnchor,
    rowView,
    scrollToRow,
  } from "$lib/page-scroll.ts";
  import {
    A4_ASPECT,
    getVerovio,
    loadedVerovio,
    loadScore,
    renderPage,
  } from "$lib/verovio-render.ts";
  import { readPreviewPane, writePreviewPane } from "$lib/preview-pane.ts";
  import FitIcon from "./FitIcon.svelte";
  import type { PreviewPane } from "$lib/preview-pane.ts";

  let {
    owner,
    repo,
    fragment,
    startPage = 0,
    anchor = null,
    initialPane = null,
    initialView = null,
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
    anchor?: MeasureAnchor | null;
    /** The pane the preview opens with; null uses the stored per-browser choice. */
    initialPane?: PreviewPane | null;
    /** The spread view the preview opens with; null picks it from the page count. */
    initialView?: "single" | "double" | null;
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
    /** A rendered encoding page's height over its width. */
    encAspect: number;
    /** Rendered encoding pages, filled lazily as they near the view (1-based). */
    svgs: Record<number, string>;
  } | null>(null);

  // Display state: which panes show, the rows of one or two pages and the zoom
  // shared by them, and the zone overlay toggle.
  // svelte-ignore state_referenced_locally -- an initial value by contract
  let pvPane = $state<PreviewPane>(initialPane ?? readPreviewPane());
  let pvView = $state<"single" | "double">("single");
  let pvFirstOnRight = $state(true);
  let pvZoom = $state(1);
  // svelte-ignore state_referenced_locally -- an initial value by contract
  let showZones = $state(initialZones);

  // Scores without a facsimile only have the render to show.
  const pane = $derived(preview?.facs?.length ? pvPane : "enc");
  const facsVisible = $derived(pane === "facs" || pane === "both");
  const encVisible = $derived(pane === "enc" || pane === "both");
  // The panes that have pages to show.
  const showFacs = $derived(facsVisible && !!preview?.facs?.length);
  const showEnc = $derived(encVisible && (preview?.pageCount ?? 0) > 0);

  function setPane(choice: PreviewPane) {
    pvPane = choice;
    writePreviewPane(choice);
  }

  const PV_ZOOM_MIN = 0.2;
  const PV_ZOOM_MAX = 4;
  // The slider runs on a log scale: equal drags multiply the zoom equally,
  // so the low end moves in fine steps and the high end in coarse ones.
  const PV_ZOOM_STOPS = 100;
  const pvZoomPos = $derived(
    Math.round(
      (Math.log(pvZoom / PV_ZOOM_MIN) / Math.log(PV_ZOOM_MAX / PV_ZOOM_MIN)) *
        PV_ZOOM_STOPS,
    ),
  );
  const setPvZoomPos = (p: number) =>
    (pvZoom =
      Math.round(
        PV_ZOOM_MIN * (PV_ZOOM_MAX / PV_ZOOM_MIN) ** (p / PV_ZOOM_STOPS) * 100,
      ) / 100);
  // The fit in force, if any: it keeps the zoom at the fit as the pane
  // resizes or the view changes, until the slider is moved.
  let pvFit = $state<"width" | "page" | null>("page");

  const pvPageTotal = $derived(
    preview ? Math.max(preview.facs?.length ?? 0, preview.pageCount) : 0,
  );
  const pvSpreads = $derived(buildSpreads(pvPageTotal, pvView, pvFirstOnRight));
  // The scroll area's inner size, for the whole-page fit. Both panes share it.
  let pvScrollW = $state(0);
  let pvScrollH = $state(0);
  // The zoom at which every page fits the pane top to bottom: bounded by the
  // tallest page, capped at 1 (the width fit).
  const pvFitPage = $derived.by(() => {
    if (!preview || !pvScrollW || !pvScrollH) return 1;
    // Each page's aspect, with the height it needs beyond the sheet: the
    // caption above it and the border.
    const needs: { aspect: number; extra: number }[] = [];
    if (showFacs)
      for (const pg of preview.facs ?? [])
        needs.push({ aspect: pg.h / pg.w, extra: 22 });
    if (showEnc) needs.push({ aspect: preview.encAspect, extra: 22 });
    if (!needs.length) return 1;
    // A row holds each shown pane's pages, 10px between the panes and 14px
    // between a pane's pages.
    const halves = showFacs && showEnc ? 2 : 1;
    const perHalf = pvView === "double" ? 2 : 1;
    const halfW = (pvScrollW - 10 * (halves - 1)) / halves;
    const colW = (halfW - 14 * (perHalf - 1)) / perHalf;
    const z = Math.min(
      ...needs.map((n) => (pvScrollH - n.extra) / (colW * n.aspect)),
    );
    return Math.min(1, Math.max(PV_ZOOM_MIN, Math.floor(z * 1000) / 1000));
  });
  $effect(() => {
    if (pvFit === "width") pvZoom = 1;
    else if (pvFit === "page") pvZoom = pvFitPage;
  });

  // One scroll area holds both panes, as rows of one spread each.
  let pvScroller = $state<HTMLElement | null>(null);
  let pvRowEls = $state<HTMLElement[]>([]);
  // What the scroll area shows, read from its scroll position.
  let pvRow = $state(0);
  let pvShownRows = $state<number[]>([]);
  let pvNearPages = $state<number[]>([]);
  let pvAtTop = $state(true);
  let pvAtEnd = $state(true);
  // The position the scroll area returns to when its rows change size, kept
  // by page so it survives the rows being re-sliced.
  let pvAnchor: { page: number; frac: number; x?: number } = {
    page: 0,
    frac: 0,
  };
  const pvLabel = $derived(
    shownPagesLabel(
      pvSpreads,
      pvShownRows.length ? pvShownRows : [pvRow],
      pvPageTotal,
    ),
  );

  const pvRows = () => pvRowEls.slice(0, pvSpreads.length);
  function pvScrolled() {
    if (!pvScroller) return;
    const v = rowView(pvScroller, pvRows());
    pvRow = v.current;
    pvShownRows = v.shown;
    pvAtTop = v.atTop;
    pvAtEnd = v.atEnd;
    const near = v.near.flatMap((r) => pvSpreads[r]?.pages ?? []);
    if (near.join() !== pvNearPages.join()) {
      pvNearPages = near;
      renderNear();
    }
    const a = readAnchor(pvScroller, pvRows());
    if (a)
      pvAnchor = {
        page: pvSpreads[a.row]?.pages[0] ?? 0,
        frac: a.frac,
        x: a.x,
      };
  }
  // Zoom, the view and the pane size move every row; once the rows are laid
  // out anew, the scroll area returns to the remembered position.
  $effect(() => {
    void [pvZoom, pvSpreads, pvScrollW, pvScrollH, pane];
    tick().then(() => {
      const row = pvSpreads.findIndex((s) => s.pages.includes(pvAnchor.page));
      if (!pvScroller || row < 0) return;
      applyAnchor(pvScroller, pvRows(), { ...pvAnchor, row });
      pvScrolled();
    });
  });

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
      const shown = pvShownRows.some((r) => pvSpreads[r]?.pages.includes(p));
      if (p >= 0 && !shown) showPage(p);
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

  // Render the encoding pages near the view (kept for later visits).
  function renderNear() {
    const tk = loadedVerovio();
    if (!preview || preview.loading || !tk || preview.pageCount === 0) return;
    let added = false;
    const svgs = { ...preview.svgs };
    for (const p of pvNearPages) {
      const n = p + 1;
      if (n <= preview.pageCount && !svgs[n]) {
        svgs[n] = renderPage(tk, n);
        added = true;
      }
    }
    if (added) preview = { ...preview, svgs };
  }
  // One row on. Back from partway down a row returns to that row's top first.
  function pvGo(delta: number) {
    if (!pvScroller) return;
    const a = readAnchor(pvScroller, pvRows());
    let row = pvRow + delta;
    if (delta < 0 && a && a.row === pvRow && a.frac > 0.02) row = pvRow;
    const next = pvSpreads[Math.max(0, Math.min(pvSpreads.length - 1, row))];
    if (next) showPage(next.pages[0]);
  }
  function pvSetView(v: "single" | "double") {
    pvView = v;
    viewChosen = true;
  }
  function pvSetFirstOnRight(on: boolean) {
    pvFirstOnRight = on;
    viewChosen = true;
  }

  /**
   * Which page a measure sits on, read from the facsimile's zone labels; -1
   * when the score has no facsimile to say.
   */
  export function pageOfMeasure(label: string): number {
    return (
      preview?.facs?.findIndex((pg) =>
        pg.zones.some((z) => z.label === label),
      ) ?? -1
    );
  }

  /** Scroll a page's row (0-based page) to the top of the scroll area. */
  export function showPage(page: number) {
    const row = pvSpreads.findIndex((s) => s.pages.includes(page));
    if (row < 0) return;
    pvAnchor = { page: pvSpreads[row].pages[0], frac: 0 };
    if (!pvScroller) return;
    scrollToRow(pvScroller, pvRows(), row);
    pvScrolled();
  }

  /** The first page of the row being read, 0-based. */
  export function currentPage(): number {
    return pvSpreads[pvRow]?.pages[0] ?? 0;
  }

  // The whole-page fit also scrolls the row being read to the top, so its
  // pages are in view from top to bottom.
  function pvFitWholePage() {
    const page = currentPage();
    pvFit = "page";
    tick().then(() => showPage(page));
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
      encAspect: A4_ASPECT,
      svgs: {},
    };
    pvAnchor = { page: 0, frac: 0 };
    pvNearPages = [];
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

      // A score without facsimile pages is rendered on A4 pages; a facsimile
      // score on pages of the facsimile's proportions, and only once its
      // measures exist (stage A has nothing to render). With encoded breaks
      // Verovio paginates on the <pb/> elements, so encoding pages line up
      // with the facsimile pages.
      let pageCount = 0;
      const aspects = parsed.pages
        .filter((pg) => pg.width > 0 && pg.height > 0)
        .map((pg) => pg.height / pg.width)
        .sort((a, b) => a - b);
      const encAspect = aspects.length
        ? aspects[Math.floor(aspects.length / 2)]
        : A4_ASPECT;
      if (!parsed.pages.length || parsed.hasMeasures) {
        const tk = await getVerovio();
        const ok = loadScore(tk, mei, {
          aspect: encAspect,
          encodedBreaks: parsed.hasBreaks,
        });
        if (!ok) throw new Error(`Verovio could not parse ${path}.`);
        pageCount = tk.getPageCount();
      }

      if (preview?.key === path) {
        preview = {
          key: path,
          loading: false,
          facs,
          pageCount,
          encAspect,
          svgs: {},
        };
        const total = Math.max(facs?.length ?? 0, pageCount);
        if (initialView) pvView = initialView;
        else if (!viewChosen)
          ({ view: pvView, firstOnRight: pvFirstOnRight } =
            defaultSpreadView(total));
        await tick();
        if (preview?.key === path)
          showPage(Math.min(from, Math.max(0, total - 1)));
      }
    } catch (e) {
      if (preview?.key === path)
        preview = {
          key: path,
          loading: false,
          error: `Preview failed: ${(e as Error).message}`,
          pageCount: 0,
          encAspect: A4_ASPECT,
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
          ><span class="ico" aria-hidden="true"><Icon name="facsimile" /></span
          ><span class="lbl">Facsimile</span></button
        >
        <button
          type="button"
          class:on={pane === "enc"}
          onclick={() => setPane("enc")}
          title="Show the encoding rendered as notation"
          ><span class="ico" aria-hidden="true"><Icon name="notes" /></span
          ><span class="lbl">Rendered encoding</span></button
        >
        <button
          type="button"
          class:on={pane === "both"}
          onclick={() => setPane("both")}
          title="Show the facsimile and the rendered encoding next to each other"
          ><span class="ico" aria-hidden="true"
            ><Icon name="side-by-side" /></span
          ><span class="lbl">Side by side</span></button
        >
      </div>
    {/if}
    <div class="seg" title="How many pages the viewer shows side by side">
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
        title="Clear the measure selection"
        >m. {selected} <Icon name="close" size={11} /></button
      >
    {/if}
    <span class="mspacer"></span>
    <input
      class="zoomslider"
      type="range"
      aria-label="Zoom"
      aria-valuetext={`${Math.round(pvZoom * 100)}%`}
      min={0}
      max={PV_ZOOM_STOPS}
      step={1}
      value={pvZoomPos}
      oninput={(e) => {
        setPvZoomPos(Number((e.target as HTMLInputElement).value));
        pvFit = null;
      }}
    />
    <span class="zval mono">{Math.round(pvZoom * 100)}%</span>
    <button
      type="button"
      class="tbtn tbtn-icon"
      class:on={pvFit === "width"}
      onclick={() => (pvFit = "width")}
      aria-label="Fit the page width"
      title="Fit the page width to the pane"><FitIcon kind="width" /></button
    >
    <button
      type="button"
      class="tbtn tbtn-icon"
      class:on={pvFit === "page"}
      onclick={pvFitWholePage}
      aria-label="Fit the whole page"
      title="Fit the whole page in the pane, top to bottom"
      ><FitIcon kind="page" /></button
    >
    {@render trailing?.()}
    <!-- Last in the toolbar, next to the task panel on the right. -->
    <div class="pgnav">
      <span class="vline"></span>
      <button
        type="button"
        class="btn btn-icon pgbtn"
        onclick={() => pvGo(-1)}
        disabled={pvAtTop}
        aria-label="Previous page"><Icon name="chevron-left" /></button
      >
      <span class="pglabel" style={`min-width:${pagesLabelCh(pvPageTotal)}ch`}
        >{pvLabel}</span
      >
      <button
        type="button"
        class="btn btn-icon pgbtn"
        onclick={() => pvGo(1)}
        disabled={pvAtEnd}
        aria-label="Next page"><Icon name="chevron-right" /></button
      >
    </div>
  </div>
  <div class="pbody-panes">
    {#if !preview || preview.loading}
      <p class="muted pnote">Loading the score…</p>
    {:else if preview.error}
      <p class="perr">{preview.error}</p>
    {:else}
      <!-- Keyed on the pane choice so a pane that survives the switch is still
           rebuilt: its size binding otherwise stops reporting once its
           sibling pane is removed. -->
      {#key pane}
        {#if showFacs || showEnc}
          <div class="pane">
            <div
              class="pv-scroll"
              class:noh={pvZoom <= 1}
              bind:this={pvScroller}
              bind:clientWidth={pvScrollW}
              bind:clientHeight={pvScrollH}
              onscroll={pvScrolled}
            >
              {#each pvSpreads as sp, r (r)}
                <div
                  class="pv-row"
                  style={`width:${pvZoom * 100}%`}
                  bind:this={pvRowEls[r]}
                >
                  {#if showFacs && preview.facs}
                    <div class="pv-spread">
                      {#if sp.lonelySide === "right"}<div
                          class="pv-spacer"
                        ></div>{/if}
                      {#each sp.pages as p (p)}
                        {@const pg = preview.facs[p]}
                        {@const near = pvNearPages.includes(p)}
                        <figure class="pv-page">
                          {#if pg}
                            <figcaption class="page-label">
                              Page {p + 1} · Facsimile
                            </figcaption>
                            <svg
                              viewBox={`0 0 ${pg.w} ${pg.h}`}
                              role="img"
                              aria-label={`Facsimile page ${p + 1}`}
                            >
                              {#if pg.url && near}
                                <image
                                  href={pg.url}
                                  width={pg.w}
                                  height={pg.h}
                                />
                              {:else}
                                <rect
                                  width={pg.w}
                                  height={pg.h}
                                  fill="#f3f3f0"
                                />
                              {/if}
                              {#if showZones && near}
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
                          {/if}
                        </figure>
                      {/each}
                      {#if sp.lonelySide === "left"}<div
                          class="pv-spacer"
                        ></div>{/if}
                    </div>
                  {/if}
                  {#if showEnc}
                    <div class="pv-spread">
                      {#if sp.lonelySide === "right"}<div
                          class="pv-spacer"
                        ></div>{/if}
                      {#each sp.pages as p (p)}
                        <figure class="pv-page">
                          <!-- A page past the encoding's last keeps an unseen
                               caption, so the sheets beside it stay level. -->
                          <figcaption
                            class="page-label"
                            class:blank={p >= preview.pageCount}
                            title="The current encoding, rendered with Verovio"
                          >
                            Page {p + 1} · Encoding
                          </figcaption>
                          <!-- The click lands on whichever rendered measure it
                               hit; the keyboard path to selection is the
                               facsimile zones. The box keeps the page's shape
                               before the page is rendered. -->
                          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                          <div
                            class="pv-sheet"
                            style={`aspect-ratio:1/${preview.encAspect}`}
                            onclick={encClick}
                          >
                            {#if p < preview.pageCount}
                              {@html flaggedSvgs[p + 1] ?? ""}
                            {/if}
                          </div>
                        </figure>
                      {/each}
                      {#if sp.lonelySide === "left"}<div
                          class="pv-spacer"
                        ></div>{/if}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
        {#if encVisible && !showEnc && preview.facs?.length}
          <div class="pane">
            <p class="muted pnote">
              No encoding to render yet — the measures are generated when the
              measure correction is submitted.
            </p>
            <div class="pane-cap">Current encoding</div>
          </div>
        {/if}
      {/key}
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
  @container (max-width: 1200px) {
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
    padding: 10px;
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
  /* The scroll position is kept by page (see pvAnchor), not by the browser. */
  .pv-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
  }
  /* At 100% zoom and below the spread fits the pane's width, so no sideways
     scrollbar can appear (a vertical scrollbar that takes up space would
     otherwise provoke one). */
  .pv-scroll.noh {
    overflow-x: hidden;
  }
  /* One row per spread: the facsimile pages and the rendered pages side by
     side. Its width is the zoom level, so it must be free to fall below the
     pane's width — no min-width. Centred, so the fold of a two-page spread
     sits in the middle of the pane and a lone page keeps its side of it. */
  .pv-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    box-sizing: border-box;
    margin-inline: auto;
  }
  .pv-row + .pv-row {
    margin-top: 14px;
  }
  .pv-spread {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    gap: 14px;
    align-items: flex-start;
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
  .pv-sheet :global(svg) {
    width: 100%;
    height: auto;
    display: block;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fdfdfe;
  }
  .pv-page figcaption.blank {
    visibility: hidden;
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
  .pv-sheet :global(svg) {
    cursor: pointer;
  }
  .pv-sheet :global(g.measure.m-flag *) {
    fill: #b42318;
    stroke: #b42318;
  }
  /* The selection wins over a fail flag where both mark the same measure. */
  .pv-sheet :global(g.measure.m-sel *) {
    fill: #2563c9;
    stroke: #2563c9;
  }
</style>
