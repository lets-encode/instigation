<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { tick, untrack } from "svelte";
  import { page } from "$app/state";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type {
    CommandContext,
    FacsimileTaskData,
    Result,
  } from "$lib/commands.ts";
  import { readingOrderRows, nextLabel } from "$lib/mei-facsimile.ts";
  import { workStage, typeLabel } from "$lib/campaign-graph.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { readSidePanel, writeSidePanel } from "$lib/side-panels.ts";
  import type { PageModel, MeasureBox } from "$lib/mei-facsimile.ts";
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
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import RunnerBanner from "$lib/components/RunnerBanner.svelte";
  import PanelIcon from "$lib/components/PanelIcon.svelte";
  import PieceCommentsPanel from "$lib/components/PieceCommentsPanel.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import PreTaskReview from "$lib/components/PreTaskReview.svelte";
  import PreTaskStatus from "$lib/components/PreTaskStatus.svelte";
  import { PreTaskSession } from "$lib/pre-task-session.svelte.ts";
  import FitIcon from "$lib/components/FitIcon.svelte";
  import { createOmrClient } from "$lib/omr-client.ts";
  import {
    layoutBoxes,
    layoutRecord,
    LAYOUT_PARAMETERS,
    type CocoLayout,
  } from "$lib/omr-layout.ts";
  import { provider, omr as omrModels } from "$lib/forge/config.ts";
  import {
    clearCachedLayouts,
    readCachedLayouts,
    writeCachedLayout,
  } from "$lib/omr-layout-cache.ts";
  import { resolveRepoRelativeTarget } from "$lib/facsimile-images.ts";
  import {
    arrowShift,
    drawnBox,
    drawStarted,
    movedBox,
    nudgedEdges,
    pagePoint,
    resizedBox,
  } from "$lib/box-geometry.ts";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);

  // Editor-side zone: the box, the label override (null = automatic), the
  // computed label, and the break flags. The page break is derived from
  // position (each page's first measure), not stored per-zone.
  type EditZone = {
    box: MeasureBox;
    override: string | null;
    label: string;
    sb: boolean;
    mdiv: boolean;
  };
  // A staff or grand-staff box of an OMR-prepared piece: geometry only.
  type EditStaff = { box: MeasureBox };
  type EditPage = {
    image: string;
    width: number;
    height: number;
    url: string;
    // The background facsimile failed to load (empty download URL, or the
    // browser refused the request — e.g. a CSP img-src that omits the raw host).
    failed: boolean;
    zones: EditZone[];
    staves: EditStaff[];
    grandstaves: EditStaff[];
  };
  // The box layers. A measure-correction task edits measures with their
  // numbers and breaks; a layout task (OMR) edits the staff boxes first, then
  // the grand-staff boxes, then the measures, one layer at a time.
  type Layer = "measures" | "staves" | "grandstaves";

  const session = new PreTaskSession(
    () => campaign,
    () => taskId,
    {
      loaded(d) {
        selected = null;
        anchor = { page: 0, frac: 0 };
        rawLayouts = {};
        seen = { staves: [], grandstaves: [], measures: [] };
        pages = d.model.pages.map((pg, i) => ({
          image: pg.image,
          width: pg.width,
          height: pg.height,
          url: d.imageUrls[i],
          failed: !d.imageUrls[i],
          zones: pg.zones.map((z) => ({
            box: { ...z.box },
            override: null,
            label: z.label,
            sb: z.sb,
            mdiv: z.mdiv,
          })),
          staves: (pg.staves ?? []).map((box) => ({ box: { ...box } })),
          grandstaves: (pg.grandstaves ?? []).map((box) => ({
            box: { ...box },
          })),
        }));
        // A score of one or two pages is shown whole: one page, or both side
        // by side. Longer scores keep the two-up view with page 1 as a recto.
        if (pages.length <= 2)
          ({ view, firstOnRight } = defaultSpreadView(pages.length));
        // A label that differs from what automatic numbering would produce is
        // an override (e.g. 10a/10b) — keep it through renumbering.
        let prev: string | undefined;
        for (const pg of pages) {
          for (const zone of pg.zones) {
            if (zone.label !== nextLabel(prev)) zone.override = zone.label;
            prev = zone.label;
          }
        }
        resetHistory();
      },
      reset() {
        pages = [];
      },
      // A claim of an OMR layout task whose score carries no zones yet
      // continues into layout detection in the same overlay.
      afterClaim(f, d) {
        if (!needsDetection()) return null;
        detectedFor = taskId;
        return detectSteps(f, d.fragment);
      },
    },
  );
  const runner = session.runner;
  const data = $derived(session.data);
  const tables = $derived(session.tables);
  const holds = $derived(session.holds);
  const canEdit = $derived(session.canEdit);
  const busy = $derived(session.busy);
  const owner = $derived(session.campaign.owner);
  const repo = $derived(session.campaign.repo);
  const repoId = $derived(session.campaign.repoId);
  const viewer = $derived(session.viewer);
  // The task's kind: measure correction, which for an OMR-prepared piece
  // (omr-layout) also corrects the staff and grand-staff boxes.
  const taskTitle = $derived(typeLabel(data?.locator ?? "measure-zones"));
  const stage = $derived(workStage(data?.locator ?? "measure-zones"));
  const omr = $derived(data?.locator === "omr-layout");
  // A layout task's three steps: the staff boxes, the grand-staff boxes, the measures.
  let layoutStep = $state<1 | 2 | 3>(1);
  const STEP_LAYERS: Layer[] = ["staves", "grandstaves", "measures"];
  // The layer the pointer edits; in a layout task the others are not drawn.
  const tool = $derived<Layer>(omr ? STEP_LAYERS[layoutStep - 1] : "measures");
  function setLayoutStep(step: 1 | 2 | 3) {
    layoutStep = step;
    selected = null;
  }
  // A page's boxes in a layer, for the geometry code shared by all.
  const items = (p: number, layer: Layer = tool): { box: MeasureBox }[] =>
    layer === "staves"
      ? pages[p].staves
      : layer === "grandstaves"
        ? pages[p].grandstaves
        : pages[p].zones;
  let pages = $state<EditPage[]>([]);
  // The layout model's raw output per page index, kept from a detection run
  // in this session for the submission; outside the edit history.
  let rawLayouts = $state<Record<number, CocoLayout>>({});
  let selected = $state<{ p: number; z: number } | null>(null);
  // The zone whose controls show: the selected one.
  const active = $derived(selected);

  // Page zoom: the fraction of the canvas width one page occupies. 1 = fit the
  // canvas; above 1 the pages overflow and the desk scrolls horizontally.
  const ZOOM_MIN = 0.2;
  const ZOOM_MAX = 4;
  let zoom = $state(1);

  // The slider runs on a log scale: equal drags multiply the zoom equally,
  // so the low end moves in fine steps and the high end in coarse ones.
  const ZOOM_STOPS = 100;
  const zoomPos = $derived(
    Math.round(
      (Math.log(zoom / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * ZOOM_STOPS,
    ),
  );
  const setZoomPos = (p: number) =>
    (zoom =
      Math.round(ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (p / ZOOM_STOPS) * 100) /
      100);

  // The desk's inner size, for the whole-page fit.
  let deskW = $state(0);
  let deskH = $state(0);

  // The zoom at which a whole page fits in the desk: bounded by the height
  // (using the tallest page), capped at 1 (the width fit). 76 covers the
  // desk padding, the page heading above each sheet and the sheet's bottom
  // margin.
  function fitZoom(): number {
    if (!pages.length || !deskW || !deskH) return 1;
    const aspect = Math.max(...pages.map((p) => p.height / p.width));
    const pagesW = deskW - 48;
    const colW = view === "double" ? (pagesW - 4) / 2 : pagesW;
    const usableH = deskH - 76;
    if (colW <= 0 || usableH <= 0) return 1;
    const z = usableH / (colW * aspect);
    return Math.min(1, Math.max(ZOOM_MIN, Math.floor(z * 1000) / 1000));
  }

  // The fit in force, if any: it keeps the zoom at the fit as the desk
  // resizes or the view changes, until the slider is moved. Each freshly
  // loaded task opens at the whole-page fit.
  let fit = $state<"width" | "page" | null>("page");
  let zoomInitFor = $state<FacsimileTaskData | null>(null);
  $effect(() => {
    if (!data || zoomInitFor === data) return;
    zoomInitFor = data;
    fit = "page";
  });
  $effect(() => {
    if (fit === "width") zoom = 1;
    else if (fit === "page") zoom = fitZoom();
  });

  // The pages scroll as rows of one or two pages. `view` is one or two pages
  // per row; `firstOnRight` places page 1 as a right-hand page (recto), so a
  // two-up view pairs 2|3, 4|5, … the way a score opens — the printed page
  // number's side can't be read without OCR, so this convention (with the
  // toggle) stands in for it.
  let view = $state<"single" | "double">("double");
  let firstOnRight = $state(true);
  const spreads = $derived(buildSpreads(pages.length, view, firstOnRight));

  // The desk scrolls through the rows, one per spread.
  let desk = $state<HTMLElement | null>(null);
  let rowEls = $state<HTMLElement[]>([]);
  // What the desk shows, read from the scroll position.
  let rowIndex = $state(0);
  let shownRows = $state<number[]>([]);
  let nearPages = $state<number[]>([]);
  let atTop = $state(true);
  let atEnd = $state(true);
  // The position the desk returns to when the rows change size, kept by page
  // so it survives the rows being re-sliced.
  let anchor: { page: number; frac: number; x?: number } = {
    page: 0,
    frac: 0,
  };
  const shownPages = $derived(
    shownRows.flatMap((r) => spreads[r]?.pages ?? []),
  );
  const spreadLabel = $derived(
    shownPagesLabel(
      spreads,
      shownRows.length ? shownRows : [rowIndex],
      pages.length,
    ),
  );

  function deskScrolled() {
    if (!desk) return;
    const rows = rowEls.slice(0, spreads.length);
    const v = rowView(desk, rows);
    rowIndex = v.current;
    shownRows = v.shown;
    atTop = v.atTop;
    atEnd = v.atEnd;
    const near = v.near.flatMap((r) => spreads[r]?.pages ?? []);
    if (near.join() !== nearPages.join()) nearPages = near;
    const a = readAnchor(desk, rows);
    if (a)
      anchor = { page: spreads[a.row]?.pages[0] ?? 0, frac: a.frac, x: a.x };
  }
  // Zoom, the view, the desk size and a newly loaded task move every row; once
  // the rows are laid out anew, the desk returns to the remembered position.
  $effect(() => {
    void [zoom, spreads, deskW, deskH, pages];
    tick().then(() => {
      const row = spreads.findIndex((s) => s.pages.includes(anchor.page));
      if (!desk || row < 0) return;
      applyAnchor(desk, rowEls.slice(0, spreads.length), { ...anchor, row });
      deskScrolled();
    });
  });
  /** Scroll a page's row (0-based page) to the top of the desk. */
  function showPage(p: number) {
    const row = spreads.findIndex((s) => s.pages.includes(p));
    if (!desk || row < 0) return;
    anchor = { page: spreads[row].pages[0], frac: 0 };
    scrollToRow(desk, rowEls.slice(0, spreads.length), row);
    deskScrolled();
  }
  // The whole-page fit also scrolls the row being read to the top, so its
  // pages are in view from top to bottom.
  function fitWholePage() {
    const p = spreads[rowIndex]?.pages[0] ?? 0;
    fit = "page";
    tick().then(() => showPage(p));
  }

  // The pages a layout task has shown in each step. Submission waits until
  // every page has been on screen in both steps.
  let seen = $state<Record<Layer, number[]>>({
    staves: [],
    grandstaves: [],
    measures: [],
  });
  $effect(() => {
    if (!omr) return;
    const shown = shownPages;
    const layer = tool;
    untrack(() => {
      const added = shown.filter((p) => !seen[layer].includes(p));
      if (added.length) seen[layer] = [...seen[layer], ...added];
    });
  });
  const pageList = (ps: number[]) => ps.map((p) => p + 1).join(", ");
  // Why a layout task cannot be submitted yet, or null when it can.
  const submitBlock = $derived.by(() => {
    if (!omr) return null;
    const unseen = (layer: Layer) =>
      pages.flatMap((_, p) => (seen[layer].includes(p) ? [] : [p]));
    for (const [i, layer] of STEP_LAYERS.entries()) {
      const pending = unseen(layer);
      if (pending.length) {
        return `Show every page in step ${i + 1} before submitting. Not yet shown: page ${pageList(pending)}.`;
      }
    }
    const noMeasures = pages.flatMap((pg, p) =>
      pg.staves.length && !pg.zones.length ? [p] : [],
    );
    if (noMeasures.length) {
      return `Page ${pageList(noMeasures)} has staff boxes but no measures. Add its measures, or remove its staff boxes if the page has no music.`;
    }
    return null;
  });

  // One row on. Back from partway down a row returns to that row's top first.
  function go(delta: number) {
    if (!desk) return;
    const a = readAnchor(desk, rowEls.slice(0, spreads.length));
    let row = rowIndex + delta;
    if (delta < 0 && a && a.row === rowIndex && a.frac > 0.02) row = rowIndex;
    const next = spreads[Math.max(0, Math.min(spreads.length - 1, row))];
    if (!next) return;
    showPage(next.pages[0]);
    selected = null;
  }

  // Recompute every label from reading order + overrides ("10a" continues as 11).
  function renumber() {
    let prev: string | undefined;
    for (const pg of pages) {
      for (const zone of pg.zones) {
        zone.label = zone.override ?? nextLabel(prev);
        prev = zone.label;
      }
    }
  }

  // Re-sort a page's zones into reading order (after geometry changed), then
  // renumber everything.
  function resort(p: number) {
    const zones = pages[p].zones;
    const byBox = new Map(zones.map((z) => [z.box, z]));
    pages[p].zones = readingOrderRows(zones.map((z) => z.box))
      .flat()
      .map((box) => byBox.get(box)!);
    renumber();
  }

  // Staff and grand-staff boxes are kept top to bottom, then left to right.
  function resortStaves(p: number, layer: "staves" | "grandstaves" = "staves") {
    pages[p][layer].sort(
      (a, b) => a.box.uly - b.box.uly || a.box.ulx - b.box.ulx,
    );
  }

  const run = (
    command: (c: CommandContext) => Promise<Result>,
    opts?: { overviewOnSuccess?: boolean },
  ) => session.run(command, opts);

  // ------------------------------------------------------------- comments
  // The piece's comments panel beside the tool. Posting and resolving refresh
  // the tables only: a full reload would discard unsubmitted zone edits.
  let commentsPanel = $state(readSidePanel("comments"));
  // A comment anchor scrolls the desk to its page and selects the measure with
  // the anchored number where the page has one.
  function showAnchorFor(c: CommentRow) {
    const p = Number(c.page) - 1;
    if (!Number.isInteger(p) || p < 0 || p >= pages.length) return;
    showPage(p);
    const z = pages[p].zones.findIndex(
      (zone) => (zone.override ?? zone.label) === c.measure_start,
    );
    selected = z >= 0 ? { p, z } : null;
  }

  function toPageModels(): PageModel[] {
    return pages.map((pg) => ({
      image: pg.image,
      width: pg.width,
      height: pg.height,
      // The page break sits on each page's first measure; a page break implies
      // the system break, so its explicit sb flag is not carried.
      zones: pg.zones.map((z, i) => ({
        box: { ...z.box },
        label: z.label,
        pb: i === 0,
        sb: z.sb,
        mdiv: z.mdiv,
      })),
      ...(omr
        ? {
            staves: pg.staves.map((s) => ({ ...s.box })),
            grandstaves: pg.grandstaves.map((g) => ({ ...g.box })),
          }
        : {}),
    }));
  }

  // The raw layouts go with the submission when this session detected every page.
  const rawLayoutRecord = () =>
    pages.every((_, p) => rawLayouts[p])
      ? layoutRecord(
          omrModels.layoutModel,
          pages.map((pg, p) => ({ image: pg.image, layout: rawLayouts[p] })),
        )
      : undefined;

  const submit = () =>
    run(
      (c) =>
        omr
          ? invoke(
              commands.submitOmrLayout,
              {
                task_id: taskId,
                pages: toPageModels(),
                layout: rawLayoutRecord(),
              },
              c,
            )
          : invoke(
              commands.submitZones,
              { task_id: taskId, pages: toPageModels() },
              c,
            ),
      { overviewOnSuccess: true },
    );

  // ------------------------------------------------------------------------
  // Layout detection (OMR-prepared pieces)
  //
  // A layout task's boxes come from the Musibot layout model, run through
  // the broker's relay when the claim holder opens a task whose score carries
  // no boxes yet. Page bytes are read through the
  // forge API; the result is seeded like measure detection's: reading order,
  // continuous numbering, a system start on every row but the page's first.
  // Each page's model output is stored in the browser as it arrives and read
  // back by the next detection, until the loaded score carries boxes.
  let detectedFor = $state<string | null>(null);
  const needsDetection = () =>
    omr &&
    canEdit &&
    pages.length > 0 &&
    pages.every((pg) => pg.zones.length === 0 && pg.staves.length === 0);
  $effect(() => {
    const boxed = data?.model.pages.some(
      (pg) => pg.zones.length > 0 || (pg.staves?.length ?? 0) > 0,
    );
    if (omr && boxed) {
      clearCachedLayouts(repoId, taskId);
    }
  });
  $effect(() => {
    if (data && !runner.busy && detectedFor !== taskId && needsDetection()) {
      detectedFor = taskId;
      detectLayout();
    }
  });
  function seedLayout() {
    for (const pg of pages) {
      const rows = readingOrderRows(pg.zones.map((z) => z.box));
      const byBox = new Map(pg.zones.map((z) => [z.box, z]));
      pg.zones = rows.flatMap((row, r) =>
        row.map((box, i) => ({ ...byBox.get(box)!, sb: i === 0 && r > 0 })),
      );
    }
    renumber();
  }

  async function detectLayout() {
    const f = forge();
    if (!f || !data) return;
    const fragment = data.fragment;
    await runner.run(() => detectSteps(f, fragment));
  }

  // The detection steps, logged to the running command's overlay.
  async function detectSteps(
    f: ForgeClient,
    fragment: string,
  ): Promise<Result> {
    const client = createOmrClient(provider.brokerUrl);
    const cached = readCachedLayouts(repoId, taskId, omrModels.layoutModel);
    try {
      if (!pages.every((pg) => cached[pg.image])) {
        runner.log.step("Checking the recognition service");
        await client.requirePipelines([omrModels.layoutModel]);
      }
      let measures = 0;
      let staves = 0;
      let grandstaves = 0;
      for (const [p, pg] of pages.entries()) {
        runner.log.step(
          `Detecting the layout of page ${p + 1} of ${pages.length}`,
        );
        let layout = cached[pg.image];
        if (layout) {
          runner.log.detail(
            "Result stored in this browser from an earlier detection",
          );
        } else {
          layout = await detectPage(f, client, fragment, p, pg);
          writeCachedLayout(
            repoId,
            taskId,
            omrModels.layoutModel,
            pg.image,
            layout,
          );
        }
        rawLayouts[p] = layout;
        const boxes = layoutBoxes(layout, pg);
        pages[p].zones = boxes.measures.map((box) => ({
          box,
          override: null,
          label: "",
          sb: false,
          mdiv: false,
        }));
        pages[p].staves = boxes.staves.map((box) => ({ box }));
        pages[p].grandstaves = boxes.grandstaves.map((box) => ({ box }));
        resortStaves(p);
        resortStaves(p, "grandstaves");
        measures += boxes.measures.length;
        staves += boxes.staves.length;
        grandstaves += boxes.grandstaves.length;
        runner.log.detail(
          `${boxes.staves.length} staves, ${boxes.grandstaves.length} grand staves, ${boxes.measures.length} measures`,
        );
      }
      seedLayout();
      setLayoutStep(1);
      resetHistory();
      return {
        ok: true,
        message: `Layout detected: ${staves} staves, ${grandstaves} grand staves and ${measures} measures on ${pages.length} page(s). Correct the staff boxes, then the grand staves, then the measures, then submit.`,
      };
    } catch (e) {
      return { error: `Layout detection failed: ${(e as Error).message}` };
    }
  }

  // One page's layout from the model.
  async function detectPage(
    f: ForgeClient,
    client: ReturnType<typeof createOmrClient>,
    fragment: string,
    p: number,
    pg: EditPage,
  ): Promise<CocoLayout> {
    const path = resolveRepoRelativeTarget(fragment, pg.image);
    const image = path ? await f.getRepoFileBytes(owner, repo, path) : null;
    if (!image)
      throw new Error(
        `the image of page ${p + 1} (${pg.image}) could not be read.`,
      );
    return client.withPage(async (pageId) => {
      await client.upload(pageId, { "image.jpg": image });
      const execution = await client.run(
        pageId,
        omrModels.layoutModel,
        ["image.jpg"],
        LAYOUT_PARAMETERS,
      );
      if (execution.state !== "completed") {
        throw new Error(
          `the layout model failed on page ${p + 1}: ${execution.error ?? execution.state}.`,
        );
      }
      const files = await client.download(pageId, ["layout.json"]);
      return JSON.parse(await files["layout.json"].text()) as CocoLayout;
    });
  }

  // ------------------------------------------------------------------------
  // Undo / redo
  //
  // History holds full snapshots of the page zones. Each committed edit pushes
  // a snapshot; undo/redo move within the stack and restore one. `selected` is
  // a transient pointer, not part of a snapshot, so it is cleared on restore.
  let history = $state<EditPage[][]>([]);
  let historyIndex = $state(-1);

  function clonePages(src: EditPage[]): EditPage[] {
    return src.map((pg) => ({
      ...pg,
      zones: pg.zones.map((z) => ({ ...z, box: { ...z.box } })),
      staves: pg.staves.map((s) => ({ box: { ...s.box } })),
      grandstaves: pg.grandstaves.map((g) => ({ box: { ...g.box } })),
    }));
  }

  // Discard any history and start a fresh baseline (after a load/reload).
  function resetHistory() {
    history = [clonePages(pages)];
    historyIndex = 0;
  }

  // Record the current pages as a new entry, dropping any redo tail. The
  // history holds full snapshots, so it is capped: the oldest entries fall
  // off once the limit is reached.
  const HISTORY_LIMIT = 100;
  function commit() {
    history = history.slice(
      Math.max(0, historyIndex + 2 - HISTORY_LIMIT),
      historyIndex + 1,
    );
    history.push(clonePages(pages));
    historyIndex = history.length - 1;
  }

  // After a geometry change: re-sort the page's layer, keep the same box
  // selected across the re-sort (its index may change) so further edits need
  // no extra click, then record the step.
  function commitGeometry(p: number, z: number) {
    const item = items(p)[z];
    if (tool === "measures") resort(p);
    else resortStaves(p, tool);
    selected = { p, z: items(p).indexOf(item) };
    commit();
  }

  const canUndo = $derived(canEdit && historyIndex > 0);
  const canRedo = $derived(canEdit && historyIndex < history.length - 1);

  function undo() {
    if (!canUndo) return;
    historyIndex--;
    pages = clonePages(history[historyIndex]);
    selected = null;
  }

  function redo() {
    if (!canRedo) return;
    historyIndex++;
    pages = clonePages(history[historyIndex]);
    selected = null;
  }

  // ------------------------------------------------------------------------
  // Break flags
  //
  // The page break is derived from position (each page's first measure). A page
  // break implies a system break, so on a page's first measure the system flag
  // is fixed on and the button is disabled. The score's first measure always
  // opens the first movement, so its section flag is fixed on too.
  const pbAt = (z: number) => z === 0;
  const sbActive = (p: number, z: number) => pbAt(z) || pages[p].zones[z].sb;
  const sectionLocked = (p: number, z: number) => p === 0 && z === 0;

  function toggleSb(p: number, z: number) {
    if (!canEdit || pbAt(z)) return;
    pages[p].zones[z].sb = !pages[p].zones[z].sb;
    commit();
  }
  function toggleSection(p: number, z: number) {
    if (!canEdit || sectionLocked(p, z)) return;
    pages[p].zones[z].mdiv = !pages[p].zones[z].mdiv;
    commit();
  }

  function setLabel(p: number, z: number, value: string) {
    pages[p].zones[z].override = value.trim() === "" ? null : value.trim();
    renumber();
  }

  // ------------------------------------------------------------------------
  // Pointer interactions (box move / resize / draw)

  let svgEls = $state<SVGSVGElement[]>([]);
  // Each visible page's rendered canvas width (px), so the SVG number labels can
  // be sized to a near-constant on-screen size across zoom and 1-/2-page view.
  let canvasW = $state<number[]>([]);
  // On-screen height (px) for the number label at 100%; it grows a little with
  // zoom (damped) so it does not feel oversized zoomed out or small zoomed in.
  const LABEL_PX = 11;
  const labelFont = (p: number, pageW: number) => {
    const damp = Math.min(1.7, Math.max(0.8, 0.7 + 0.3 * zoom));
    const target = LABEL_PX * damp;
    return canvasW[p] ? (target * pageW) / canvasW[p] : target;
  };

  // The on-screen size of the measure controls, which take the number
  // label's place in the selected box; the delete button dodges this extent.
  const ZC_W_PX = 82;
  const ZC_H_PX = 22;
  type Drag = {
    kind: "move" | "resize" | "draw";
    layer: Layer;
    p: number;
    z: number;
    sx: number;
    sy: number;
    orig: MeasureBox;
    moved: boolean;
    // For a resize: which edges follow the pointer — "n", "s", "e", "w" or a
    // corner's pair ("nw", "se", …).
    edges: string;
    // A draw creates its box only once the pointer has moved a few
    // millimetres on screen, so a plain click leaves nothing behind.
    started: boolean;
  };
  let drag: Drag | null = null;
  // In page pixels: a box is at least MIN_BOX each way, a drawn box under
  // DROP_BELOW was a background click, and an arrow key moves NUDGE
  // (NUDGE_FAR with Shift).
  const MIN_BOX = 5;
  const DROP_BELOW = 8;
  const NUDGE = 2;
  const NUDGE_FAR = 10;

  // The cursor class for a resize handle: a corner gets the diagonal arrows,
  // a side the axis arrows.
  const resizeCursor = (edges: string) =>
    edges === "n" || edges === "s"
      ? "h-ns"
      : edges === "e" || edges === "w"
        ? "h-ew"
        : edges === "nw" || edges === "se"
          ? "h-nwse"
          : "h-nesw";

  const svgXY = (e: PointerEvent, p: number) =>
    pagePoint(e, svgEls[p].getBoundingClientRect(), pages[p]);

  // Start a move (from the zone body) or resize (from an edge or corner
  // handle) drag. A click on the zone body selects it even read-only; the
  // handles only exist in edit mode.
  function startZoneDrag(
    e: PointerEvent,
    p: number,
    z: number,
    kind: "move" | "resize",
    edges = "",
  ) {
    if (kind === "move") selected = { p, z };
    if (!canEdit) return;
    e.stopPropagation();
    selected = { p, z };
    const { x, y } = svgXY(e, p);
    drag = {
      kind,
      layer: tool,
      p,
      z,
      sx: x,
      sy: y,
      orig: { ...items(p)[z].box },
      moved: false,
      edges,
      started: true,
    };
  }

  function zoneKeydown(e: KeyboardEvent, p: number, z: number) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      selected = { p, z };
      return;
    }
    if (!canEdit || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
    selected = { p, z };
    const box = items(p)[z].box;
    const { dx, dy } = arrowShift(e.key, e.shiftKey ? NUDGE_FAR : NUDGE)!;
    Object.assign(box, movedBox(box, dx, dy, pages[p]));
    commitGeometry(p, z);
  }

  // Arrow keys on a focused resize handle move that handle's edges.
  function resizeKeydown(
    e: KeyboardEvent,
    p: number,
    z: number,
    edges: string,
  ) {
    if (!canEdit || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
    const box = items(p)[z].box;
    const { dx, dy } = arrowShift(e.key, e.shiftKey ? NUDGE_FAR : NUDGE)!;
    Object.assign(box, nudgedEdges(box, edges, dx, dy, MIN_BOX, pages[p]));
    commitGeometry(p, z);
  }

  function backgroundPointerDown(e: PointerEvent, p: number) {
    selected = null;
    if (!canEdit) return;
    const { x, y } = svgXY(e, p);
    const box = { ulx: x, uly: y, lrx: x, lry: y };
    drag = {
      kind: "draw",
      layer: tool,
      p,
      z: -1,
      sx: x,
      sy: y,
      orig: box,
      moved: false,
      edges: "",
      started: false,
    };
  }

  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const { x, y } = svgXY(e, drag.p);
    const dx = x - drag.sx;
    const dy = y - drag.sy;
    const pg = pages[drag.p];
    if (!drag.started) {
      if (!drawStarted(dx, dy, pg, canvasW[drag.p] || pg.width)) return;
      const box = { ...drag.orig };
      if (drag.layer !== "measures") pages[drag.p][drag.layer].push({ box });
      else
        pages[drag.p].zones.push({
          box,
          override: null,
          label: "",
          sb: false,
          mdiv: false,
        });
      drag.z = items(drag.p, drag.layer).length - 1;
      drag.started = true;
      selected = { p: drag.p, z: drag.z };
    }
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const box = items(drag.p, drag.layer)[drag.z].box;
    Object.assign(
      box,
      drag.kind === "move"
        ? movedBox(drag.orig, dx, dy, pg)
        : drag.kind === "draw"
          ? drawnBox(drag.sx, drag.sy, x, y, MIN_BOX)
          : resizedBox(drag.orig, drag.edges, x, y, MIN_BOX),
    );
  }

  function pointerUp() {
    if (!drag) return;
    const { kind, layer, p, z, moved, started } = drag;
    drag = null;
    // A draw that never crossed the threshold was a plain click.
    if (!started) return;
    if (kind === "draw") {
      const box = items(p, layer)[z].box;
      // A tiny drawn box was just a background click — drop it.
      if (box.lrx - box.ulx < DROP_BELOW || box.lry - box.uly < DROP_BELOW) {
        items(p, layer).splice(z, 1);
        selected = null;
        return;
      }
    }
    if (kind !== "draw" && !moved) return; // plain select / handle click, no move
    commitGeometry(p, z);
  }

  function deleteSelected() {
    if (!selected) return;
    deleteZone(selected.p, selected.z);
  }

  // Remove a box of the active layer.
  function deleteZone(p: number, z: number) {
    if (!canEdit) return;
    items(p).splice(z, 1);
    if (tool === "measures") resort(p);
    else resortStaves(p, tool);
    selected = null;
    commit();
  }

  function keydown(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    // Cmd/Ctrl+Z undoes; add Shift (or Ctrl+Y) to redo.
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === "ArrowRight") {
      go(1);
    } else if (e.key === "ArrowLeft") {
      go(-1);
    }
  }

  // Paint order for a page's zones: the selected zone is moved to the end so it
  // renders on top. SVG has no z-index, so an earlier zone would otherwise sit
  // under a later overlapping one and steal its pointer events.
  function paintOrder(
    pg: EditPage,
    p: number,
  ): { zone: EditZone; z: number }[] {
    const entries = pg.zones.map((zone, z) => ({ zone, z }));
    if (tool === "measures" && selected?.p === p) {
      const i = entries.findIndex((e) => e.z === selected!.z);
      if (i >= 0) entries.push(entries.splice(i, 1)[0]);
    }
    return entries;
  }

  // Same for the staff and grand-staff layers: the selected box paints last.
  function staffPaintOrder(
    pg: EditPage,
    p: number,
  ): { staff: EditStaff; s: number }[] {
    const entries = (tool === "grandstaves" ? pg.grandstaves : pg.staves).map(
      (staff, s) => ({ staff, s }),
    );
    if (tool !== "measures" && selected?.p === p) {
      const i = entries.findIndex((e) => e.s === selected!.z);
      if (i >= 0) entries.push(entries.splice(i, 1)[0]);
    }
    return entries;
  }

  const measureCount = $derived(pages.reduce((n, p) => n + p.zones.length, 0));
  const staffCount = $derived(pages.reduce((n, p) => n + p.staves.length, 0));
  const grandstaffCount = $derived(
    pages.reduce((n, p) => n + p.grandstaves.length, 0),
  );
  const movementCount = $derived(
    1 +
      pages.reduce(
        (n, pg, p) =>
          n + pg.zones.filter((z, i) => z.mdiv && (p > 0 || i > 0)).length,
        0,
      ),
  );
  // Whether a zone starts a movement in the emitted MEI (the very first
  // measure always opens the first one).
  const startsMovement = (p: number, z: number) =>
    sectionLocked(p, z) || (pages[p].zones[z].mdiv && (p > 0 || z > 0));

  // The at-a-glance flag markers drawn on the box label: § section, ⇱ page
  // beginning, ↵ system beginning (the page break already implies a system).
  const markers = (p: number, z: number) =>
    (startsMovement(p, z) ? "§" : "") +
    (pbAt(z) ? "⇱" : "") +
    (!pbAt(z) && pages[p].zones[z].sb ? "↵" : "");
  const labelText = (p: number, z: number) => {
    const m = markers(p, z);
    return (m ? m + " " : "") + pages[p].zones[z].label;
  };

  // Hover tooltip explaining a zone's break marker, if it carries one.
  const zoneTitle = (p: number, z: number) => {
    if (pbAt(z))
      return "⇱ page beginning — automatic: the first measure on each page";
    if (pages[p].zones[z].sb) return "↵ system beginning";
    return "";
  };

  // Measure/section colours reused for the box tint and the zone controls.
  // Teal and purple are deliberately outside the piece-region palette
  // (--zone-1…8), so a colour never carries two meanings.
  const MEASURE_ACCENT = "#0e8195";
  const MDIV_ACCENT = "#8b5fbf";
  const accentFor = (p: number, z: number) =>
    startsMovement(p, z) ? MDIV_ACCENT : MEASURE_ACCENT;

  // The editing hints and colour legend, shown by the toolbar's help icon.
  const helpText = $derived(
    [
      ...(canEdit
        ? [
            `drag on the page to draw a ${tool === "staves" ? "staff" : tool === "grandstaves" ? "grand staff" : "measure"} · drag a box to move · edges and corners resize · arrows nudge (⇧ ×5)`,
          ]
        : []),
      "⌘Z undo · ⌘⇧Z redo · ⌫ delete · ← → pages",
      omr
        ? "red = staff · green = grand staff (the staves a brace joins) · teal = measure · purple = movement start"
        : "purple = movement start",
    ].join("\n"),
  );
</script>

<svelte:head>
  <title>{taskTitle} · {campaign} · Let's Encode!</title>
</svelte:head>

<svelte:window
  onpointermove={pointerMove}
  onpointerup={pointerUp}
  onkeydown={keydown}
/>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="corrector">
  {#if session.campaign.error}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {session.campaign.error}
          <button
            type="button"
            class="linkish"
            onclick={() => session.campaign.retry()}>Try again</button
          >
        </span>
      </div>
    </div>
  {:else if session.campaign.notFound}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          No campaign called <code>{campaign}</code> was found.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    </div>
  {:else if auth.status === "loading" || !session.campaign.resolved}
    <div class="deskwrap"><p class="muted">Loading…</p></div>
  {:else if !auth.user}
    <div class="deskwrap">
      <div class="banner warn">
        <span>
          Please <button type="button" class="linkish" onclick={() => login()}
            >log in with GitHub</button
          >
          to work on this task.
        </span>
      </div>
    </div>
  {:else if session.loading}
    <div class="deskwrap"><p class="muted">Loading the facsimile…</p></div>
  {:else if session.loadError}
    <div class="deskwrap">
      <div class="banner err">
        <span>
          {session.loadError}
          <button type="button" class="linkish" onclick={() => session.load()}
            >Try again</button
          >
        </span>
      </div>
    </div>
  {:else if data}
    <div class="main">
      <div class="ctoolbar">
        <div class="seg" title="How many pages the desk shows side by side">
          <button
            type="button"
            class:on={view === "single"}
            onclick={() => (view = "single")}>1 page</button
          >
          <button
            type="button"
            class:on={view === "double"}
            onclick={() => (view = "double")}>2 pages</button
          >
        </div>
        {#if view === "double"}
          <label
            class="checkline"
            title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens"
          >
            <input type="checkbox" bind:checked={firstOnRight} /> Page 1 right
          </label>
        {/if}
        <span class="tspacer"></span>
        <input
          class="zoomslider"
          type="range"
          aria-label="Zoom"
          aria-valuetext={`${Math.round(zoom * 100)}%`}
          min={0}
          max={ZOOM_STOPS}
          step={1}
          value={zoomPos}
          oninput={(e) => {
            setZoomPos(Number((e.target as HTMLInputElement).value));
            fit = null;
          }}
        />
        <span class="zval">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          class="tbtn tbtn-icon"
          class:on={fit === "width"}
          onclick={() => (fit = "width")}
          aria-label="Fit the page width"
          title="Fit the page width to the view"
          ><FitIcon kind="width" /></button
        >
        <button
          type="button"
          class="tbtn tbtn-icon"
          class:on={fit === "page"}
          onclick={fitWholePage}
          aria-label="Fit the whole page"
          title="Fit the whole page in the view, top to bottom"
          ><FitIcon kind="page" /></button
        >
        <span class="vline"></span>
        {#if canEdit}
          <button
            type="button"
            class="btn btn-icon"
            onclick={() => undo()}
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo the last change (Ctrl/Cmd+Z)">↶</button
          >
          <button
            type="button"
            class="btn btn-icon"
            onclick={() => redo()}
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo (Ctrl/Cmd+Shift+Z)">↷</button
          >
        {/if}
        <span
          class="helpico"
          role="img"
          aria-label="Editor help"
          title={helpText}>?</span
        >
        <button
          type="button"
          aria-pressed={commentsPanel.open}
          class="btn"
          title={commentsPanel.open
            ? "Hide the comments panel with the task's controls"
            : "Show the comments panel with the task's controls"}
          onclick={() => {
            commentsPanel.open = !commentsPanel.open;
            writeSidePanel("comments", { ...commentsPanel });
          }}
        >
          <PanelIcon />
          Comments
        </button>
        <!-- Last in the toolbar, next to the task panel on the right. -->
        <div class="pgnav">
          <span class="vline"></span>
          <button
            type="button"
            class="btn btn-icon pgbtn"
            onclick={() => go(-1)}
            disabled={atTop}
            aria-label="Previous page"
            title="Previous page"><Icon name="chevron-left" /></button
          >
          <span
            class="pglabel"
            style={`min-width:${pagesLabelCh(pages.length)}ch`}
            >{spreadLabel}</span
          >
          <button
            type="button"
            class="btn btn-icon pgbtn"
            onclick={() => go(1)}
            disabled={atEnd}
            aria-label="Next page"
            title="Next page"><Icon name="chevron-right" /></button
          >
        </div>
      </div>
      <RunnerBanner {runner} bar />
      <TaskRunState task={taskId} bar />

      <div
        class="desk"
        bind:this={desk}
        bind:clientWidth={deskW}
        bind:clientHeight={deskH}
        onscroll={deskScrolled}
      >
        <div
          class="pages"
          class:double={view === "double"}
          style={`--zoom:${zoom}`}
        >
          {#each spreads as sp, r (r)}
            <div class="row" bind:this={rowEls[r]}>
              {#if sp.lonelySide === "right"}<div
                  class="page-spacer"
                ></div>{/if}
              {#each sp.pages as p (p)}
                {@const pg = pages[p]}
                <div class="page">
                  <p class="page-label pagehead">Page {p + 1} · Facsimile</p>
                  {#if pg.failed}
                    <div class="banner err">
                      The page facsimile for page {p + 1} could not be loaded. The
                      zones are shown without their reference image.
                    </div>
                  {/if}
                  <div class="canvas" bind:clientWidth={canvasW[p]}>
                    <svg
                      bind:this={svgEls[p]}
                      viewBox={`0 0 ${pg.width} ${pg.height}`}
                      class:staves={tool === "staves"}
                      class:grandstaves={tool === "grandstaves"}
                      role="application"
                      aria-label={`Page ${p + 1} ${tool}`}
                      onpointerdown={(e) => backgroundPointerDown(e, p)}
                    >
                      <!-- Pages far from the view keep their size but draw nothing. -->
                      {#if nearPages.includes(p)}
                        {#if pg.url}
                          <image
                            href={pg.url}
                            width={pg.width}
                            height={pg.height}
                            onerror={() => (pages[p].failed = true)}
                          />
                        {/if}
                        {#each tool !== "measures" ? staffPaintOrder(pg, p) : [] as { staff, s } (`${tool}-${s}`)}
                          <rect
                            class="staff"
                            class:grand={tool === "grandstaves"}
                            class:selected={selected?.p === p &&
                              selected?.z === s}
                            vector-effect="non-scaling-stroke"
                            role="button"
                            tabindex={0}
                            aria-label={`${tool === "grandstaves" ? "Grand staff" : "Staff"} ${s + 1}: select, drag or resize`}
                            x={staff.box.ulx}
                            y={staff.box.uly}
                            width={staff.box.lrx - staff.box.ulx}
                            height={staff.box.lry - staff.box.uly}
                            onpointerdown={(e) =>
                              startZoneDrag(e, p, s, "move")}
                            onkeydown={(e) => zoneKeydown(e, p, s)}
                          />
                          {#if canEdit && selected?.p === p && selected?.z === s}
                            {@render handles(
                              p,
                              s,
                              staff.box,
                              `${tool === "grandstaves" ? "Grand staff" : "Staff"} ${s + 1}`,
                              0,
                              0,
                            )}
                          {/if}
                        {/each}
                        {#each tool === "measures" ? paintOrder(pg, p) : [] as { zone, z } (z)}
                          <rect
                            class="zone"
                            class:selected={selected?.p === p &&
                              selected?.z === z}
                            class:mdivstart={startsMovement(p, z)}
                            vector-effect="non-scaling-stroke"
                            role="button"
                            tabindex={0}
                            aria-label={`Measure ${zone.label}: select, drag, or edit its number and breaks`}
                            x={zone.box.ulx}
                            y={zone.box.uly}
                            width={zone.box.lrx - zone.box.ulx}
                            height={zone.box.lry - zone.box.uly}
                            onpointerdown={(e) =>
                              startZoneDrag(e, p, z, "move")}
                            onkeydown={(e) => zoneKeydown(e, p, z)}
                          >
                            {#if zoneTitle(p, z)}
                              <title>{zoneTitle(p, z)}</title>
                            {/if}
                          </rect>
                          {@const lbl = labelText(p, z)}
                          {@const fs = labelFont(p, pg.width)}
                          {@const inset = fs * 0.6}
                          {@const lblW = lbl.length * fs * 0.62 + fs * 0.9}
                          {@const editing =
                            canEdit && selected?.p === p && selected?.z === z}
                          {@const sc = canvasW[p] ? canvasW[p] / pg.width : 1}
                          {#if !editing}
                            <rect
                              class="labelbg"
                              x={zone.box.ulx + inset}
                              y={zone.box.uly + inset}
                              width={lblW}
                              height={fs * 1.55}
                              rx={fs * 0.28}
                            />
                            <text
                              class="zonelabel"
                              x={zone.box.ulx + inset + lblW / 2}
                              y={zone.box.uly + inset + fs * 1.12}
                              text-anchor="middle"
                              font-size={fs}>{lbl}</text
                            >
                          {:else}
                            {@render handles(
                              p,
                              z,
                              zone.box,
                              `Measure ${zone.label}`,
                              inset + ZC_W_PX / sc,
                              inset + ZC_H_PX / sc,
                            )}
                          {/if}
                        {/each}
                      {/if}
                    </svg>

                    {#if canEdit && tool === "measures" && active && active.p === p && pg.zones[active.z]}
                      {@const z = active.z}
                      {@const zone = pg.zones[z]}
                      {@const box = zone.box}
                      {@const inset = labelFont(p, pg.width) * 0.6}
                      <div
                        class="zc"
                        style={`left:${((box.ulx + inset) / pg.width) * 100}%; top:${((box.uly + inset) / pg.height) * 100}%; --accent:${accentFor(p, z)}`}
                      >
                        <div
                          class="zc-inner"
                          role="group"
                          aria-label={`Measure ${zone.label} controls`}
                          onpointerdown={(e) => {
                            selected = { p, z };
                            e.stopPropagation();
                          }}
                        >
                          <input
                            class="znum"
                            value={zone.override ?? zone.label}
                            size={Math.max(
                              2,
                              String(zone.override ?? zone.label).length,
                            )}
                            onfocus={() => (selected = { p, z })}
                            oninput={(e) =>
                              setLabel(
                                p,
                                z,
                                (e.target as HTMLInputElement).value,
                              )}
                            onchange={() => commit()}
                            title="Measure number — type to override the automatic number (e.g. 10a); numbering continues after it"
                          />
                          <button
                            type="button"
                            class:on={sbActive(p, z)}
                            onclick={() => toggleSb(p, z)}
                            disabled={pbAt(z)}
                            aria-pressed={sbActive(p, z)}
                            title={pbAt(z)
                              ? "System beginning — implied by the page break on a page's first measure"
                              : "System beginning (sb)"}>↵</button
                          >
                          <button
                            type="button"
                            class:on={startsMovement(p, z)}
                            onclick={() => toggleSection(p, z)}
                            disabled={sectionLocked(p, z)}
                            aria-pressed={startsMovement(p, z)}
                            title={sectionLocked(p, z)
                              ? "The first measure always opens the first section"
                              : "Section beginning — starts a new movement/section (mdiv)"}
                            >§</button
                          >
                        </div>
                      </div>
                    {/if}
                  </div>
                </div>
              {/each}
              {#if sp.lonelySide === "left"}<div class="page-spacer"></div>{/if}
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- The resize handles and delete button of the selected box in the
         active layer, shared by measures and staves. `labelW`/`labelH` are the
         label's extent inside the box, so the delete button drops below it
         when the box is too narrow for both; 0 for a box without a label. -->
    {#snippet handles(
      p: number,
      z: number,
      b: MeasureBox,
      name: string,
      labelW: number,
      labelH: number,
    )}
      {@const pg = pages[p]}
      <!-- Handle sizes are screen pixels, converted to page units by the
           canvas scale: the corner dots are 5px in radius, the edge strips
           12px thick. -->
      {@const sc = canvasW[p] ? canvasW[p] / pg.width : 1}
      {@const r = 5 / sc}
      {@const g = 12 / sc}
      {#each [{ edges: "n", side: "top edge", x: b.ulx + r, y: b.uly - g / 2, w: Math.max(0, b.lrx - b.ulx - 2 * r), h: g }, { edges: "s", side: "bottom edge", x: b.ulx + r, y: b.lry - g / 2, w: Math.max(0, b.lrx - b.ulx - 2 * r), h: g }, { edges: "w", side: "left edge", x: b.ulx - g / 2, y: b.uly + r, w: g, h: Math.max(0, b.lry - b.uly - 2 * r) }, { edges: "e", side: "right edge", x: b.lrx - g / 2, y: b.uly + r, w: g, h: Math.max(0, b.lry - b.uly - 2 * r) }] as e (e.edges)}
        <rect
          class="edge {resizeCursor(e.edges)}"
          role="button"
          tabindex={0}
          aria-label={`${name}: resize (${e.side})`}
          x={e.x}
          y={e.y}
          width={e.w}
          height={e.h}
          onpointerdown={(ev) => startZoneDrag(ev, p, z, "resize", e.edges)}
          onkeydown={(ev) => resizeKeydown(ev, p, z, e.edges)}
        />
      {/each}
      {#each [{ edges: "nw", side: "top-left corner", cx: b.ulx, cy: b.uly }, { edges: "ne", side: "top-right corner", cx: b.lrx, cy: b.uly }, { edges: "sw", side: "bottom-left corner", cx: b.ulx, cy: b.lry }, { edges: "se", side: "bottom-right corner", cx: b.lrx, cy: b.lry }] as c (c.edges)}
        <circle
          class="handle {resizeCursor(c.edges)}"
          vector-effect="non-scaling-stroke"
          role="button"
          tabindex={0}
          aria-label={`${name}: resize (${c.side})`}
          cx={c.cx}
          cy={c.cy}
          {r}
          onpointerdown={(ev) => startZoneDrag(ev, p, z, "resize", c.edges)}
          onkeydown={(ev) => resizeKeydown(ev, p, z, c.edges)}
        />
      {/each}
      <!-- A delete button pinned inside the box's top-right corner, drawn in
           screen pixels via the inverse-scale transform. -->
      {@const bx = Math.max(b.ulx + 4 / sc, b.lrx - 27 / sc)}
      {@const by =
        labelW && bx < b.ulx + labelW + 6 / sc
          ? b.uly + labelH + 6 / sc
          : b.uly + 7 / sc}
      <g
        class="delbtn"
        role="button"
        tabindex={0}
        aria-label={`${name}: delete`}
        transform={`translate(${bx}, ${by}) scale(${1 / sc})`}
        onpointerdown={(ev) => ev.stopPropagation()}
        onclick={() => deleteZone(p, z)}
        onkeydown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            deleteZone(p, z);
          }
        }}
      >
        <title>Delete this {name.split(" ")[0].toLowerCase()}</title>
        <rect width="20" height="20" rx="6" />
        <path
          d="M5.2 6.4h9.6 M8.3 6.2V4.8h3.4v1.4 M6.4 6.6l.5 8.8h6.2l.5-8.8 M8.7 8.8v4.4 M11.3 8.8v4.4"
        />
      </g>
    {/snippet}

    {#snippet taskBox()}
      <!-- The snippet renders only while `data` is loaded (see its host). -->
      {@const d = data!}
      <div class="taskbox">
        <div class="tbhead">
          <h2 class="abtitle">{taskTitle}</h2>
          <code class="taskchip">{taskId}</code>
        </div>
        <div class="tbsection">
          <span class="abcount">
            {#if omr}{staffCount}
              {staffCount === 1 ? "staff" : "staves"} · {grandstaffCount} grand
              {grandstaffCount === 1
                ? "staff"
                : "staves"}{" · "}{/if}{measureCount} measure{measureCount === 1
              ? ""
              : "s"}
            · {movementCount} movement{movementCount === 1 ? "" : "s"}
          </span>
          <PreTaskStatus {session} />
          {#if omr}
            <div
              class="seg steps"
              title="The three steps of the measure correction. Each step shows only its own boxes."
            >
              <button
                type="button"
                class:on={layoutStep === 1}
                onclick={() => setLayoutStep(1)}>1 · Staff boxes</button
              >
              <button
                type="button"
                class:on={layoutStep === 2}
                onclick={() => setLayoutStep(2)}>2 · Grand staves</button
              >
              <button
                type="button"
                class:on={layoutStep === 3}
                onclick={() => setLayoutStep(3)}>3 · Measures</button
              >
            </div>
          {/if}
          {#if omr && layoutStep === 1}
            <button
              type="button"
              class="btn btn-secondary submitbtn"
              onclick={() => setLayoutStep(2)}
              title="Go on to step 2: the grand staves, one box around the staves each brace joins. Submission is in step 3."
            >
              Next: grand staves
            </button>
          {:else if omr && layoutStep === 2}
            <button
              type="button"
              class="btn btn-secondary submitbtn"
              onclick={() => setLayoutStep(3)}
              title="Go on to step 3: the measures, their numbers and breaks. Submission is in step 3."
            >
              Next: measures
            </button>
          {:else}
            <button
              type="button"
              class="btn btn-primary submitbtn"
              onclick={() => submit()}
              disabled={busy || !canEdit || submitBlock !== null}
              title={submitBlock ??
                (omr
                  ? "Submit the corrected staves, grand staves, measures, breaks and movements for review"
                  : "Submit the corrected measures, breaks and movements for review")}
            >
              Submit corrections
            </button>
          {/if}
        </div>

        <PreTaskReview {session} {stage} />
      </div>
    {/snippet}

    {#if tables}
      <PieceCommentsPanel
        {tables}
        {taskId}
        {viewer}
        {runner}
        bind:panel={commentsPanel}
        header={taskBox}
        onanchor={showAnchorFor}
        oncomment={(...args) => session.postComment(...args)}
        onresolve={(id) => session.resolveComment(id)}
      />
    {/if}
  {/if}
</div>

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }
  .linkish {
    font: inherit;
    font-weight: 600;
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .linkish:hover {
    text-decoration: underline;
  }

  /* The whole tool: the desk the page sheets float on (the only scrolling
     region), with the comments panel — carrying the task box — beside it.
     The app's navigation bar and footer come from the layout, as on every
     other page. */
  .corrector {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--desk);
    box-shadow: var(--shadow-inset);
  }
  /* The comments panel brings no outer spacing of its own; the score view's
     host row provides it there. */
  .corrector > :global(.cpwrap) {
    margin: 12px 16px 12px 0;
  }

  /* --------------------------------------------------------------- task box
     The task's status, actions and validation controls, pinned at the top of
     the comments panel. The tint follows the panel's piece colour (--zone). */
  .taskbox {
    background: var(--card);
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    overflow: hidden;
    box-shadow: var(--shadow-sm);
  }
  .tbhead {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    background: color-mix(in srgb, var(--zone) 10%, var(--card));
    border-bottom: 1px solid color-mix(in srgb, var(--zone) 25%, var(--line));
    padding: 9px 12px;
  }
  .tbsection {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
  }
  .abtitle {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .taskchip {
    font-size: 12px;
    font-family: ui-monospace, Menlo, monospace;
    background: var(--bg-tint);
    border-radius: 5px;
    padding: 2px 7px;
  }
  .abcount {
    font-size: 12.5px;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .submitbtn {
    align-self: stretch;
  }

  .checkline {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
  }
  .checkline input {
    width: 16px;
    height: 16px;
    margin: 0;
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
    cursor: pointer;
  }
  /* The toolbar's help icon; its title carries the hints and colour legend. */
  .helpico {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink-soft);
    font-size: 12px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: help;
  }

  /* Banner styles are shared app-wide in ui.css. */
  /* Pre-editor states (loading, errors, login) on the desk. */
  .deskwrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1.25rem 2rem;
    box-sizing: border-box;
  }
  /* The desk column beside the sidebar: the paging and zoom toolbar on top,
     result banners over the desk. */
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ctoolbar {
    flex: none;
    min-height: 44px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid var(--line);
    background: var(--card);
    overflow-x: auto;
  }
  .tspacer {
    flex: 1;
  }
  /* The scroll position is kept by page (see `anchor`), not by the browser. */
  .desk {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
    padding: 16px 24px;
    box-sizing: border-box;
  }
  .pages {
    min-width: 0;
  }
  /* A row's width is the zoom level: above 100% every row overflows the desk
     by the same amount, so the one desk scrollbar moves all pages together.
     Centred, so zoomed out the pages stay in the middle of the desk. */
  .row {
    width: calc(100% * var(--zoom, 1));
    margin-inline: auto;
  }
  /* Two-up view: the spread's pages (and any empty-half spacer) share the
     row, a few pixels apart at the spine, so they meet in the middle. */
  .pages.double .row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .pages.double .page,
  .page-spacer {
    flex: 1 1 0;
    min-width: 0;
  }

  .page {
    margin-bottom: 1.5rem;
  }
  .pagehead {
    margin-bottom: 4px;
  }
  /* Positioning context for the per-zone controls overlay: its width is the
     svg's, so percentage-placed controls line up with the boxes. */
  .canvas {
    position: relative;
  }
  /* Each page renders as a sheet floating on the desk. */
  svg {
    display: block;
    /* border-box so the 1px border stays within 100% and the page doesn't
       overflow its container by a couple of pixels at 100% zoom. */
    box-sizing: border-box;
    width: 100%;
    max-width: none;
    height: auto;
    background: var(--facsimile-paper);
    border: 1px solid var(--line-input);
    box-shadow: 0 10px 30px rgba(31, 36, 51, 0.16);
    touch-action: none;
    user-select: none;
  }
  /* Teal for measures, purple for movement starts: both hues sit outside the
     piece-region palette (--zone-1…8), so a colour never carries two meanings. */
  /* Strokes are screen pixels — the markup sets
     vector-effect="non-scaling-stroke" — so they stay even at every zoom. */
  .zone {
    fill: rgba(14, 129, 149, 0.12);
    stroke: rgba(14, 129, 149, 0.85);
    stroke-width: 1.5;
    cursor: pointer;
  }
  .zone.selected {
    fill-opacity: 1;
    stroke-width: 2.5;
  }
  .zone.mdivstart {
    stroke: rgba(139, 95, 191, 0.9);
    fill: rgba(139, 95, 191, 0.14);
    stroke-width: 3.5;
  }
  /* Red for staff boxes: a third hue outside the region palette. */
  .staff {
    fill: rgba(214, 40, 40, 0.08);
    stroke: rgba(214, 40, 40, 0.9);
    stroke-width: 1.5;
    cursor: pointer;
  }
  .staff.selected {
    fill: rgba(214, 40, 40, 0.18);
    stroke-width: 2.5;
  }
  .labelbg {
    fill: rgba(255, 255, 255, 0.88);
    pointer-events: none;
  }
  .zonelabel {
    font-family: ui-monospace, monospace;
    font-weight: 600;
    fill: #1a1a1a;
    pointer-events: none;
  }
  .handle {
    fill: #fff;
    stroke: rgba(14, 129, 149, 0.85);
    stroke-width: 1.5;
  }
  .staves .handle {
    stroke: rgba(214, 40, 40, 0.9);
  }
  /* Green for grand-staff boxes, the complement of the staff red. */
  .staff.grand {
    fill: rgba(30, 150, 70, 0.08);
    stroke: rgba(30, 150, 70, 0.9);
  }
  .staff.grand.selected {
    fill: rgba(30, 150, 70, 0.18);
  }
  .grandstaves .handle {
    stroke: rgba(30, 150, 70, 0.9);
  }
  /* Three equal cells; in a narrow panel a label wraps inside its cell. */
  .steps {
    align-self: stretch;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    align-items: stretch;
    border-radius: 12px;
  }
  .steps > button {
    justify-content: center;
    text-align: center;
    white-space: normal;
    line-height: 1.25;
    padding: 4px 6px;
    border-radius: 9px;
  }
  /* The side strips are invisible grab areas along the box edges; a
     transparent fill still catches pointer events. */
  .edge {
    fill: transparent;
  }
  .h-ns {
    cursor: ns-resize;
  }
  .h-ew {
    cursor: ew-resize;
  }
  .h-nwse {
    cursor: nwse-resize;
  }
  .h-nesw {
    cursor: nesw-resize;
  }

  /* The per-zone controls (number input · ↵ · §) stand in for the selected
     measure's number label, at the same top-left anchor and a matching size
     (ZC_W_PX × ZC_H_PX). The outer layer is a zero-size anchor; the inner
     box re-enables the pointer. */
  .zc {
    position: absolute;
    pointer-events: none;
    z-index: 5;
  }
  .zc-inner {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 22px;
    pointer-events: auto;
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 4px;
    padding: 0 2px;
    box-shadow: 0 2px 6px rgba(31, 36, 51, 0.18);
    white-space: nowrap;
  }
  .zc-inner .znum,
  .zc-inner button {
    font:
      600 11px ui-monospace,
      monospace;
    line-height: 1;
    cursor: pointer;
  }
  .zc-inner .znum {
    width: 32px;
    height: 18px;
    padding: 0 3px;
    border: 1px solid var(--line-input);
    border-radius: 3px;
    background: var(--card);
    color: var(--ink);
    text-align: center;
    font-variant-numeric: tabular-nums;
    cursor: text;
  }
  .zc-inner button {
    width: 20px;
    height: 18px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: var(--ink-soft);
  }
  .zc-inner button:hover:not(:disabled) {
    border-color: var(--line-input);
  }
  .zc-inner button.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  /* Disabled (e.g. the system break implied by a page break): muted and
     dashed, also when the state it shows is on. */
  .zc-inner button:disabled,
  .zc-inner button.on:disabled {
    cursor: default;
    color: var(--ink-faint);
    background: var(--bg-alt);
    border: 1px dashed var(--ink-faint);
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
