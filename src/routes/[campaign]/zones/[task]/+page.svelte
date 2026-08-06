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
  import { CommandRunner, readForge, viewerId } from "$lib/command-runner.svelte.ts";
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
  const viewer = $derived(viewerId());

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

  const runner = new CommandRunner();

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

  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo });

  // Login for the reviewer holding the validation lock (id → login, for display).
  let lockUserLogin = $state("");
  $effect(() => {
    const id = Number(data?.validation?.lockUser);
    if (!Number.isInteger(id) || id <= 0) {
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
    await runner.run(
      () => command(ctx(f)),
      async (result) => {
        if (opts.overviewOnSuccess && result.ok && !result.warn) {
          await goto(`/${campaign}`);
          return;
        }
        runner.log.step("Reloading…");
        data = null;
        await load();
      },
    );
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
      !runner.busy &&
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
  // A fail carries a mandatory comment row; pass submits bare.
  let failOpen = $state(false);
  let failText = $state("");
  const validate = (verdict: string) =>
    run(
      (c) =>
        invoke(
          commands.submitValidation,
          {
            task_id: taskId,
            subtask_id: validation!.subtask_id,
            verdict,
            ...(verdict === "fail"
              ? {
                  comment: {
                    body: failText,
                    page: "",
                    measure_start: "",
                    measure_end: "",
                  },
                }
              : {}),
          },
          c,
        ),
      { overviewOnSuccess: true },
    ).then(() => {
      failOpen = false;
      failText = "";
    });

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

  // Record the current pages as a new entry, dropping any redo tail. The
  // history holds full snapshots, so it is capped: the oldest entries fall
  // off once the limit is reached.
  const HISTORY_LIMIT = 100;
  function commit() {
    history = history.slice(Math.max(0, historyIndex + 2 - HISTORY_LIMIT), historyIndex + 1);
    history.push(clonePages(pages));
    historyIndex = history.length - 1;
  }

  // After a geometry change: re-sort the page into reading order, keep the
  // same zone selected across the re-sort (its index may change) so further
  // edits need no extra click, then record the step.
  function commitGeometry(p: number, zone: EditZone) {
    resort(p);
    selected = { p, z: pages[p].zones.indexOf(zone) };
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

  // Start a move (from the zone body) or resize (from its handle) drag. A
  // click on the zone body selects it even read-only; the handle only exists
  // in edit mode.
  function startZoneDrag(e: PointerEvent, p: number, z: number, kind: "move" | "resize") {
    if (kind === "move") selected = { p, z };
    if (!canEdit) return;
    e.stopPropagation();
    selected = { p, z };
    const { x, y } = svgXY(e, p);
    drag = { kind, p, z, sx: x, sy: y, orig: { ...pages[p].zones[z].box }, moved: false };
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
    commitGeometry(p, pages[p].zones[z]);
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
    commitGeometry(p, pages[p].zones[z]);
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
    commitGeometry(p, pages[p].zones[z]);
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
    (pbAt(z) ? "⇱" : "") +
    (!pbAt(z) && pages[p].zones[z].sb ? "↵" : "");
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

{#if runner.busy}
  <LoadingOverlay log={runner.log} />
{/if}

<div class="corrector">
  {#if data}
    <div class="taskrow">
      <span class="abtitle">Measure review</span>
      <code class="taskchip">{taskId}</code>
      <span class="abcount">
        {measureCount} measure{measureCount === 1 ? "" : "s"}
        · {movementCount} movement{movementCount === 1 ? "" : "s"}
      </span>
      {#if !canEdit}
        {#if data.status === "completed"}
          <span class="lockpill grey">completed — read-only</span>
        {:else if data.status !== "encoding_required"}
          <span class="lockpill amber">submitted — awaiting validation, read-only</span>
        {:else}
          <span class="lockpill amber">unclaimed — read-only</span>
          <button type="button" class="claimbtn" onclick={() => claim()} disabled={runner.busy}>Claim task</button>
        {/if}
      {/if}
      <span class="abspacer"></span>
      <button
        type="button"
        class="submitbtn"
        onclick={() => submit()}
        disabled={runner.busy || !canEdit}
        title="Submit the corrected measures, breaks and movements for validation"
      >
        Submit corrections
      </button>
    </div>
  {/if}

  {#if notFound}
    <div class="deskwrap">
      <div class="banner err">
        No campaign called <code>{campaign}</code> was found.
        <a href="/">Back to all campaigns</a>.
      </div>
    </div>
  {:else if auth.status === "loading" || (!resolved && !notFound)}
    <div class="deskwrap"><p class="muted">Loading…</p></div>
  {:else if !auth.user}
    <div class="deskwrap">
      <div class="banner warn">
        Please <button type="button" class="linkish" onclick={() => login()}>log in with GitHub</button>
        to work on this task.
      </div>
    </div>
  {:else if loading}
    <div class="deskwrap"><p class="muted">Loading the facsimile…</p></div>
  {:else if loadError}
    <div class="deskwrap"><div class="banner err">{loadError}</div></div>
  {:else if data}
    <div class="toolpanel">
      {#if canEdit}
        <div class="tb-group">
          <button type="button" onclick={() => undo()} disabled={!canUndo} title="Undo the last change (Ctrl/Cmd+Z)">↶ Undo</button>
          <button type="button" onclick={() => redo()} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">Redo ↷</button>
        </div>
        <span class="vline"></span>
      {/if}
      <div class="tb-group">
        <button type="button" class="round" onclick={() => zoomBy(-ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out">−</button>
        <span class="zoom-val">{Math.round(zoom * 100)}%</span>
        <button type="button" class="round" onclick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" onclick={() => (zoom = 1)} disabled={zoom === 1} title="Fit page to width">Fit</button>
      </div>
      <span class="vline"></span>
      <div class="tb-group">
        <button type="button" class="round" onclick={() => go(-1)} disabled={spreadIndex <= 0} aria-label="Previous page" title="Previous page">‹</button>
        <span class="nav-label">{spreadLabel}</span>
        <button type="button" class="round" onclick={() => go(1)} disabled={spreadIndex >= spreads.length - 1} aria-label="Next page" title="Next page">›</button>
      </div>
      <span class="vline"></span>
      <div class="tb-group">
        <div class="viewseg">
          <button type="button" class:on={view === "single"} onclick={() => (view = "single")} title="Show one page">1 page</button>
          <button type="button" class:on={view === "double"} onclick={() => (view = "double")} title="Show a two-page spread">2 pages</button>
        </div>
        {#if view === "double"}
          <label class="checkline" title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens">
            <input type="checkbox" bind:checked={firstOnRight} /> P1 right
          </label>
        {/if}
      </div>
      {#if validation && submitted}
        <span class="vline"></span>
        <div class="tb-group tb-validation">
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
          <button type="button" onclick={() => claimValidation()} disabled={runner.busy || !canClaimValidation}
            title="Reserve this subtask for validation. Encoders cannot validate their own work.">Claim</button>
          <button type="button" class="vpass" onclick={() => validate("pass")} disabled={runner.busy || !holdsValidation}
            title="Record a passing verdict.">Pass</button>
          <button type="button" class="vfail" class:on={failOpen} onclick={() => (failOpen = !failOpen)} disabled={runner.busy || !holdsValidation}
            title="Record a failing verdict — a fail carries a comment saying why.">Fail</button>
          {#if failOpen && holdsValidation}
            <input
              class="fail-note"
              bind:value={failText}
              placeholder="Why does this fail?"
              onkeydown={(e) => {
                if (e.key === "Enter" && failText.trim()) validate("fail");
              }}
            />
            <button
              type="button"
              class="vfail"
              onclick={() => validate("fail")}
              disabled={runner.busy || !failText.trim()}
              title="Submit the failing verdict with this comment."
              >Submit fail</button
            >
          {/if}
        </div>
      {/if}
    </div>

    {#if runner.result && runner.result.error}
      <div class="banner err bar">
        {runner.result.error}
        {#if runner.result.prUrl}<a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
      </div>
    {:else if runner.result && runner.result.ok}
      <div class="banner {runner.result.warn ? 'warn' : 'ok'} bar">
        {runner.result.message}
        {#if runner.result.prUrl}<a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
      </div>
    {/if}

    <div class="desk">
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
                    onpointerdown={(e) => startZoneDrag(e, p, z, "move")}
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
                      onpointerdown={(e) => startZoneDrag(e, p, z, "resize")}
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
                  style={`left:${(((box.ulx + box.lrx) / 2) / pg.width) * 100}%; top:${(box.uly / pg.height) * 100}%; --accent:${accentFor(systems, p, z)}`}
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
                      disabled={pbAt(z)}
                      aria-pressed={sbActive(p, z)}
                      title={pbAt(z)
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

    <div class="statusbar">
      {#if canEdit}
        <span class="lockpill ok">you hold this task</span>
        <span class="hints">drag on the page to draw a measure · drag a box to move · corner handle resizes · arrows nudge (⇧ ×5)</span>
      {/if}
      <span class="sspacer"></span>
      <span class="hints">⌘Z undo · ⌘⇧Z redo · ⌫ delete · ← → pages</span>
      <span class="ssep">·</span>
      <span class="hints">blue/green = alternating systems · <span class="legend-mdiv">purple = movement start</span></span>
    </div>
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

  /* The whole tool: a task header, a tool panel, the desk the page sheets
     float on (the only scrolling region), and a status strip. The app's
     navigation bar comes from the layout, as on every other page. */
  .corrector {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--desk);
  }

  /* ---------------------------------------------------------- task header */
  .taskrow {
    flex: none;
    box-sizing: border-box;
    background: var(--topbar-bg);
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    padding: 10px 24px;
    gap: 14px;
  }
  .abtitle {
    font-size: 14px;
    font-weight: 700;
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
    white-space: nowrap;
  }
  .abspacer {
    flex: 1;
  }
  .submitbtn {
    font: 600 13.5px var(--font);
    padding: 8px 18px;
    border-radius: 999px;
    border: 0;
    background: var(--accent-btn);
    color: #fff;
    cursor: pointer;
    box-shadow: 0 3px 10px rgba(37, 99, 201, 0.3);
    white-space: nowrap;
  }
  .submitbtn:hover:not(:disabled) {
    background: var(--accent-btn-hover);
  }
  .submitbtn:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
  }

  /* ---------------------------------------------------------- tool panel */
  .toolpanel {
    flex: none;
    background: color-mix(in srgb, var(--card) 75%, transparent);
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    padding: 8px 24px;
    gap: 12px 20px;
  }
  .tb-group {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .vline {
    width: 1px;
    height: 22px;
    background: var(--line);
    flex: none;
  }
  .toolpanel button {
    font: 600 12.5px var(--font);
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink);
    cursor: pointer;
    white-space: nowrap;
  }
  .toolpanel button:hover:not(:disabled) {
    border-color: var(--info-line);
  }
  .toolpanel button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .toolpanel button.round {
    width: 28px;
    height: 28px;
    padding: 0;
    color: var(--ink-soft);
  }
  .zoom-val {
    min-width: 42px;
    text-align: center;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
  }
  .nav-label {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink-soft);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    padding: 0 2px;
  }
  .viewseg {
    display: flex;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 3px;
  }
  .viewseg button {
    border: 0;
    background: none;
    color: var(--ink-faint);
    padding: 4px 12px;
  }
  .viewseg button.on {
    background: var(--card);
    color: var(--ink);
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.1);
  }
  .checkline {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
    cursor: pointer;
  }
  .tb-validation .vstatus {
    font-size: 12.5px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .tb-validation .vpass {
    color: var(--ok);
  }
  .tb-validation .vfail {
    color: var(--danger);
  }
  .tb-validation .vfail.on {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
    color: #fff;
  }
  .tb-validation .fail-note {
    font: inherit;
    font-size: 12.5px;
    width: 220px;
    padding: 5px 10px;
    border: 1px solid var(--danger-line);
    border-radius: 999px;
    background: var(--card);
    color: var(--ink);
  }

  /* ------------------------------------------------------ banners & desk */
  .banner {
    padding: 0.7rem 1rem;
    border-radius: 8px;
  }
  .banner.bar {
    flex: none;
    border-radius: 0;
    border-left: 0;
    border-right: 0;
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
  .banner a {
    color: var(--link);
  }
  /* Pre-editor states (loading, errors, login) on the desk. */
  .deskwrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 1.25rem 2rem;
    box-sizing: border-box;
  }
  .desk {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 40px;
    box-sizing: border-box;
  }
  .pages {
    min-width: 0;
    max-width: 1600px;
    margin: 0 auto;
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

  .page {
    margin-bottom: 1.5rem;
    /* Above 100% zoom the page overflows this box and scrolls horizontally. */
    overflow-x: auto;
  }
  .pagehead {
    margin: 0 0 0.3rem;
    font-size: 11.5px;
    color: var(--ink-faint);
    text-align: center;
    position: sticky;
    left: 0;
  }
  /* Positioning context for the per-zone controls overlay: its width tracks the
     zoomed svg so percentage-placed controls line up with the boxes. */
  .canvas {
    position: relative;
    width: calc(100% * var(--zoom, 1));
  }
  /* One-page view: the page stays centred when zoomed out. */
  .pages:not(.double) .canvas {
    margin-inline: auto;
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

  /* The per-zone controls: a floating pill above the active box (number input ·
     ↵ · § · ✕). The outer layer is a zero-size anchor at the box's top centre;
     the pill hangs above it and re-enables the pointer. */
  .zc {
    position: absolute;
    pointer-events: none;
    transform: translate(-50%, calc(-100% - 8px));
    z-index: 5;
  }
  .zc-inner {
    display: flex;
    align-items: center;
    gap: 4px;
    pointer-events: auto;
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 999px;
    padding: 4px 6px;
    box-shadow: 0 6px 18px rgba(31, 36, 51, 0.18);
    white-space: nowrap;
  }
  .zc-inner .znum,
  .zc-inner button {
    font: 600 11.5px var(--font);
    line-height: 1;
    cursor: pointer;
  }
  .zc-inner .znum {
    width: 36px;
    padding: 4px 5px;
    border: 1px solid var(--line-input);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    text-align: center;
    font-variant-numeric: tabular-nums;
    cursor: text;
  }
  .zc-inner button {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--line-input);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink-soft);
  }
  .zc-inner button.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  /* Disabled (e.g. the system break implied by a page break): clearly inert. */
  .zc-inner button:disabled {
    cursor: default;
    border-style: dashed;
    color: var(--ink-faint);
    background: var(--bg-alt);
  }
  .zc-inner .zdel {
    border-color: var(--danger-line);
    color: var(--danger);
  }

  /* ---------------------------------------------------------- status strip */
  .statusbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 24px;
    background: color-mix(in srgb, var(--card) 85%, transparent);
    border-top: 1px solid var(--line);
    font-size: 12px;
    color: var(--ink-faint);
    min-width: 0;
  }
  .lockpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 700;
    border-radius: 999px;
    padding: 2px 10px;
  }
  .lockpill.ok {
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .lockpill.amber {
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
  }
  .lockpill.grey {
    color: var(--ink-faint);
    background: var(--bg-tint);
    border: 1px solid var(--line);
  }
  .claimbtn {
    flex: none;
    font: 600 12px var(--font);
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink);
    cursor: pointer;
  }
  .claimbtn:hover:not(:disabled) {
    border-color: var(--info-line);
  }
  .claimbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hints {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ssep {
    color: var(--line-input);
    flex: none;
  }
  .sspacer {
    flex: 1;
  }
  .legend-mdiv {
    color: var(--pre);
    font-weight: 600;
  }
</style>
