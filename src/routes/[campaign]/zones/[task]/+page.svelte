<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result, FacsimileTaskData } from "$lib/commands.ts";
  import { readingOrderRows, nextLabel } from "$lib/mei-facsimile.ts";
  import type { PageModel, MeasureBox } from "$lib/mei-facsimile.ts";
  import { buildSpreads } from "$lib/page-spreads.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";
  import { createForge } from "$lib/forge/index.ts";
  import { resolveCampaign } from "$lib/campaign-resolve.ts";
  import type { ResolvedCampaign } from "$lib/campaign-resolve.ts";

  // The URL carries the campaign name and task; the repo is resolved from the
  // name (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  const taskId = $derived(page.params.task!);
  let resolved = $state<ResolvedCampaign | null>(null);
  let resolving = $state(false);
  let notFound = $state(false);
  const owner = $derived(resolved?.owner ?? "");
  const repo = $derived(resolved?.repo ?? "");
  const repoId = $derived(resolved?.repoId ?? 0);
  // The acting user's stable numeric id; login is display-only.
  const viewer = $derived(auth.user?.id != null ? String(auth.user.id) : "");

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
  type EditPage = {
    image: string;
    width: number;
    height: number;
    url: string;
    // The background facsimile failed to load (empty download URL, or the
    // browser refused the request — e.g. a CSP img-src that omits the raw host).
    failed: boolean;
    zones: EditZone[];
  };

  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let data = $state<FacsimileTaskData | null>(null);
  let pages = $state<EditPage[]>([]);
  let selected = $state<{ p: number; z: number } | null>(null);
  // The zone the pointer is currently over. Kept separate from `selected` so a
  // brief hover shows the controls without pinning them; a short hide delay
  // bridges the gap between a zone and its own controls.
  let hovered = $state<{ p: number; z: number } | null>(null);
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  // The zone whose controls show: the hovered one, else the pinned selection.
  const active = $derived(hovered ?? selected);

  let busy = $state(false);
  const busyLog = new ProgressLog();
  let result = $state<Result | null>(null);

  // Alternating system tint / accent: even systems blue, odd green.
  const SYS_ACCENT = ["#3056d3", "#149650"];

  // Page zoom: the fraction of the canvas width one page occupies. 1 = fit the
  // canvas; above 1 the page overflows and its container scrolls horizontally.
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.25;
  let zoom = $state(1);
  const zoomBy = (d: number) =>
    (zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom + d) * 100) / 100)));

  // Book-style paging: show one spread at a time rather than every page.
  // `view` is one or two pages per spread; `firstOnRight` places page 1 as a
  // right-hand page (recto), so a two-up view pairs 2|3, 4|5, … the way a
  // score opens — the printed page number's side can't be read without OCR, so
  // this convention (with the toggle) stands in for it.
  let view = $state<"single" | "double">("single");
  let firstOnRight = $state(true);
  // The lowest page index currently shown; the anchor navigation moves. Keeping
  // an anchor (not a spread index) preserves the visible page across view/side
  // toggles, which re-slice the spreads.
  let firstVisible = $state(0);

  const spreads = $derived(buildSpreads(pages.length, view, firstOnRight));
  const spreadIndex = $derived(
    Math.max(0, spreads.findIndex((s) => s.pages.includes(firstVisible))),
  );
  const spread = $derived(spreads[spreadIndex] ?? { pages: [] });
  const spreadLabel = $derived(
    spread.pages.length === 2
      ? `Pages ${spread.pages[0] + 1}–${spread.pages[1] + 1} of ${pages.length}`
      : `Page ${(spread.pages[0] ?? 0) + 1} of ${pages.length}`,
  );

  function go(delta: number) {
    const next = spreads[spreadIndex + delta];
    if (!next) return;
    firstVisible = next.pages[0];
    selected = null;
  }

  const canEdit = $derived(
    Boolean(data?.holdsLock) && data?.status === "encoding_required",
  );

  const ctx = (f: ForgeClient): CommandContext => ({
    forge: f,
    repoId,
    owner,
    repo,
    viewer,
    viewerLogin: auth.user?.login ?? "",
    progress: (u) => {
      if (u.step) busyLog.step(u.step);
      if (u.detail) busyLog.detail(u.detail);
    },
  });

  const readForge = () => forge() ?? createForge("");

  // Login for the reviewer holding the validation lock (id → login, for display).
  let lockUserLogin = $state("");
  $effect(() => {
    const id = Number(data?.validation?.lockUser);
    if (!Number.isInteger(id)) {
      lockUserLogin = data?.validation?.lockUser ?? "";
      return;
    }
    readForge()
      .getUserLogin(id)
      .then((login) => (lockUserLogin = login ?? String(id)))
      .catch(() => (lockUserLogin = String(id)));
  });

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

  async function load() {
    const f = forge();
    if (!f) return;
    loading = true;
    loadError = null;
    selected = null;
    hovered = null;
    firstVisible = 0;
    try {
      data = await invoke(commands.readFacsimile, { task_id: taskId }, ctx(f));
      pages = data.model.pages.map((pg, i) => ({
        image: pg.image,
        width: pg.width,
        height: pg.height,
        url: data!.imageUrls[i],
        failed: !data!.imageUrls[i],
        zones: pg.zones.map((z) => ({
          box: { ...z.box },
          override: null,
          label: z.label,
          sb: z.sb,
          mdiv: z.mdiv,
        })),
      }));
      // A label that differs from what automatic numbering would produce is an
      // override (e.g. 10a/10b) — keep it through renumbering.
      let prev: string | undefined;
      for (const pg of pages) {
        for (const zone of pg.zones) {
          if (zone.label !== nextLabel(prev)) zone.override = zone.label;
          prev = zone.label;
        }
      }
      resetHistory();
    } catch (e) {
      loadError = `Could not load ${taskId}: ${(e as Error).message}`;
    } finally {
      loading = false;
    }
  }

  // Resolve the campaign name to its repo first; the load effect is gated on
  // `owner`/`repo` so it waits for this.
  $effect(() => {
    if (auth.status === "loading" || resolved || notFound || resolving) return;
    resolving = true;
    resolveCampaign(readForge(), campaign)
      .then((r) => (r ? (resolved = r) : (notFound = true)))
      .catch(() => (notFound = true))
      .finally(() => (resolving = false));
  });

  $effect(() => {
    if (auth.status === "authenticated" && owner && repo && taskId && !data && !loading) load();
  });

  async function run(
    command: (c: CommandContext) => Promise<Result>,
    opts: { overviewOnSuccess?: boolean } = {},
  ) {
    const f = forge();
    if (!f) return;
    busy = true;
    busyLog.clear();
    try {
      result = await command(ctx(f));
      if (opts.overviewOnSuccess && result.ok && !result.warn) {
        await goto(`/${campaign}`);
        return;
      }
      busyLog.step("Reloading…");
      data = null;
      await load();
    } finally {
      busyLog.done();
      busy = false;
    }
  }

  const claim = () =>
    run((c) => invoke(commands.claimTask, { task_id: taskId }, c));

  // Opening the editor claims the task, the same way opening a score in
  // mei-friend does — a read-only look is served by the console's score
  // preview, so reaching the editor means intent to edit. Fire once per task:
  // if the claim is rejected (already held by someone else) the banner and the
  // manual button remain as the fallback, and we don't re-open a doomed PR on
  // every reload.
  let autoClaimedFor = $state<string | null>(null);
  $effect(() => {
    if (
      data &&
      !busy &&
      autoClaimedFor !== taskId &&
      data.status === "encoding_required" &&
      !data.holdsLock
    ) {
      autoClaimedFor = taskId;
      claim();
    }
  });

  // The review happens here too: the same claim/pass/fail the console offers,
  // against the task's validation subtask.
  const validation = $derived(data?.validation ?? null);
  const submitted = $derived(
    data?.status === "validation_required" || data?.status === "completed",
  );
  const holdsValidation = $derived(
    viewer !== "" && validation?.lockUser === viewer,
  );
  const selfValidation = $derived(
    !!data && data.encoder !== "" && data.encoder === viewer,
  );
  const canClaimValidation = $derived(
    !!validation &&
      validation.status === "validation_required" &&
      !validation.lockUser &&
      !selfValidation,
  );
  const claimValidation = () =>
    run((c) =>
      invoke(
        commands.claimValidation,
        { task_id: taskId, subtask_id: validation!.subtask_id },
        c,
      ),
    );
  const validate = (verdict: string) =>
    run(
      (c) =>
        invoke(
          commands.submitValidation,
          { task_id: taskId, subtask_id: validation!.subtask_id, verdict },
          c,
        ),
      { overviewOnSuccess: true },
    );

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
    }));
  }

  const submit = () =>
    run(
      (c) =>
        invoke(
          commands.submitZones,
          { task_id: taskId, pages: toPageModels() },
          c,
        ),
      { overviewOnSuccess: true },
    );

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
    }));
  }

  // Discard any history and start a fresh baseline (after a load/reload).
  function resetHistory() {
    history = [clonePages(pages)];
    historyIndex = 0;
  }

  // Record the current pages as a new entry, dropping any redo tail.
  function commit() {
    history = history.slice(0, historyIndex + 1);
    history.push(clonePages(pages));
    historyIndex = history.length - 1;
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
  const pbAt = (p: number, z: number) => z === 0;
  const sbActive = (p: number, z: number) => pbAt(p, z) || pages[p].zones[z].sb;
  const sectionLocked = (p: number, z: number) => p === 0 && z === 0;

  function toggleSb(p: number, z: number) {
    if (!canEdit || pbAt(p, z)) return;
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
  // Hover tracking (a short hide delay bridges zone → its controls)

  function hoverEnter(p: number, z: number) {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    hovered = { p, z };
  }
  function hoverLeave() {
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hovered = null;
      hoverTimer = null;
    }, 90);
  }

  // ------------------------------------------------------------------------
  // Pointer interactions (box move / resize / draw)

  let svgEls = $state<SVGSVGElement[]>([]);
  // Each visible page's rendered canvas width (px), so the SVG number labels can
  // be sized to a near-constant on-screen size across zoom and 1-/2-page view.
  let canvasW = $state<number[]>([]);
  // On-screen height (px) for the number label at 100%; it grows a little with
  // zoom (damped) so it does not feel oversized zoomed out or small zoomed in.
  const LABEL_PX = 15;
  const labelFont = (p: number, pageW: number) => {
    const damp = Math.min(1.7, Math.max(0.8, 0.7 + 0.3 * zoom));
    const target = LABEL_PX * damp;
    return canvasW[p] ? (target * pageW) / canvasW[p] : target;
  };
  type Drag = {
    kind: "move" | "resize" | "draw";
    p: number;
    z: number;
    sx: number;
    sy: number;
    orig: MeasureBox;
    moved: boolean;
  };
  let drag: Drag | null = null;

  function svgXY(e: PointerEvent, p: number): { x: number; y: number } {
    const svg = svgEls[p];
    const r = svg.getBoundingClientRect();
    const pg = pages[p];
    return {
      x: Math.max(0, Math.min(pg.width, ((e.clientX - r.left) * pg.width) / r.width)),
      y: Math.max(0, Math.min(pg.height, ((e.clientY - r.top) * pg.height) / r.height)),
    };
  }

  function zonePointerDown(e: PointerEvent, p: number, z: number) {
    selected = { p, z };
    if (!canEdit) return;
    e.stopPropagation();
    const { x, y } = svgXY(e, p);
    drag = { kind: "move", p, z, sx: x, sy: y, orig: { ...pages[p].zones[z].box }, moved: false };
  }

  function handlePointerDown(e: PointerEvent, p: number, z: number) {
    if (!canEdit) return;
    e.stopPropagation();
    selected = { p, z };
    const { x, y } = svgXY(e, p);
    drag = { kind: "resize", p, z, sx: x, sy: y, orig: { ...pages[p].zones[z].box }, moved: false };
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
    const box = pages[p].zones[z].box;
    const pg = pages[p];
    const step = e.shiftKey ? 10 : 2;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    const w = box.lrx - box.ulx;
    const h = box.lry - box.uly;
    box.ulx = Math.max(0, Math.min(pg.width - w, box.ulx + dx));
    box.uly = Math.max(0, Math.min(pg.height - h, box.uly + dy));
    box.lrx = box.ulx + w;
    box.lry = box.uly + h;
    const zone = pages[p].zones[z];
    resort(p);
    selected = { p, z: pages[p].zones.indexOf(zone) };
    commit();
  }

  function handleKeydown(e: KeyboardEvent, p: number, z: number) {
    if (!canEdit || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
    const box = pages[p].zones[z].box;
    const pg = pages[p];
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") box.lrx = Math.max(box.ulx + 5, box.lrx - step);
    if (e.key === "ArrowRight") box.lrx = Math.min(pg.width, box.lrx + step);
    if (e.key === "ArrowUp") box.lry = Math.max(box.uly + 5, box.lry - step);
    if (e.key === "ArrowDown") box.lry = Math.min(pg.height, box.lry + step);
    const zone = pages[p].zones[z];
    resort(p);
    selected = { p, z: pages[p].zones.indexOf(zone) };
    commit();
  }

  function backgroundPointerDown(e: PointerEvent, p: number) {
    selected = null;
    hovered = null;
    if (!canEdit) return;
    const { x, y } = svgXY(e, p);
    pages[p].zones.push({
      box: { ulx: x, uly: y, lrx: x, lry: y },
      override: null,
      label: "",
      sb: false,
      mdiv: false,
    });
    const z = pages[p].zones.length - 1;
    selected = { p, z };
    drag = { kind: "draw", p, z, sx: x, sy: y, orig: { ulx: x, uly: y, lrx: x, lry: y }, moved: false };
  }

  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const { x, y } = svgXY(e, drag.p);
    const dx = x - drag.sx;
    const dy = y - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    const box = pages[drag.p].zones[drag.z].box;
    const pg = pages[drag.p];
    if (drag.kind === "move") {
      const w = drag.orig.lrx - drag.orig.ulx;
      const h = drag.orig.lry - drag.orig.uly;
      box.ulx = Math.max(0, Math.min(pg.width - w, drag.orig.ulx + dx));
      box.uly = Math.max(0, Math.min(pg.height - h, drag.orig.uly + dy));
      box.lrx = box.ulx + w;
      box.lry = box.uly + h;
    } else {
      // resize and draw both drag the lower-right corner.
      box.lrx = Math.max(box.ulx + 5, x);
      box.lry = Math.max(box.uly + 5, y);
    }
  }

  function pointerUp() {
    if (!drag) return;
    const { kind, p, z, moved } = drag;
    drag = null;
    if (kind === "draw") {
      const box = pages[p].zones[z].box;
      // A tiny drawn box was just a background click — drop it.
      if (box.lrx - box.ulx < 8 || box.lry - box.uly < 8) {
        pages[p].zones.splice(z, 1);
        selected = null;
        return;
      }
    }
    if (kind !== "draw" && !moved) return; // plain select / handle click, no move
    // Keep the same zone selected across the re-sort (its index may change), so
    // its resize handle stays and further edits need no extra click.
    const zone = pages[p].zones[z];
    resort(p);
    selected = { p, z: pages[p].zones.indexOf(zone) };
    commit();
  }

  function deleteSelected() {
    if (!selected || !canEdit) return;
    pages[selected.p].zones.splice(selected.z, 1);
    resort(selected.p);
    selected = null;
    commit();
  }

  function deleteZone(p: number, z: number) {
    if (!canEdit) return;
    pages[p].zones.splice(z, 1);
    resort(p);
    selected = null;
    hovered = null;
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
  function paintOrder(pg: EditPage, p: number): { zone: EditZone; z: number }[] {
    const entries = pg.zones.map((zone, z) => ({ zone, z }));
    if (selected?.p === p) {
      const i = entries.findIndex((e) => e.z === selected!.z);
      if (i >= 0) entries.push(entries.splice(i, 1)[0]);
    }
    return entries;
  }

  // Which system (0-based) each of a page's measures belongs to, for the
  // alternating tint. A page's first measure and any system start begin one.
  function systemIndices(pg: EditPage): number[] {
    let s = -1;
    return pg.zones.map((z, i) => {
      if (i === 0 || z.sb) s++;
      return s;
    });
  }

  const measureCount = $derived(pages.reduce((n, p) => n + p.zones.length, 0));
  const movementCount = $derived(
    1 +
      pages.reduce(
        (n, pg, p) => n + pg.zones.filter((z, i) => z.mdiv && (p > 0 || i > 0)).length,
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
    (pbAt(p, z) ? "⇱" : "") +
    (!pbAt(p, z) && pages[p].zones[z].sb ? "↵" : "");
  const labelText = (p: number, z: number) => {
    const m = markers(p, z);
    return (m ? m + " " : "") + pages[p].zones[z].label;
  };

  // System/section colours reused for the box tint and the zone controls.
  const MDIV_ACCENT = "#8b5fbf";
  const accentFor = (systems: number[], p: number, z: number) =>
    startsMovement(p, z) ? MDIV_ACCENT : SYS_ACCENT[systems[z] % 2];
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} onkeydown={keydown} />

{#if busy}
  <LoadingOverlay log={busyLog} />
{/if}

{#if notFound}
  <div class="wrap">
    <div class="banner err">
      No campaign called <code>{campaign}</code> was found.
      <a href="/">Back to all campaigns</a>.
    </div>
  </div>
{:else if auth.status === "loading" || (!resolved && !notFound)}
  <div class="wrap"><p class="muted">Loading…</p></div>
{:else if !auth.user}
  <div class="wrap">
    <div class="banner warn">
      Please <button type="button" class="linkish" onclick={() => login()}>log in with GitHub</button>
      to work on this task.
    </div>
  </div>
{:else}
  {#if loading}
    <div class="wrap"><p class="muted">Loading the facsimile…</p></div>
  {:else if loadError}
    <div class="wrap"><div class="banner err">{loadError}</div></div>
  {:else if data}
    <div class="toolbar">
     <div class="toolbar-inner">
      <span class="tb-group tb-title">
        <a href={`/${campaign}`} title="Back to the campaign console">← Console</a>
        <span class="tb-task"><code>{taskId}</code></span>
        <span class="count">
          {measureCount} measure{measureCount === 1 ? "" : "s"}
          · {movementCount} movement{movementCount === 1 ? "" : "s"}
        </span>
      </span>

      {#if canEdit}
        <div class="tb-group tb-div">
          <button type="button" onclick={() => undo()} disabled={!canUndo} title="Undo the last change (Ctrl/Cmd+Z)">↶ Undo</button>
          <button type="button" onclick={() => redo()} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">Redo ↷</button>
        </div>
      {/if}

      {#if validation && submitted}
        <div class="tb-group tb-div tb-validation">
          <span class="vstatus">
            {#if validation.status === "completed"}
              Validation complete
            {:else if validation.lockUser}
              {holdsValidation ? "You are validating" : `@${lockUserLogin || validation.lockUser} validating`}
            {:else if selfValidation}
              Your own submission
            {:else}
              Awaiting validation
            {/if}
          </span>
          <button type="button" onclick={() => claimValidation()} disabled={busy || !canClaimValidation}
            title="Reserve this subtask for validation. Encoders cannot validate their own work.">Claim</button>
          <button type="button" class="vpass" onclick={() => validate("pass")} disabled={busy || !holdsValidation}
            title="Record a passing verdict.">Pass</button>
          <button type="button" class="vfail" onclick={() => validate("fail")} disabled={busy || !holdsValidation}
            title="Record a failing verdict — the task goes back to encoding.">Fail</button>
        </div>
      {/if}

      <button
        type="button"
        class="primary tb-submit tb-div"
        onclick={() => submit()}
        disabled={busy || !canEdit}
        title="Submit the corrected measures, breaks and movements for validation"
      >
        Submit corrections
      </button>

      <div class="tb-group tb-zoom tb-right">
        <button type="button" onclick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out">−</button>
        <span class="zoom-val">{Math.round(zoom * 100)}%</span>
        <button type="button" onclick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onclick={() => (zoom = 1)} disabled={zoom === 1} title="Fit page to width">Fit</button>
      </div>
      <div class="tb-group tb-div tb-nav">
        <button type="button" onclick={() => go(-1)} disabled={spreadIndex <= 0} aria-label="Previous page" title="Previous page">‹</button>
        <span class="nav-label">{spreadLabel}</span>
        <button type="button" onclick={() => go(1)} disabled={spreadIndex >= spreads.length - 1} aria-label="Next page" title="Next page">›</button>
      </div>
      <div class="tb-group tb-div tb-view">
        <button type="button" class:on={view === "single"} onclick={() => (view = "single")} title="Show one page">1 page</button>
        <button type="button" class:on={view === "double"} onclick={() => (view = "double")} title="Show a two-page spread">2 pages</button>
        {#if view === "double"}
          <label class="checkline" title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens">
            <input type="checkbox" bind:checked={firstOnRight} /> P1 right
          </label>
        {/if}
      </div>
     </div>
    </div>

    <div class="wrap">
    {#if result && result.error}
      <div class="banner err">
        {result.error}
        {#if result.prUrl}<a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
      </div>
    {:else if result && result.ok}
      <div class="banner {result.warn ? 'warn' : 'ok'}">
        {result.message}
        {#if result.prUrl}<a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
      </div>
    {/if}

    {#if !canEdit}
      <div class="banner warn">
        {#if data.status === "completed"}
          This task is completed — the view is read-only.
        {:else if data.status !== "encoding_required"}
          This task has been submitted and is awaiting validation — the view is read-only.
        {:else if !data.holdsLock}
          Claim this task to edit.
          <button type="button" onclick={() => claim()} disabled={busy}>Claim task</button>
        {/if}
      </div>
    {/if}

    <div class="pages" class:double={view === "double"} style={`--zoom:${zoom}`}>
      {#if spread.lonelySide === "right"}<div class="page-spacer"></div>{/if}
      {#each spread.pages as p (p)}
        {@const pg = pages[p]}
        {@const systems = systemIndices(pg)}
        <div class="page">
          <p class="pagehead">Page {p + 1}</p>
          {#if pg.failed}
            <div class="banner err">
              The page facsimile for page {p + 1} could not be loaded. The zones
              are shown without their reference image.
            </div>
          {/if}
          <div class="canvas" bind:clientWidth={canvasW[p]}>
            <svg
              bind:this={svgEls[p]}
              viewBox={`0 0 ${pg.width} ${pg.height}`}
              role="application"
              aria-label={`Page ${p + 1} measures`}
              onpointerdown={(e) => backgroundPointerDown(e, p)}
            >
              {#if pg.url}
                <image
                  href={pg.url}
                  width={pg.width}
                  height={pg.height}
                  onerror={() => (pages[p].failed = true)}
                />
              {/if}
              {#each paintOrder(pg, p) as { zone, z } (z)}
                <rect
                  class="zone sys{systems[z] % 2}"
                  class:selected={selected?.p === p && selected?.z === z}
                  class:sysstart={sbActive(p, z)}
                  class:mdivstart={startsMovement(p, z)}
                  role="button"
                  tabindex={0}
                  aria-label={`Measure ${zone.label}: select, drag, or edit its number and breaks`}
                  x={zone.box.ulx}
                  y={zone.box.uly}
                  width={zone.box.lrx - zone.box.ulx}
                  height={zone.box.lry - zone.box.uly}
                  onpointerdown={(e) => zonePointerDown(e, p, z)}
                  onpointerenter={() => hoverEnter(p, z)}
                  onpointerleave={hoverLeave}
                  onkeydown={(e) => zoneKeydown(e, p, z)}
                />
                {@const lbl = labelText(p, z)}
                {@const fs = labelFont(p, pg.width)}
                {@const lblW = lbl.length * fs * 0.62 + fs * 0.9}
                <rect class="labelbg" x={zone.box.ulx + 2} y={zone.box.uly + 3} width={lblW} height={fs * 1.55} rx={fs * 0.28} />
                <text
                  class="zonelabel"
                  x={zone.box.ulx + 2 + lblW / 2}
                  y={zone.box.uly + 3 + fs * 1.12}
                  text-anchor="middle"
                  font-size={fs}
                >{lbl}</text>
                {#if canEdit && selected?.p === p && selected?.z === z}
                  <circle
                    class="handle"
                    role="button"
                    tabindex={0}
                    aria-label={`Measure ${zone.label}: resize`}
                    cx={zone.box.lrx}
                    cy={zone.box.lry}
                    r={Math.max(8, pg.width / 120)}
                    onpointerdown={(e) => handlePointerDown(e, p, z)}
                    onkeydown={(e) => handleKeydown(e, p, z)}
                  />
                {/if}
              {/each}
            </svg>

            {#if canEdit && active && active.p === p && pg.zones[active.z]}
              {@const z = active.z}
              {@const zone = pg.zones[z]}
              {@const box = zone.box}
              <div
                class="zc"
                style={`left:${(box.ulx / pg.width) * 100}%; top:${(box.uly / pg.height) * 100}%; width:${((box.lrx - box.ulx) / pg.width) * 100}%; height:${((box.lry - box.uly) / pg.height) * 100}%; --accent:${accentFor(systems, p, z)}`}
              >
                <div
                  class="zc-inner"
                  role="group"
                  aria-label={`Measure ${zone.label} controls`}
                  onpointerenter={() => hoverEnter(p, z)}
                  onpointerleave={hoverLeave}
                  onpointerdown={(e) => {
                    selected = { p, z };
                    e.stopPropagation();
                  }}
                >
                  <input
                    class="znum"
                    value={zone.override ?? zone.label}
                    size={Math.max(2, String(zone.override ?? zone.label).length)}
                    onfocus={() => (selected = { p, z })}
                    oninput={(e) => setLabel(p, z, (e.target as HTMLInputElement).value)}
                    onchange={() => commit()}
                    title="Measure number — type to override the automatic number (e.g. 10a); numbering continues after it"
                  />
                  <button
                    type="button"
                    class:on={sbActive(p, z)}
                    onclick={() => toggleSb(p, z)}
                    disabled={pbAt(p, z)}
                    aria-pressed={sbActive(p, z)}
                    title={pbAt(p, z)
                      ? "System beginning — implied by the page break on a page's first measure"
                      : "System beginning (sb)"}>↵</button>
                  <button
                    type="button"
                    class:on={startsMovement(p, z)}
                    onclick={() => toggleSection(p, z)}
                    disabled={sectionLocked(p, z)}
                    aria-pressed={startsMovement(p, z)}
                    title={sectionLocked(p, z)
                      ? "The first measure always opens the first section"
                      : "Section beginning — starts a new movement/section (mdiv)"}>§</button>
                  <button type="button" class="zdel" onclick={() => deleteZone(p, z)}
                    title="Delete this measure">✕</button>
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/each}
      {#if spread.lonelySide === "left"}<div class="page-spacer"></div>{/if}
    </div>
    </div>
  {/if}
{/if}

<style>
  .muted {
    color: var(--ink-faint);
    font-size: 0.9rem;
  }

  /* A full-width sticky bar with an edge-to-edge hairline under it (matching the
     app header); its content is centred to line up with the page column. It
     holds every whole-task control; per-measure editing lives on the zones. */
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--card);
    border-bottom: 1px solid var(--line);
  }
  .toolbar-inner {
    max-width: 1600px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.45rem 0.6rem;
    padding: 0.6rem 2rem;
    box-sizing: border-box;
  }
  /* The centred content column below the bar (and for the pre-editor states). */
  .wrap {
    max-width: 1600px;
    margin: 0 auto;
    padding: 1.25rem 2rem 1.5rem;
    box-sizing: border-box;
  }
  .tb-group {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  /* A vertical rule and breathing room separating adjacent tool groups. */
  .tb-div {
    margin-left: 0.5rem;
    padding-left: 0.8rem;
    border-left: 1px solid var(--line);
  }
  .tb-title {
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
  }
  .tb-title a {
    color: var(--ink-soft);
    text-decoration: none;
    white-space: nowrap;
  }
  .tb-task {
    font-weight: 600;
    white-space: nowrap;
  }
  .toolbar .count {
    font-size: 0.82rem;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Zoom + page navigation sit together at the far right of the bar. */
  .tb-right {
    margin-left: auto;
  }
  .tb-nav .nav-label {
    font-size: 0.78rem;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    padding: 0 0.2rem;
  }
  .tb-zoom .zoom-val {
    min-width: 2.8rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
    font-size: 0.82rem;
  }
  .tb-validation .vstatus {
    font-size: 0.8rem;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .tb-validation .vpass {
    color: var(--ok);
  }
  .tb-validation .vfail {
    color: var(--danger);
  }
  .checkline {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  button.on {
    background: var(--invert-bg);
    color: var(--invert-ink);
    border-color: var(--invert-bg);
  }

  .pages {
    min-width: 0;
  }
  /* Two-up view: the spread's pages (and any empty-half spacer) share the row. */
  .pages.double {
    display: flex;
    align-items: flex-start;
    /* A few pixels between the two pages at the spine. */
    gap: 4px;
  }
  .pages.double .page,
  .page-spacer {
    flex: 1 1 0;
    min-width: 0;
  }
  /* Open-book: the left column's page hugs the centre spine (right-aligned),
     the right column's stays left, so the two pages meet in the middle. The
     page headings keep their normal left alignment. */
  .pages.double .page:not(:last-child) .canvas {
    margin-left: auto;
  }
  button {
    font: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.primary {
    background: var(--invert-bg);
    color: var(--invert-ink);
    border-color: var(--invert-bg);
    padding: 0.45rem 0.7rem;
    font-size: 0.85rem;
  }
  .banner {
    padding: 0.7rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
  }
  .banner.ok {
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .banner.err {
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
  .banner.warn {
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
  }

  .page {
    margin-bottom: 1.5rem;
    /* Above 100% zoom the page overflows this box and scrolls horizontally. */
    overflow-x: auto;
  }
  .pagehead {
    margin: 0 0 0.3rem;
    font-weight: 600;
    font-size: 0.9rem;
    position: sticky;
    left: 0;
  }
  /* Positioning context for the per-zone controls overlay: its width tracks the
     zoomed svg so percentage-placed controls line up with the boxes. */
  .canvas {
    position: relative;
    width: calc(100% * var(--zoom, 1));
  }
  svg {
    display: block;
    /* border-box so the 1px border stays within 100% and the page doesn't
       overflow its container by a couple of pixels at 100% zoom. */
    box-sizing: border-box;
    width: 100%;
    max-width: none;
    height: auto;
    border: 1px solid var(--line);
    border-radius: 8px;
    touch-action: none;
    user-select: none;
  }
  .zone {
    fill: rgba(48, 86, 211, 0.12);
    stroke: rgba(48, 86, 211, 0.85);
    stroke-width: 2;
    cursor: pointer;
  }
  .zone.sys0 {
    fill: rgba(48, 86, 211, 0.12);
    stroke: rgba(48, 86, 211, 0.85);
  }
  .zone.sys1 {
    fill: rgba(20, 150, 80, 0.12);
    stroke: rgba(20, 150, 80, 0.85);
  }
  .zone.selected {
    fill-opacity: 1;
    stroke-width: 3.5;
  }
  .zone.sysstart {
    stroke-width: 4;
  }
  .zone.mdivstart {
    stroke: rgba(139, 95, 191, 0.9);
    fill: rgba(139, 95, 191, 0.14);
    stroke-width: 5;
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
    stroke: rgba(48, 86, 211, 0.85);
    stroke-width: 2;
    cursor: nwse-resize;
  }

  /* The per-zone controls: floating buttons bound to the zone box, centred
     left-to-right and dropped below the number label. The outer layer maps to
     the box and ignores the pointer (so the box stays draggable); the inner
     cluster re-enables the pointer and wraps to new rows when the box is narrow.
     Button size tracks zoom, but dampened, so it stays usable when zoomed out.
     The clearance below the label scales with zoom, since the label (SVG text)
     scales linearly with it. */
  .zc {
    position: absolute;
    pointer-events: none;
    overflow: hidden;
    display: flex;
    justify-content: center;
    /* flex-start on the cross axis so the cluster is only as tall as its
       buttons — otherwise it would stretch over the box and block dragging. */
    align-items: flex-start;
    /* Clear the number label, which is ~15px·damp tall on screen; the top pad
       follows the same damp curve (0.7 + 0.3·zoom) so it always clears it. */
    padding: calc(24px * (0.7 + 0.3 * var(--zoom, 1)) + 8px) 0.3rem 0.3rem;
    box-sizing: border-box;
  }
  .zc-inner {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    justify-content: center;
    gap: 0.3em;
    max-width: 100%;
    pointer-events: auto;
    /* Same damp curve as the number label, a touch larger, so buttons and
       numbers grow together with zoom. */
    font-size: clamp(13px, calc(17px * (0.7 + 0.3 * var(--zoom, 1))), 27px);
  }
  .zc-inner .znum,
  .zc-inner button {
    font: inherit;
    font-size: 1em;
    line-height: 1;
    border: 1px solid var(--accent);
    border-radius: 0.4em;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
    cursor: pointer;
  }
  .zc-inner .znum {
    min-width: 2.4em;
    padding: 0.28em 0.4em;
    background: #fff;
    color: #1a1a1a;
    font-variant-numeric: tabular-nums;
    cursor: text;
  }
  .zc-inner button {
    min-width: 2em;
    padding: 0.28em 0.45em;
    font-weight: 700;
    /* Same hue as the zone, but opaque so it reads as a button over the score. */
    background: color-mix(in srgb, var(--accent) 30%, white);
    color: var(--accent);
  }
  .zc-inner button.on {
    background: var(--accent);
    color: #fff;
  }
  /* Disabled (e.g. the system break implied by a page break): clearly inert —
     a dashed, muted, greyscale chip that reads as locked rather than active. */
  .zc-inner button:disabled {
    cursor: default;
    opacity: 1;
    border-style: dashed;
    border-color: #bbb;
    background: #f0f0f0;
    color: #9a9a9a;
    box-shadow: none;
  }
  .zc-inner .zdel {
    border-color: #b42318;
    color: #b42318;
    background: color-mix(in srgb, #b42318 18%, white);
  }
</style>
