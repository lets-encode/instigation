<script lang="ts">
  import { page } from "$app/state";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result, FacsimileTaskData } from "$lib/commands.ts";
  import { readingOrderRows, nextLabel } from "$lib/mei-facsimile.ts";
  import type { PageModel, MeasureBox } from "$lib/mei-facsimile.ts";

  // Guaranteed present by the [owner]/[repo]/zones/[task] route.
  const owner = $derived(page.params.owner!);
  const repo = $derived(page.params.repo!);
  const taskId = $derived(page.params.task!);
  const viewer = $derived(auth.user?.login ?? "");

  // Editor-side zone: the box, the label override (null = automatic), the
  // computed label, and the system flag (breaks mode).
  type EditZone = {
    box: MeasureBox;
    override: string | null;
    label: string;
    sb: boolean;
  };
  type EditPage = {
    image: string;
    width: number;
    height: number;
    url: string;
    zones: EditZone[];
  };

  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let data = $state<FacsimileTaskData | null>(null);
  let pages = $state<EditPage[]>([]);
  let selected = $state<{ p: number; z: number } | null>(null);

  let busy = $state(false);
  let busyMessage = $state("");
  let result = $state<Result | null>(null);

  // 'zones' (correct measure boxes) or 'breaks' (mark system starts), from the
  // task's locator.
  const mode = $derived(data?.locator === "breaks" ? "breaks" : "zones");
  const canEdit = $derived(
    Boolean(data?.holdsLock) && data?.status === "encoding_required",
  );

  const ctx = (f: ForgeClient): CommandContext => ({
    forge: f,
    owner,
    repo,
    viewer,
    progress: (m) => (busyMessage = m),
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
    try {
      data = await invoke(commands.readFacsimile, { task_id: taskId }, ctx(f));
      pages = data.model.pages.map((pg, i) => ({
        image: pg.image,
        width: pg.width,
        height: pg.height,
        url: data!.imageUrls[i],
        zones: pg.zones.map((z) => ({
          box: { ...z.box },
          override: null,
          label: z.label,
          sb: z.sb,
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
    } catch (e) {
      loadError = `Could not load ${taskId}: ${(e as Error).message}`;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (auth.status === "authenticated" && owner && repo && taskId && !data && !loading) load();
  });

  async function run(command: (c: CommandContext) => Promise<Result>) {
    const f = forge();
    if (!f) return;
    busy = true;
    busyMessage = "Working…";
    try {
      result = await command(ctx(f));
      busyMessage = "Reloading…";
      data = null;
      await load();
    } finally {
      busy = false;
      busyMessage = "";
    }
  }

  const claim = () =>
    run((c) => invoke(commands.claimTask, { task_id: taskId }, c));

  function toPageModels(): PageModel[] {
    return pages.map((pg) => ({
      image: pg.image,
      width: pg.width,
      height: pg.height,
      zones: pg.zones.map((z) => ({ box: { ...z.box }, label: z.label, sb: z.sb })),
    }));
  }

  const submit = () =>
    run((c) =>
      invoke(
        mode === "breaks" ? commands.submitBreaks : commands.submitZones,
        { task_id: taskId, pages: toPageModels() },
        c,
      ),
    );

  // ------------------------------------------------------------------------
  // Pointer interactions (zones mode)

  let svgEls: SVGSVGElement[] = [];
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
    if (mode === "breaks") {
      // Toggle the system flag; a page's first measure is covered by its <pb/>.
      if (canEdit && z > 0) {
        pages[p].zones[z].sb = !pages[p].zones[z].sb;
      }
      return;
    }
    selected = { p, z };
    if (!canEdit) return;
    e.stopPropagation();
    const { x, y } = svgXY(e, p);
    drag = { kind: "move", p, z, sx: x, sy: y, orig: { ...pages[p].zones[z].box }, moved: false };
  }

  function handlePointerDown(e: PointerEvent, p: number, z: number) {
    if (mode === "breaks" || !canEdit) return;
    e.stopPropagation();
    selected = { p, z };
    const { x, y } = svgXY(e, p);
    drag = { kind: "resize", p, z, sx: x, sy: y, orig: { ...pages[p].zones[z].box }, moved: false };
  }

  function backgroundPointerDown(e: PointerEvent, p: number) {
    selected = null;
    if (mode === "breaks" || !canEdit) return;
    const { x, y } = svgXY(e, p);
    pages[p].zones.push({
      box: { ulx: x, uly: y, lrx: x, lry: y },
      override: null,
      label: "",
      sb: false,
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
    if (kind === "move" && !moved) return; // plain select
    resort(p);
    // Keep the selection on the same zone object after the re-sort.
    selected = null;
  }

  function deleteSelected() {
    if (!selected || mode === "breaks" || !canEdit) return;
    pages[selected.p].zones.splice(selected.z, 1);
    resort(selected.p);
    selected = null;
  }

  function keydown(e: KeyboardEvent) {
    if ((e.key === "Delete" || e.key === "Backspace") && selected && (e.target as HTMLElement).tagName !== "INPUT") {
      e.preventDefault();
      deleteSelected();
    }
  }

  function setOverride(value: string) {
    if (!selected) return;
    pages[selected.p].zones[selected.z].override = value.trim() === "" ? null : value.trim();
    renumber();
  }

  // Which system (0-based) each of a page's measures belongs to, for the
  // alternating tint in breaks mode.
  function systemIndices(pg: EditPage): number[] {
    let s = -1;
    return pg.zones.map((z, i) => {
      if (i === 0 || z.sb) s++;
      return s;
    });
  }

  const measureCount = $derived(pages.reduce((n, p) => n + p.zones.length, 0));
</script>

<svelte:window onpointermove={pointerMove} onpointerup={pointerUp} onkeydown={keydown} />

{#if busy}
  <div class="overlay" role="status" aria-live="polite">
    <div class="overlay-card">
      <div class="spinner" aria-hidden="true"></div>
      <p class="overlay-title">{busyMessage || "Working…"}</p>
      <p class="overlay-sub">
        The campaign automation runs on GitHub — this can take a few seconds.
      </p>
    </div>
  </div>
{/if}

<p class="back"><a href={`/campaign/${owner}/${repo}`}>← Campaign console</a></p>

<header>
  <h1>{mode === "breaks" ? "Page & system breaks" : "Measure correction"} — <code>{taskId}</code></h1>
  <p class="repo">
    <a href={`https://github.com/${owner}/${repo}`} target="_blank" rel="noreferrer">{owner}/{repo}</a>
  </p>
  {#if mode === "breaks"}
    <p class="muted">
      Click a measure to mark it as the start of a system. Page breaks are set
      automatically at each page's first measure. Submit when the systems match
      the facsimile.
    </p>
  {:else}
    <p class="muted">
      Drag a box to move it, drag its corner handle to resize, drag on the page
      to add a measure, select a box and press Delete to remove it. Numbers
      follow reading order; type a label (e.g. 10a) on a selected measure to
      override.
    </p>
  {/if}
</header>

{#if auth.status === "loading"}
  <p class="muted">Loading…</p>
{:else if !auth.user}
  <div class="banner warn">
    Please <button type="button" class="linkish" onclick={() => login()}>log in with GitHub</button>
    to work on this task.
  </div>
{:else}
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

  {#if loading}
    <p class="muted">Loading the facsimile…</p>
  {:else if loadError}
    <div class="banner err">{loadError}</div>
  {:else if data}
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

    <div class="toolbar">
      <span class="muted">{measureCount} measure{measureCount === 1 ? "" : "s"}</span>
      {#if selected && mode === "zones"}
        <label class="labeledit">
          Measure label
          <input
            value={pages[selected.p].zones[selected.z].override ?? pages[selected.p].zones[selected.z].label}
            oninput={(e) => setOverride((e.target as HTMLInputElement).value)}
            disabled={!canEdit}
            title="Override the automatic number, e.g. 10a — numbering continues after it"
          />
        </label>
        <button type="button" onclick={() => deleteSelected()} disabled={!canEdit} title="Remove the selected measure (Delete)">
          Delete measure
        </button>
      {/if}
      <button
        type="button"
        class="primary"
        onclick={() => submit()}
        disabled={busy || !canEdit}
        title={mode === "breaks"
          ? "Submit the page/system breaks — the task completes when the automation accepts them"
          : "Submit the corrected measures for validation"}
      >
        {mode === "breaks" ? "Submit breaks" : "Submit corrections"}
      </button>
    </div>

    {#each pages as pg, p (pg.image)}
      <div class="page">
        <p class="pagehead">
          Page {p + 1}
          {#if mode === "breaks"}<span class="pb-badge" title="A page break is written before this page's first measure">pb</span>{/if}
        </p>
        <svg
          bind:this={svgEls[p]}
          viewBox={`0 0 ${pg.width} ${pg.height}`}
          role="application"
          aria-label={`Page ${p + 1} measures`}
          onpointerdown={(e) => backgroundPointerDown(e, p)}
        >
          <image href={pg.url} width={pg.width} height={pg.height} />
          {#if mode === "breaks"}
            {@const systems = systemIndices(pg)}
            {#each pg.zones as zone, z}
              <rect
                class="zone sys{systems[z] % 2}"
                class:sysstart={z === 0 || zone.sb}
                role="button"
                tabindex={0}
                aria-label={`Measure ${zone.label}: toggle system start`}
                x={zone.box.ulx}
                y={zone.box.uly}
                width={zone.box.lrx - zone.box.ulx}
                height={zone.box.lry - zone.box.uly}
                onpointerdown={(e) => zonePointerDown(e, p, z)}
              />
              <text class="zonelabel" x={zone.box.ulx + 6} y={zone.box.uly + 26}>
                {(z === 0 ? "⤓ " : zone.sb ? "↵ " : "") + zone.label}
              </text>
            {/each}
          {:else}
            {#each pg.zones as zone, z}
              <rect
                class="zone"
                class:selected={selected?.p === p && selected?.z === z}
                role="button"
                tabindex={0}
                aria-label={`Measure ${zone.label}: select or drag`}
                x={zone.box.ulx}
                y={zone.box.uly}
                width={zone.box.lrx - zone.box.ulx}
                height={zone.box.lry - zone.box.uly}
                onpointerdown={(e) => zonePointerDown(e, p, z)}
              />
              <text class="zonelabel" x={zone.box.ulx + 6} y={zone.box.uly + 26}>{zone.label}</text>
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
                />
              {/if}
            {/each}
          {/if}
        </svg>
      </div>
    {/each}
  {/if}
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.75);
    backdrop-filter: blur(2px);
  }
  .overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.8rem;
    padding: 2rem 2.5rem;
    background: #fff;
    border: 1px solid #e5e5e5;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
    text-align: center;
  }
  .spinner {
    width: 38px;
    height: 38px;
    border: 3px solid #e5e5e5;
    border-top-color: #1a1a1a;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .overlay-title {
    margin: 0;
    font-weight: 600;
  }
  .overlay-sub {
    margin: 0;
    color: #777;
    font-size: 0.88rem;
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
  }

  .back {
    margin: 0 0 1rem;
  }
  .back a {
    color: #555;
    text-decoration: none;
  }
  header h1 {
    margin-bottom: 0.2rem;
  }
  .repo {
    margin: 0 0 0.6rem;
    font-weight: 600;
  }
  .repo a {
    color: #1a1a1a;
  }
  .muted {
    color: #777;
    font-size: 0.9rem;
  }
  .linkish {
    font: inherit;
    color: #3056d3;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  .toolbar {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    margin: 1.2rem 0;
    flex-wrap: wrap;
  }
  .labeledit {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
  }
  .labeledit input {
    font: inherit;
    width: 5rem;
    padding: 0.25rem 0.4rem;
    border: 1px solid #ccc;
    border-radius: 6px;
  }
  button {
    font: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.primary {
    background: #1a1a1a;
    color: #fff;
    border-color: #1a1a1a;
    margin-left: auto;
  }
  .banner {
    padding: 0.7rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
  }
  .banner.ok {
    background: #e8f7ec;
    border: 1px solid #b6e2c1;
  }
  .banner.err {
    background: #fdeaea;
    border: 1px solid #f3c0c0;
  }
  .banner.warn {
    background: #fff8e1;
    border: 1px solid #f0dca0;
  }

  .page {
    margin-bottom: 1.5rem;
  }
  .pagehead {
    margin: 0 0 0.3rem;
    font-weight: 600;
    font-size: 0.9rem;
  }
  .pb-badge {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0 0.4rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    background: #e8f1fd;
    border: 1px solid #bcd4f3;
    border-radius: 999px;
  }
  svg {
    display: block;
    width: 100%;
    height: auto;
    border: 1px solid #e5e5e5;
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
  .zone.selected {
    fill: rgba(48, 86, 211, 0.28);
    stroke-width: 3;
  }
  .zone.sys0 {
    fill: rgba(48, 86, 211, 0.12);
    stroke: rgba(48, 86, 211, 0.85);
  }
  .zone.sys1 {
    fill: rgba(20, 150, 80, 0.12);
    stroke: rgba(20, 150, 80, 0.85);
  }
  .zone.sysstart {
    stroke-width: 4;
  }
  .zonelabel {
    font-family: ui-monospace, monospace;
    font-size: 20px;
    fill: #1a1a1a;
    paint-order: stroke;
    stroke: #fff;
    stroke-width: 4;
    pointer-events: none;
  }
  .handle {
    fill: #fff;
    stroke: rgba(48, 86, 211, 0.85);
    stroke-width: 2;
    cursor: nwse-resize;
  }
</style>
