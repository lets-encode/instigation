<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result, FacsimileTaskData } from "$lib/commands.ts";
  import { readingOrderRows, nextLabel } from "$lib/mei-facsimile.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import { elapsed } from "$lib/campaign-board.ts";
  import type { PageModel, MeasureBox } from "$lib/mei-facsimile.ts";
  import { buildSpreads } from "$lib/page-spreads.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import { CommandRunner, readForge, viewerId } from "$lib/command-runner.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
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
  // Whether a load has been attempted for the current params; a failed load
  // stays on its error banner instead of retrying.
  let loaded = $state(false);
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

  // Page zoom: the fraction of the canvas width one page occupies. 1 = fit the
  // canvas; above 1 the page overflows and its container scrolls horizontally.
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 4;
  let zoom = $state(1);

  // The slider runs on a log scale: equal drags multiply the zoom equally,
  // so the low end moves in fine steps and the high end in coarse ones.
  const ZOOM_STOPS = 100;
  const zoomPos = $derived(
    Math.round((Math.log(zoom / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * ZOOM_STOPS),
  );
  const setZoomPos = (p: number) =>
    (zoom = Math.round(ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (p / ZOOM_STOPS) * 100) / 100);

  // The desk's inner size, for the whole-page fit.
  let deskW = $state(0);
  let deskH = $state(0);

  // The zoom at which a whole page fits in the desk: bounded by the height
  // (using the tallest page), capped at 1 (the width fit). 58 covers the
  // desk padding and the page heading above each sheet.
  function fitZoom(): number {
    if (!pages.length || !deskW || !deskH) return 1;
    const aspect = Math.max(...pages.map((p) => p.height / p.width));
    const pagesW = deskW - 48;
    const colW = view === "double" ? (pagesW - 4) / 2 : pagesW;
    const usableH = deskH - 58;
    if (colW <= 0 || usableH <= 0) return 1;
    const z = usableH / (colW * aspect);
    return Math.min(1, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
  }

  // Open each freshly loaded task at the whole-page fit (the desk size is
  // bound after the desk renders, so this cannot run inside load itself).
  let zoomInitFor = $state<FacsimileTaskData | null>(null);
  $effect(() => {
    if (!data || !pages.length || !deskW || !deskH || zoomInitFor === data) return;
    zoomInitFor = data;
    zoom = fitZoom();
  });

  // Book-style paging: show one spread at a time rather than every page.
  // `view` is one or two pages per spread; `firstOnRight` places page 1 as a
  // right-hand page (recto), so a two-up view pairs 2|3, 4|5, … the way a
  // score opens — the printed page number's side can't be read without OCR, so
  // this convention (with the toggle) stands in for it.
  let view = $state<"single" | "double">("double");
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
    // Results for a task the page has since navigated away from are dropped.
    const task = taskId;
    const name = campaign;
    const stale = () => task !== taskId || name !== campaign;
    loading = true;
    loadError = null;
    selected = null;
    hovered = null;
    firstVisible = 0;
    try {
      const d = await invoke(commands.readFacsimile, { task_id: task }, ctx(f));
      if (stale()) return;
      data = d;
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
      if (!stale()) loadError = `Could not load ${task}: ${(e as Error).message}`;
    } finally {
      if (!stale()) loading = false;
    }
  }

  // A same-route navigation to another campaign or task starts over: the
  // resolved repo and the loaded task belong to the previous params.
  $effect(() => {
    void campaign;
    resolved = null;
    notFound = false;
  });
  $effect(() => {
    void campaign;
    void taskId;
    data = null;
    pages = [];
    loadError = null;
    loaded = false;
  });

  // Resolve the campaign name to its repo first; the load effect is gated on
  // `owner`/`repo` so it waits for this.
  $effect(() => {
    if (auth.status === "loading" || resolved || notFound || resolving) return;
    resolving = true;
    // A result for a name the page has since navigated away from is dropped.
    const name = campaign;
    resolveCampaign(readForge(), name)
      .then((r) => {
        if (name !== campaign) return;
        if (r) resolved = r;
        else notFound = true;
      })
      .catch(() => {
        if (name === campaign) notFound = true;
      })
      .finally(() => (resolving = false));
  });

  // One load per param set: a failed attempt renders the error banner (with
  // its manual retry) instead of looping.
  $effect(() => {
    if (auth.status === "authenticated" && owner && repo && taskId && !loaded) {
      loaded = true;
      load();
    }
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
        // A rejected command changed nothing worth reloading for — and a
        // reload would discard the zone edits the volunteer may retry from.
        if (result.error) return;
        if (opts.overviewOnSuccess) {
          if (result.ok && !result.warn) await goto(`/${campaign}`);
          // Still processing (warn): keep the editor and its edits as they are.
          return;
        }
        // A background command changed nothing yet — the settle listener
        // reloads when its verdict lands.
        if (result.background) return;
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
  // preview, so reaching the editor means intent to edit. Fire once per task,
  // and only when the claim can actually be granted: never while someone else
  // holds the task or a dependency still blocks it — that PR would only come
  // back rejected.
  let autoClaimedFor = $state<string | null>(null);
  $effect(() => {
    if (
      data &&
      !runner.busy &&
      autoClaimedFor !== taskId &&
      data.status === "encoding_required" &&
      !data.holdsLock &&
      !data.encodingLockUser &&
      !data.blockedBy
    ) {
      autoClaimedFor = taskId;
      claim();
    }
  });

  // The review happens here too: the same claim/pass/fail the console offers,
  // against the task's validation subtask.
  const validation = $derived(data?.validation ?? null);
  // A verdict already submitted here and still being processed: the verdict
  // controls hold until it lands — a repeat would only be rejected.
  const verdictPending = $derived(
    !!validation &&
      pendingVerdicts.isProcessing(`validate:${taskId}/${validation.subtask_id}`),
  );
  // A settled background verdict changed the tables; reload the read-only
  // view so it shows the recorded state. An edit session is never reloaded —
  // that would discard the volunteer's unsubmitted work.
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (!canEdit && !runner.busy) {
        data = null;
        loaded = false;
      }
    }),
  );
  const submitted = $derived(
    data?.status === "validation_required" || data?.status === "completed",
  );
  const holdsValidation = $derived(
    viewer !== "" && validation?.lockUser === viewer,
  );
  const selfValidation = $derived(
    !!data && data.encoder !== "" && data.encoder === viewer && !data.allowSelfValidation,
  );
  // One verdict per person: a validator who already recorded pass/fail here
  // cannot claim another slot (matching the campaign automation's rule).
  const alreadyValidated = $derived(
    !!data &&
      !data.allowSelfValidation &&
      (validation?.verdicts ?? []).some((v) => v.user === viewer),
  );
  const canClaimValidation = $derived(
    !!validation &&
      validation.status === "validation_required" &&
      validation.openSlots > 0 &&
      !validation.lockUser &&
      !selfValidation &&
      !alreadyValidated &&
      !verdictPending,
  );
  const failComments = $derived(data?.failComments ?? []);
  const failedVerdicts = $derived(
    (validation?.verdicts ?? []).filter((v) => v.verdict === "fail"),
  );
  // Sending a failed task back is open to a failing validator or push access —
  // the same rule the automation enforces.
  const canSendBack = $derived(
    viewer !== "" &&
      data?.status === "validation_required" &&
      failedVerdicts.length > 0 &&
      (data.canPush || failedVerdicts.some((v) => v.user === viewer)),
  );
  const sendBack = () =>
    run((c) => invoke(commands.sendBack, { task_id: taskId }, c));
  // Same hold for a send-back already on its way.
  const sendBackPending = $derived(
    pendingVerdicts.isProcessing(`sendback:${taskId}`),
  );

  // Logins for verdict authors, fail-comment authors and the encoding lock
  // holder (id → login, display).
  let logins = $state<Record<string, string>>({});
  $effect(() => {
    const ids = new Set<string>();
    for (const v of data?.validation?.verdicts ?? []) if (v.user) ids.add(v.user);
    for (const c of data?.failComments ?? []) if (c.author_id) ids.add(c.author_id);
    if (data?.encodingLockUser) ids.add(data.encodingLockUser);
    for (const id of ids) {
      if (logins[id]) continue;
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) continue;
      readForge()
        .getUserLogin(n)
        .then((login) => {
          if (login) logins[id] = login;
        })
        .catch(() => {});
    }
  });
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
      // A failed submission keeps the typed comment for the retry.
      if (runner.result?.ok) {
        failOpen = false;
        failText = "";
      }
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

  // Vertical anchor for the zone-controls pill (its top edge), as a percentage
  // of the page height: centred in the box's upper third, but clamped so the
  // pill — a fixed on-screen size — never pokes out of a short box's top.
  const ZC_HALF_PX = 17;
  function zcTop(p: number, box: MeasureBox): number {
    const pg = pages[p];
    // Screen pixels per page unit; the SVG keeps its aspect, so one scale.
    const scale = canvasW[p] ? canvasW[p] / pg.width : 1;
    const off = Math.max(6 / scale, (box.lry - box.uly) / 6 - ZC_HALF_PX / scale);
    return ((box.uly + off) / pg.height) * 100;
  }
  type Drag = {
    kind: "move" | "resize" | "draw";
    p: number;
    z: number;
    sx: number;
    sy: number;
    orig: MeasureBox;
    moved: boolean;
    // For a resize: which edges follow the pointer — "n", "s", "e", "w" or a
    // corner's pair ("nw", "se", …).
    edges: string;
  };
  let drag: Drag | null = null;

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

  function svgXY(e: PointerEvent, p: number): { x: number; y: number } {
    const svg = svgEls[p];
    const r = svg.getBoundingClientRect();
    const pg = pages[p];
    return {
      x: Math.max(0, Math.min(pg.width, ((e.clientX - r.left) * pg.width) / r.width)),
      y: Math.max(0, Math.min(pg.height, ((e.clientY - r.top) * pg.height) / r.height)),
    };
  }

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
    drag = { kind, p, z, sx: x, sy: y, orig: { ...pages[p].zones[z].box }, moved: false, edges };
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

  // Arrow keys on a focused resize handle move that handle's edges.
  function resizeKeydown(e: KeyboardEvent, p: number, z: number, edges: string) {
    if (!canEdit || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
    const box = pages[p].zones[z].box;
    const pg = pages[p];
    const step = e.shiftKey ? 10 : 2;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    if (edges.includes("w")) box.ulx = Math.max(0, Math.min(box.lrx - 5, box.ulx + dx));
    if (edges.includes("e")) box.lrx = Math.min(pg.width, Math.max(box.ulx + 5, box.lrx + dx));
    if (edges.includes("n")) box.uly = Math.max(0, Math.min(box.lry - 5, box.uly + dy));
    if (edges.includes("s")) box.lry = Math.min(pg.height, Math.max(box.uly + 5, box.lry + dy));
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
    drag = { kind: "draw", p, z, sx: x, sy: y, orig: { ulx: x, uly: y, lrx: x, lry: y }, moved: false, edges: "" };
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
    } else if (drag.kind === "draw") {
      // Drawing drags the lower-right corner from the start point.
      box.lrx = Math.max(box.ulx + 5, x);
      box.lry = Math.max(box.uly + 5, y);
    } else {
      // The grabbed edges follow the pointer; the opposite ones stay put.
      if (drag.edges.includes("w")) box.ulx = Math.min(drag.orig.lrx - 5, x);
      if (drag.edges.includes("e")) box.lrx = Math.max(drag.orig.ulx + 5, x);
      if (drag.edges.includes("n")) box.uly = Math.min(drag.orig.lry - 5, y);
      if (drag.edges.includes("s")) box.lry = Math.max(drag.orig.uly + 5, y);
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

  // Hover tooltip explaining a zone's break marker, if it carries one.
  const zoneTitle = (p: number, z: number) => {
    if (pbAt(z)) return "⇱ page beginning — automatic: the first measure on each page";
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
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} onkeydown={keydown} />

{#if runner.busy}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="corrector">
  {#if notFound}
    <div class="deskwrap">
      <div class="banner err">
        No campaign called <code>{campaign}</code> was found.
        <a href="/campaigns">Back to all campaigns</a>.
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
    <div class="deskwrap">
      <div class="banner err">
        {loadError}
        <button type="button" class="linkish" onclick={() => load()}>Try again</button>
      </div>
    </div>
  {:else if data}
    <div class="main">
    <div class="ctoolbar">
      <button
        type="button"
        class="btn btn-icon"
        onclick={() => go(-1)}
        disabled={spreadIndex <= 0}
        aria-label="Previous page"
        title="Previous page">‹</button
      >
      <span class="pglabel">{spreadLabel}</span>
      <button
        type="button"
        class="btn btn-icon"
        onclick={() => go(1)}
        disabled={spreadIndex >= spreads.length - 1}
        aria-label="Next page"
        title="Next page">›</button
      >
      <div class="seg" title="How many pages the desk shows at once">
        <button type="button" class:on={view === "single"} onclick={() => (view = "single")}>1 page</button>
        <button type="button" class:on={view === "double"} onclick={() => (view = "double")}>2 pages</button>
      </div>
      {#if view === "double"}
        <label class="checkline" title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens">
          <input type="checkbox" bind:checked={firstOnRight} /> Page 1 right
        </label>
      {/if}
      <span class="tspacer"></span>
      <span class="vline"></span>
      <input
        class="zoomslider"
        type="range"
        aria-label="Zoom"
        aria-valuetext={`${Math.round(zoom * 100)}%`}
        min={0}
        max={ZOOM_STOPS}
        step={1}
        value={zoomPos}
        oninput={(e) => setZoomPos(Number((e.target as HTMLInputElement).value))}
      />
      <span class="zval">{Math.round(zoom * 100)}%</span>
      <button
        type="button"
        class="tbtn"
        onclick={() => (zoom = fitZoom())}
        disabled={zoom === fitZoom()}
        title="Fit the whole page in the view">Fit</button
      >
    </div>
    {#if runner.result && runner.result.error}
      <div class="banner err bar">
        {runner.result.error}
        {#if runner.result.prUrl}<a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
      </div>
    {:else if runner.result && runner.result.ok && !runner.result.background}
      <div class="banner {runner.result.warn ? 'warn' : 'ok'} bar">
        {runner.result.message}
        {#if runner.result.prUrl}<a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>{/if}
      </div>
    {/if}
    <TaskRunState task={taskId} bar />

    <div class="desk" bind:clientWidth={deskW} bind:clientHeight={deskH}>
      <div class="pages" class:double={view === "double"} style={`--zoom:${zoom}`}>
        {#if spread.lonelySide === "right"}<div class="page-spacer"></div>{/if}
        {#each spread.pages as p (p)}
          {@const pg = pages[p]}
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
                    class="zone"
                    class:selected={selected?.p === p && selected?.z === z}
                    class:mdivstart={startsMovement(p, z)}
                    vector-effect="non-scaling-stroke"
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
                  >
                    {#if zoneTitle(p, z)}
                      <title>{zoneTitle(p, z)}</title>
                    {/if}
                  </rect>
                  {@const lbl = labelText(p, z)}
                  {@const fs = labelFont(p, pg.width)}
                  {@const inset = fs * 0.6}
                  {@const lblW = lbl.length * fs * 0.62 + fs * 0.9}
                  <rect class="labelbg" x={zone.box.ulx + inset} y={zone.box.uly + inset} width={lblW} height={fs * 1.55} rx={fs * 0.28} />
                  <text
                    class="zonelabel"
                    x={zone.box.ulx + inset + lblW / 2}
                    y={zone.box.uly + inset + fs * 1.12}
                    text-anchor="middle"
                    font-size={fs}
                  >{lbl}</text>
                  {#if canEdit && selected?.p === p && selected?.z === z}
                    {@const r = Math.max(8, pg.width / 120)}
                    {@const b = zone.box}
                    {#each [
                      { edges: "n", name: "top edge", x: b.ulx + r, y: b.uly - r / 2, w: Math.max(0, b.lrx - b.ulx - 2 * r), h: r },
                      { edges: "s", name: "bottom edge", x: b.ulx + r, y: b.lry - r / 2, w: Math.max(0, b.lrx - b.ulx - 2 * r), h: r },
                      { edges: "w", name: "left edge", x: b.ulx - r / 2, y: b.uly + r, w: r, h: Math.max(0, b.lry - b.uly - 2 * r) },
                      { edges: "e", name: "right edge", x: b.lrx - r / 2, y: b.uly + r, w: r, h: Math.max(0, b.lry - b.uly - 2 * r) },
                    ] as s (s.edges)}
                      <rect
                        class="edge {resizeCursor(s.edges)}"
                        role="button"
                        tabindex={0}
                        aria-label={`Measure ${zone.label}: resize (${s.name})`}
                        x={s.x}
                        y={s.y}
                        width={s.w}
                        height={s.h}
                        onpointerdown={(e) => startZoneDrag(e, p, z, "resize", s.edges)}
                        onkeydown={(e) => resizeKeydown(e, p, z, s.edges)}
                      />
                    {/each}
                    {#each [
                      { edges: "nw", name: "top-left corner", cx: b.ulx, cy: b.uly },
                      { edges: "ne", name: "top-right corner", cx: b.lrx, cy: b.uly },
                      { edges: "sw", name: "bottom-left corner", cx: b.ulx, cy: b.lry },
                      { edges: "se", name: "bottom-right corner", cx: b.lrx, cy: b.lry },
                    ] as c (c.edges)}
                      <circle
                        class="handle {resizeCursor(c.edges)}"
                        vector-effect="non-scaling-stroke"
                        role="button"
                        tabindex={0}
                        aria-label={`Measure ${zone.label}: resize (${c.name})`}
                        cx={c.cx}
                        cy={c.cy}
                        r={r}
                        onpointerdown={(e) => startZoneDrag(e, p, z, "resize", c.edges)}
                        onkeydown={(e) => resizeKeydown(e, p, z, c.edges)}
                      />
                    {/each}
                  {/if}
                {/each}
              </svg>

              {#if canEdit && active && active.p === p && pg.zones[active.z]}
                {@const z = active.z}
                {@const zone = pg.zones[z]}
                {@const box = zone.box}
                <div
                  class="zc"
                  style={`left:${(((box.ulx + box.lrx) / 2) / pg.width) * 100}%; top:${zcTop(p, box)}%; --accent:${accentFor(p, z)}`}
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
    </div>

    <aside class="sidebar">
      <div class="sb-section">
        <div class="sb-title">
          <span class="abtitle">Measure review</span>
          <code class="taskchip">{taskId}</code>
        </div>
        <span class="abcount">
          {measureCount} measure{measureCount === 1 ? "" : "s"}
          · {movementCount} movement{movementCount === 1 ? "" : "s"}
        </span>
        {#if canEdit}
          <span class="lockpill ok">you hold this task</span>
        {:else if data.status === "completed"}
          <span class="lockpill grey">completed — read-only</span>
        {:else if data.status !== "encoding_required"}
          {#if failedVerdicts.length > 0 && validation?.openSlots === 0}
            <span class="lockpill red">validation failed — read-only</span>
          {:else}
            <span class="lockpill amber">submitted — awaiting validation, read-only</span>
          {/if}
        {:else if data.blockedBy}
          <span class="lockpill grey">waits for {data.blockedBy} — read-only</span>
        {:else if data.encodingLockUser}
          <span class="lockpill amber"
            >claimed by @{handle(logins, data.encodingLockUser)} — read-only</span
          >
        {:else}
          <span class="lockpill amber">unclaimed — read-only</span>
          <button type="button" class="btn" onclick={() => claim()} disabled={runner.busy}>Claim task</button>
        {/if}
        <button
          type="button"
          class="btn btn-primary submitbtn"
          onclick={() => submit()}
          disabled={runner.busy || !canEdit}
          title="Submit the corrected measures, breaks and movements for validation"
        >
          Submit corrections
        </button>
      </div>

      {#if failComments.length > 0}
        <div class="sb-section">
          <span class="sb-label">Fail comments</span>
          {#each failComments as c (c.comment_id)}
            <div class="failnote" class:resolved={c.resolved === "true"}>
              <span class="failwho"
                >@{handle(logins, c.author_id)} · {elapsed(c.timestamp)}{c.resolved ===
                "true"
                  ? " · resolved"
                  : ""}</span
              >
              <div class="failtext">“{c.body}”</div>
            </div>
          {/each}
        </div>
      {/if}

      {#if canEdit}
        <div class="sb-section">
          <span class="sb-label">Edit</span>
          <div class="sb-row two">
            <button type="button" class="btn" onclick={() => undo()} disabled={!canUndo} title="Undo the last change (Ctrl/Cmd+Z)">↶ Undo</button>
            <button type="button" class="btn" onclick={() => redo()} disabled={!canRedo} title="Redo (Ctrl/Cmd+Shift+Z)">Redo ↷</button>
          </div>
        </div>
      {/if}

      {#if validation && submitted}
        <div class="sb-section sb-validation">
          <span class="sb-label">Validation</span>
          <span class="vstatus">
            {#if validation.status === "completed"}
              Validation complete
            {:else if verdictPending}
              Your verdict is being processed…
            {:else if validation.lockUser}
              {holdsValidation ? "You are validating" : `@${lockUserLogin || validation.lockUser} validating`}
            {:else if failedVerdicts.length > 0 && validation.openSlots === 0}
              Failed — send it back to redo the correction
            {:else if selfValidation}
              Your own submission
            {:else if alreadyValidated}
              You validated this — another volunteer is needed
            {:else}
              Awaiting validation
            {/if}
          </span>
          {#each validation.verdicts as v, i (i)}
            <span class="vrow {v.verdict}"
              >{#if v.verdict === "pass"}<img
                  class="hand-pass"
                  src="/green-hand.svg"
                  alt=""
                /> pass{:else}✗ fail{/if} · @{handle(logins, v.user)} · {elapsed(
                v.ts,
              )}</span
            >
          {/each}
          {#if validation.status !== "completed" && validation.openSlots > 0}
            <div class="sb-row three">
              <button type="button" class="btn" onclick={() => claimValidation()} disabled={runner.busy || !canClaimValidation}
                title={data?.allowSelfValidation
                  ? "Reserve this subtask for validation."
                  : "Reserve this subtask for validation. Encoders cannot validate their own work."}>Claim</button>
              <button type="button" class="btn btn-primary btn-finish" onclick={() => validate("pass")} disabled={runner.busy || !holdsValidation || verdictPending}
                title="Record a passing verdict.">Pass</button>
              <button type="button" class="btn btn-danger vfail" class:on={failOpen} onclick={() => (failOpen = !failOpen)} disabled={runner.busy || !holdsValidation || verdictPending}
                title="Record a failing verdict — a fail carries a comment saying why.">Fail</button>
            </div>
          {/if}
          {#if failOpen && holdsValidation}
            <input
              class="fail-note"
              bind:value={failText}
              placeholder="Why does this fail?"
              onkeydown={(e) => {
                if (e.key === "Enter" && failText.trim()) validate("fail");
              }}
            />
            <div class="sb-row one">
              <button
                type="button"
                class="btn btn-danger"
                onclick={() => validate("fail")}
                disabled={runner.busy || !failText.trim() || verdictPending}
                title="Submit the failing verdict with this comment."
                >Submit fail</button
              >
            </div>
          {/if}
          {#if canSendBack}
            <button
              type="button"
              class="btn btn-danger sendbackbtn"
              onclick={() => sendBack()}
              disabled={runner.busy || sendBackPending}
              title="Return the task to measure correction: attribution and validations reset."
              >Send back to measure correction</button
            >
          {/if}
        </div>
      {/if}

      <div class="sb-foot">
        {#if canEdit}
          <p>drag on the page to draw a measure · drag a box to move · edges and corners resize · arrows nudge (⇧ ×5)</p>
        {/if}
        <p>⌘Z undo · ⌘⇧Z redo · ⌫ delete · ← → pages</p>
        <p><span class="legend-mdiv">purple = movement start</span></p>
      </div>
    </aside>
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

  /* The whole tool: a sidebar with the task info and controls, and the desk
     the page sheets float on (the only scrolling region). The app's
     navigation bar and footer come from the layout, as on every other page. */
  .corrector {
    flex: 1;
    min-height: 0;
    display: flex;
    background: var(--desk);
    box-shadow: var(--shadow-inset);
  }

  /* ---------------------------------------------------------------- sidebar
     A column of ruled-off sections on the right: task, edit, zoom, pages,
     validation, and the hints/legend foot. */
  .sidebar {
    flex: none;
    width: 264px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    padding: 12px 16px;
    background: color-mix(in srgb, var(--card) 75%, transparent);
    border-left: 1px solid var(--line);
    overflow-y: auto;
  }
  .sb-section {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 12px 0;
    border-top: 1px solid var(--line);
  }
  .sb-section:first-child {
    border-top: 0;
    padding-top: 4px;
  }
  .sb-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .sb-title {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .abtitle {
    font-size: 14px;
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
    white-space: nowrap;
  }
  .submitbtn {
    align-self: stretch;
  }

  /* A control row filling the sidebar's width; .one/.two/.three divide it
     into that many equal cells. */
  .sb-row {
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sb-row.one,
  .sb-row.two,
  .sb-row.three {
    display: grid;
    grid-template-columns: repeat(var(--cells), 1fr);
  }
  .sb-row.one {
    --cells: 1;
  }
  .sb-row.two {
    --cells: 2;
  }
  .sb-row.three {
    --cells: 3;
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
  .sb-validation .vstatus {
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  /* The armed Fail button: still an outline, tinted while its comment box
     is open. */
  .sb-validation .vfail.on {
    background: var(--danger-bg);
  }
  .sb-validation .vrow {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  /* The green thumbs-up hand marks a passed verdict. */
  .sb-validation .hand-pass {
    height: 14px;
    flex: none;
  }
  .sb-validation .vrow.pass {
    color: var(--ok);
  }
  .sb-validation .vrow.fail {
    color: var(--danger);
  }
  .sendbackbtn {
    align-self: stretch;
  }
  .failnote {
    align-self: stretch;
    border: 1px solid var(--danger-line);
    border-radius: 8px;
    background: var(--danger-wash);
    padding: 8px 10px;
  }
  .failnote.resolved {
    opacity: 0.55;
  }
  .failwho {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--danger);
  }
  .failtext {
    font-size: 12.5px;
    color: var(--ink);
    margin-top: 4px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .sb-validation .fail-note {
    font: inherit;
    font-size: 12.5px;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 10px;
    border: 1px solid var(--danger-line);
    border-radius: 999px;
    background: var(--card);
    color: var(--ink);
  }
  /* The hints and colour legend, pinned to the sidebar's bottom. */
  .sb-foot {
    margin-top: auto;
    border-top: 1px solid var(--line);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .sb-foot p {
    margin: 0;
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
  .desk {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 16px 24px;
    box-sizing: border-box;
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

  /* The per-zone controls: a floating pill inside the active box (number input ·
     ↵ · § · ✕), in the box's upper third. The outer layer is a zero-size
     anchor (zcTop keeps it inside the box); the pill hangs below it, centred,
     and re-enables the pointer. */
  .zc {
    position: absolute;
    pointer-events: none;
    transform: translate(-50%, 0);
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

  .lockpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
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
  .lockpill.red {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
  .legend-mdiv {
    color: var(--pre);
    font-weight: 600;
  }
</style>
