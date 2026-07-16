<script lang="ts">
  import { page } from "$app/state";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { TaskRow, StateRow, LockRow, HistoryRow } from "$lib/campaign-tables.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";
  import { buildGraph, buildPanel, statusLabel } from "$lib/campaign-graph.ts";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import type { MeasureBox } from "$lib/mei-facsimile.ts";
  import { buildSpreads } from "$lib/page-spreads.ts";
  import type { Selection, PanelAction } from "$lib/campaign-graph.ts";

  // Guaranteed present by the [owner]/[repo] route.
  const owner = $derived(page.params.owner!);
  const repo = $derived(page.params.repo!);
  const viewer = $derived(auth.user?.login ?? "");

  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notInitialised = $state(false);
  let isPrivate = $state(false);
  let taskDefs = $state<TaskRow[]>([]);
  let rows = $state<StateRow[]>([]);
  let validationColumns = $state<string[]>([]);
  let locks = $state<LockRow[]>([]);
  let history = $state<HistoryRow[]>([]);
  let title = $state("");
  let passThreshold = $state(1);

  // Rows with an empty subtask_id address the whole task (the encoding unit);
  // the others are its validation subtasks.
  const taskRows = $derived(rows.filter((r) => r.subtask_id === ""));

  let busy = $state(false);
  let busyMessage = $state("");
  let result = $state<Result | null>(null);

  // UI-only state: everything else derives from the tracking tables.
  let view = $state<"graph" | "tables">("graph");
  let selected = $state<Selection | null>(null);
  let expert = $state(false);

  /** One facsimile page in the preview: image plus its measure zones. */
  type PreviewPage = {
    url: string;
    w: number;
    h: number;
    zones: { box: MeasureBox; label: string }[];
  };
  let preview = $state<{
    taskId: string;
    loading: boolean;
    error?: string;
    /** The facsimile pages, when the score references any. */
    facs?: PreviewPage[];
    /** Verovio page count; 0 = nothing to render yet. */
    pageCount: number;
    /** Rendered encoding pages, filled lazily per spread (1-based). */
    svgs: Record<number, string>;
  } | null>(null);

  const graphData = $derived({ taskDefs, rows, validationColumns, locks, passThreshold });
  const graph = $derived(buildGraph(graphData, viewer));
  const panel = $derived(
    buildPanel(
      graphData,
      history,
      selected,
      viewer,
      selected != null && preview?.taskId === selected.task,
    ),
  );
  const tasksDone = $derived(taskRows.filter((r) => r.status === "completed").length);

  // Preview display state: book-style paging shared by both panes, per-pane
  // zoom, and the zone overlay toggle.
  let pvView = $state<"single" | "double">("single");
  let pvFirstOnRight = $state(true);
  let pvFirstVisible = $state(0);
  let facsZoom = $state(1);
  let encZoom = $state(1);
  let showZones = $state(true);

  const pvPageTotal = $derived(
    preview ? Math.max(preview.facs?.length ?? 0, preview.pageCount) : 0,
  );
  const pvSpreads = $derived(buildSpreads(pvPageTotal, pvView, pvFirstOnRight));
  const pvSpreadIndex = $derived(
    Math.max(0, pvSpreads.findIndex((sp) => sp.pages.includes(pvFirstVisible))),
  );
  const pvSpread = $derived(pvSpreads[pvSpreadIndex] ?? { pages: [] });
  const pvSpreadLabel = $derived(
    pvSpread.pages.length === 2
      ? `Pages ${pvSpread.pages[0] + 1}–${pvSpread.pages[1] + 1} of ${pvPageTotal}`
      : `Page ${(pvSpread.pages[0] ?? 0) + 1} of ${pvPageTotal}`,
  );

  // Render the encoding pages the current spread needs (kept for later visits).
  function renderSpread() {
    if (!preview || preview.loading || !verovio || preview.pageCount === 0) return;
    let changed = false;
    const svgs = { ...preview.svgs };
    for (const p of pvSpread.pages) {
      const n = p + 1;
      if (n <= preview.pageCount && !svgs[n]) {
        svgs[n] = verovio.renderToSVG(n);
        changed = true;
      }
    }
    if (changed) preview = { ...preview, svgs };
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

  // Drag-resize state: the preview dock's share of the stage height and the
  // detail panel's width.
  let dockFrac = $state(0.55);
  let panelW = $state(360);
  let resizing = $state<"dock" | "panel" | null>(null);
  let stageEl = $state<HTMLDivElement | null>(null);
  function resizeMove(e: PointerEvent) {
    if (resizing === "dock" && stageEl) {
      const r = stageEl.getBoundingClientRect();
      dockFrac = Math.min(0.85, Math.max(0.2, (r.bottom - e.clientY) / r.height));
    } else if (resizing === "panel") {
      panelW = Math.min(680, Math.max(280, window.innerWidth - e.clientX));
    }
  }

  // Verovio is a ~2 MB WASM module — loaded on first preview, then reused.
  let verovio: import("verovio/esm").VerovioToolkit | null = null;
  async function getVerovio() {
    if (!verovio) {
      const [{ default: createVerovioModule }, { VerovioToolkit }] =
        await Promise.all([import("verovio/wasm"), import("verovio/esm")]);
      verovio = new VerovioToolkit(await createVerovioModule());
      verovio.setOptions({
        pageWidth: 2100,
        pageHeight: 2970,
        adjustPageHeight: true,
        scale: 40,
        footer: "none",
        svgViewBox: true,
        // Render every movement — without this only the first <mdiv> paginates.
        mdivAll: true,
      });
    }
    return verovio;
  }

  // Preview both sides of the score: the facsimile pages (when the score
  // references any) and the rendered encoding (when it holds measures).
  async function togglePreview(task_id: string) {
    if (preview?.taskId === task_id) {
      preview = null;
      return;
    }
    const f = forge();
    if (!f) return;
    preview = { taskId: task_id, loading: true, pageCount: 0, svgs: {} };
    pvFirstVisible = 0;
    try {
      const fragment = fragmentOf(task_id);
      if (!fragment) throw new Error(`Unknown task ${task_id}.`);
      const mei = await f.getRepoFile(owner, repo, fragment);
      if (mei == null) throw new Error(`Could not read ${fragment}.`);
      const parsed = parseFacsimileMei(mei);

      let facs: PreviewPage[] | undefined;
      if (parsed.pages.length) {
        // graphic @target is resolved relative to the score file (MEI spec).
        const dir = fragment.replace(/[^/]*$/, "");
        const urls = await Promise.all(
          parsed.pages.map((pg) =>
            f.getRepoFileDownloadUrl(owner, repo, dir + pg.image).then((u) => u ?? ""),
          ),
        );
        facs = parsed.pages.map((pg, i) => ({
          url: urls[i],
          w: pg.width,
          h: pg.height,
          zones: pg.zones.map((z) => ({ box: z.box, label: z.label })),
        }));
      }

      // A score without facsimile pages is rendered as-is; a facsimile score
      // only once its measures exist (stage A has nothing to render). With
      // encoded breaks Verovio paginates on the <pb/> elements, so encoding
      // pages line up with the facsimile pages.
      let pageCount = 0;
      if (!parsed.pages.length || parsed.hasMeasures) {
        const tk = await getVerovio();
        tk.setOptions({ breaks: parsed.hasBreaks ? "encoded" : "auto" });
        if (!tk.loadData(mei))
          throw new Error(`Verovio could not parse ${fragment}.`);
        pageCount = tk.getPageCount();
      }

      if (preview?.taskId === task_id) {
        preview = { taskId: task_id, loading: false, facs, pageCount, svgs: {} };
        renderSpread();
      }
    } catch (e) {
      if (preview?.taskId === task_id)
        preview = {
          taskId: task_id,
          loading: false,
          error: `Preview failed: ${(e as Error).message}`,
          pageCount: 0,
          svgs: {},
        };
    }
  }

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});

  const fragmentOf = (taskId: string) =>
    findRow(taskDefs, taskId, "")?.fragment;

  // The context every command runs against; progress messages feed the busy overlay.
  const ctx = (f: ForgeClient): CommandContext => ({
    forge: f,
    owner,
    repo,
    viewer,
    progress: (m) => (busyMessage = m),
  });

  // Read the tracking tables (and privacy/config) for the console. Only the
  // first read shows the loading state; refreshes update the tables in place.
  async function load() {
    const f = forge();
    if (!f) return;
    if (!loaded) loading = true;
    loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, ctx(f));
      notInitialised = tables.notInitialised;
      isPrivate = tables.isPrivate;
      taskDefs = tables.taskDefs;
      rows = tables.rows;
      validationColumns = tables.validationColumns;
      locks = tables.locks;
      history = tables.history;
      title = tables.title;
      passThreshold = tables.passThreshold;
      if (!notInitialised) {
        console.log(
          "[load] tables loaded:",
          taskDefs.length, "task(s),",
          rows.length, "state row(s),",
          locks.length, "lock(s)",
        );
      }
      loaded = true;
    } catch (e) {
      loadError = `Could not read ${owner}/${repo}: ${(e as Error).message}`;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (auth.status === "authenticated" && owner && repo && !loaded) load();
  });

  // Pages the measure detector couldn't process during campaign creation, handed
  // over via sessionStorage by the create flow. Read once and clear, so the
  // notice shows on arrival but not on a later reload.
  let skippedPages = $state<string[]>([]);
  $effect(() => {
    const key = `facsimile-skipped:${owner}/${repo}`;
    const raw = sessionStorage.getItem(key);
    if (raw) {
      sessionStorage.removeItem(key);
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) skippedPages = parsed;
      } catch {
        // Malformed hand-off: nothing to show.
      }
    }
  });

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(command: (c: CommandContext) => Promise<Result>) {
    const f = forge();
    if (!f) return;
    busy = true;
    busyMessage = "Working…";
    try {
      result = await command(ctx(f));
      busyMessage = "Refreshing tables…";
      await load();
    } finally {
      busy = false;
      busyMessage = "";
    }
  }

  const claim = (task_id: string, subtask_id: string) =>
    run((c) => invoke(commands.claimValidation, { task_id, subtask_id }, c));

  // Open the task's score in mei-friend (claiming it if needed). The tab opens
  // only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  const editor = async (task_id: string) => {
    await run((c) => invoke(commands.openEditor, { task_id }, c));
    if (result?.ok && !result.warn && result.meiFriendUrl) {
      window.open(result.meiFriendUrl, "_blank", "noopener");
    }
  };

  const submitpr = (task_id: string) =>
    run((c) => invoke(commands.submitEncoding, { task_id }, c));

  const validate = (task_id: string, subtask_id: string, verdict: string) =>
    run((c) => invoke(commands.submitValidation, { task_id, subtask_id, verdict }, c));

  // The tokenised raw URL of the score — copied to the clipboard.
  const rawlink = async (task_id: string) => {
    await run((c) => invoke(commands.rawLink, { task_id }, c));
    if (result?.rawUrl) copy(result.rawUrl);
  };

  const reaper = () => run((c) => invoke(commands.runReaper, {}, c));

  const select = (task: string, sub: string, slot: number | null) => {
    selected = { task, sub, slot };
  };

  // The panel's buttons map to the same command wrappers the tables used.
  function panelAction(a: PanelAction) {
    if (!selected) return;
    const { task, sub } = selected;
    if (a.id === "open-editor") editor(task);
    else if (a.id === "submit-encoding") submitpr(task);
    else if (a.id === "claim-validation") claim(task, sub);
    else if (a.id === "validate-pass") validate(task, sub, "pass");
    else if (a.id === "validate-fail") validate(task, sub, "fail");
    else if (a.id === "toggle-preview") togglePreview(task);
    else if (a.id === "raw-link") rawlink(task);
  }

  const edgeMarker = (kind: string) =>
    kind === "green" ? "url(#ag)" : kind === "grey" ? "url(#ar)" : "url(#ax)";

  // History rows for the tables tab, newest first (the file is append-only).
  const historyNewestFirst = $derived(history.slice().reverse());
  const joinedValidations = (row: StateRow) =>
    validationColumns.map((c) => row[c] || "·").join("  ");
</script>

<svelte:window
  onpointermove={(e) => resizing && resizeMove(e)}
  onpointerup={() => (resizing = null)}
/>

{#snippet lockIcon()}
  <svg
    class="icon-lock"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect>
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>
  </svg>
{/snippet}

{#snippet reviewIcon()}
  <svg
    class="icon-review"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.6"
    stroke-linecap="round"
    aria-hidden="true"
  >
    <circle cx="10.5" cy="10.5" r="6"></circle>
    <path d="m15.2 15.2 5.3 5.3"></path>
  </svg>
{/snippet}

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

<div class="console">
  <div class="conhead">
    <a class="back" href="/" title="All campaigns">←</a>
    <div class="titles">
      <div class="title">{title || repo}</div>
      <a
        class="handle mono"
        href={`https://github.com/${owner}/${repo}`}
        target="_blank"
        rel="noreferrer">{owner}/{repo}</a
      >
    </div>
    {#if loaded && !notInitialised}
      <div class="progress" title="Completed tasks">
        <div class="bar"><div style={`width:${taskRows.length ? Math.round((tasksDone / taskRows.length) * 100) : 0}%`}></div></div>
        <span>{tasksDone} / {taskRows.length} tasks complete</span>
      </div>
    {/if}
    <div class="spacer"></div>
    <button
      type="button"
      class="hbtn"
      onclick={() => load()}
      disabled={busy || loading}
      title="Re-read the tracking tables">↻ Refresh</button
    >
    <button
      type="button"
      class="hbtn"
      onclick={() => reaper()}
      disabled={busy}
      title="Release claims that have gone stale">Run reaper</button
    >
    <div class="tabs">
      <button
        type="button"
        class:on={view === "graph"}
        onclick={() => (view = "graph")}>Graph</button
      >
      <button
        type="button"
        class:on={view === "tables"}
        onclick={() => (view = "tables")}>Tables</button
      >
    </div>
  </div>

  {#if auth.status === "loading"}
    <p class="msg muted">Loading…</p>
  {:else if !auth.user}
    <div class="banner warn">
      <span>
        Please <button type="button" class="linkish" onclick={() => login()}
          >log in with GitHub</button
        >
        to drive this campaign.
      </span>
    </div>
  {:else}
    {#if skippedPages.length}
      <div class="banner warn">
        <span>
          The measure detector couldn't process {skippedPages.length} page(s) ({skippedPages.join(", ")})
          during creation, so they were left out of the score. Everything else is ready below.
        </span>
      </div>
    {/if}
    {#if result && result.error}
      <div class="banner err">
        <span>
          {result.error}
          {#if result.prUrl}
            <a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
          {/if}
        </span>
        <button type="button" class="dismiss" onclick={() => (result = null)}
          >Dismiss</button
        >
      </div>
    {:else if result && result.ok}
      <div class="banner {result.warn ? 'warn' : 'ok'}">
        <div class="banner-body">
          {result.message}
          {#if result.prUrl}
            <a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
          {/if}
          {#if result.meiFriendUrl}
            <div class="rawlink">
              <input
                readonly
                value={result.meiFriendUrl}
                onfocus={(e) => (e.target as HTMLInputElement).select()}
              />
              <button type="button" onclick={() => copy(result!.meiFriendUrl!)}
                >Copy</button
              >
            </div>
            <span class="muted">
              <a href={result.meiFriendUrl} target="_blank" rel="noreferrer"
                >Open in mei-friend ↗</a
              >
              (if the tab didn't open automatically)
            </span>
          {/if}
          {#if result.rawUrl}
            <div class="rawlink">
              <input
                readonly
                value={result.rawUrl}
                onfocus={(e) => (e.target as HTMLInputElement).select()}
              />
              <button type="button" onclick={() => copy(result!.rawUrl!)}
                >Copy</button
              >
            </div>
            {#if isPrivate}
              <span class="muted"
                >The token in this link expires within minutes — use it promptly.</span
              >
            {/if}
          {/if}
        </div>
        <button type="button" class="dismiss" onclick={() => (result = null)}
          >Dismiss</button
        >
      </div>
    {/if}

    {#if loading}
      <p class="msg muted">Loading campaign…</p>
    {:else if loadError}
      <div class="banner err"><span>{loadError}</span></div>
    {:else if notInitialised}
      <div class="banner warn">
        <span>
          This repository has no tracking tables (<code>tracking/task.csv</code>,
          <code>tracking/state.csv</code>, <code>tracking/lock.csv</code>) yet — it
          may not have been initialised. Create it through the home page to
          initialise it.
        </span>
      </div>
    {:else if view === "graph"}
      <div class="body">
        <div class="stage" bind:this={stageEl}>
          <div class="canvas-wrap">
          <div class="scroller">
            <div
              class="canvas"
              style={`width:${graph.W}px;height:${graph.H}px`}
            >
              <svg
                width={graph.W}
                height={graph.H}
                class="edges"
                aria-hidden="true"
              >
                <defs>
                  <marker id="ar" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#a9a9a9"></path></marker>
                  <marker id="ag" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#7fbf8a"></path></marker>
                  <marker id="ax" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#cfcfcf"></path></marker>
                </defs>
                {#each graph.edges as e}
                  <path
                    d={e.d}
                    class="edge {e.kind}"
                    marker-end={edgeMarker(e.kind)}
                  ></path>
                {/each}
              </svg>

              {#each graph.nodes as n (n.key)}
                <div
                  class="node s-{n.statusKey}"
                  class:selected={selected?.task === n.task}
                  class:mainsel={selected?.task === n.task && selected?.sub === ""}
                  class:nextup={n.nextUp}
                  style={`left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px`}
                >
                  {#if n.hasIn}
                    <span class="port in"></span>
                  {/if}
                  {#if n.hasOut}
                    <span class="port out" class:green={n.outGreen}></span>
                  {/if}
                  {#if n.nextUp}
                    <span class="nextup-badge">your next step</span>
                  {/if}
                  <button
                    type="button"
                    class="nmain"
                    onclick={() => select(n.task, "", null)}
                  >
                    <span class="nhead">
                      <span class="nicon {n.kind}">{n.icon}</span>
                      <span class="ntitles">
                        <span class="ntitle">{n.title}</span>
                        <span class="nsub mono">{n.subtitle}</span>
                      </span>
                    </span>
                    <span class="nmeta">
                      <span class="pill s-{n.statusKey}">{statusLabel(n.statusKey)}</span>
                      {#if n.running}{@render lockIcon()}{/if}
                      <span class="mono nmeta-text">{n.meta}</span>
                    </span>
                  </button>
                  {#if n.slots.length}
                    <span class="nslots-head">
                      <span>Validation — required</span>
                      <span>{n.passes} / {n.threshold} passes</span>
                    </span>
                    {#each n.slots as s (s.sub + s.slot)}
                      <button
                        type="button"
                        class="nslot"
                        class:claimable={s.claimable}
                        class:selected={selected?.task === n.task &&
                          selected?.sub === s.sub &&
                          selected?.slot === s.slot}
                        title="Open this validation slot in the panel"
                        onclick={() => select(n.task, s.sub, s.slot)}
                      >
                        {#if s.key === "review"}
                          <span class="mark review">{@render reviewIcon()}</span>
                        {:else if s.key === "pass"}
                          <span class="mark pass">✓</span>
                        {:else if s.key === "fail"}
                          <span class="mark fail">✗</span>
                        {:else}
                          <span class="mark open"></span>
                        {/if}
                        <span class="mono nslot-id">{s.label}</span>
                        <span class="nslot-who">{s.who}</span>
                        <span class="nslot-arrow" aria-hidden="true">›</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              {/each}
            </div>
          </div>
          </div>

          {#if preview}
            <section
              class="dock"
              aria-label="Score preview"
              style={`flex-basis:${Math.round(dockFrac * 1000) / 10}%`}
            >
              <button
                type="button"
                class="dock-resizer"
                aria-label="Drag to resize the preview"
                title="Drag to resize the preview"
                onpointerdown={(e) => {
                  e.preventDefault();
                  resizing = "dock";
                }}
              ></button>
              <div class="dock-head">
                <span class="dock-title"
                  >Score preview · <span class="mono">{preview.taskId}</span></span
                >
                {#if pvPageTotal > 1}
                  <span class="dock-nav">
                    <button
                      type="button"
                      onclick={() => pvGo(-1)}
                      disabled={pvSpreadIndex <= 0}
                      aria-label="Previous page">‹</button
                    >
                    <span class="dock-nav-label">{pvSpreadLabel}</span>
                    <button
                      type="button"
                      onclick={() => pvGo(1)}
                      disabled={pvSpreadIndex >= pvSpreads.length - 1}
                      aria-label="Next page">›</button
                    >
                  </span>
                  <span class="dock-viewmode">
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
                  </span>
                  {#if pvView === "double"}
                    <label
                      class="dock-check"
                      title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens"
                    >
                      <input
                        type="checkbox"
                        checked={pvFirstOnRight}
                        onchange={(e) =>
                          pvSetFirstOnRight((e.target as HTMLInputElement).checked)}
                      />
                      Page 1 on the right
                    </label>
                  {/if}
                {/if}
                <span class="spacer"></span>
                <button
                  type="button"
                  class="pclose"
                  onclick={() => (preview = null)}
                  title="Close the preview"
                  aria-label="Close the preview">✕</button
                >
              </div>
              <div class="dock-body">
                {#if preview.loading}
                  <p class="muted dock-note">Loading the score…</p>
                {:else if preview.error}
                  <p class="dock-err">{preview.error}</p>
                {:else}
                  {#if preview.facs?.length}
                    <div class="dock-pane">
                      <div class="dock-label">
                        <span>Facsimile</span>
                        <span class="dock-tools">
                          <button
                            type="button"
                            class="dock-toggle"
                            class:on={showZones}
                            onclick={() => (showZones = !showZones)}
                            title="Show or hide the measure zones on the facsimile"
                            >Zones {showZones ? "on" : "off"}</button
                          >
                          <label class="zoomctl">
                            <input
                              type="range"
                              min="50"
                              max="400"
                              step="25"
                              value={facsZoom * 100}
                              oninput={(e) =>
                                (facsZoom =
                                  Number((e.target as HTMLInputElement).value) / 100)}
                              aria-label="Facsimile zoom"
                            />
                            <span class="mono">{Math.round(facsZoom * 100)}%</span>
                          </label>
                        </span>
                      </div>
                      <div class="pv-scroll">
                        <div class="pv-spread" style={`width:${facsZoom * 100}%`}>
                          {#if pvSpread.lonelySide === "right"}<div class="pv-spacer"></div>{/if}
                          {#each pvSpread.pages as p (p)}
                            {@const pg = preview.facs[p]}
                            <figure class="pv-page">
                              {#if pg}
                                <svg viewBox={`0 0 ${pg.w} ${pg.h}`} role="img" aria-label={`Facsimile page ${p + 1}`}>
                                  {#if pg.url}
                                    <image href={pg.url} width={pg.w} height={pg.h} />
                                  {:else}
                                    <rect width={pg.w} height={pg.h} fill="#f3f3f0" />
                                  {/if}
                                  {#if showZones}
                                    {#each pg.zones as z, zi (zi)}
                                      <rect
                                        class="pv-zone"
                                        x={z.box.ulx}
                                        y={z.box.uly}
                                        width={z.box.lrx - z.box.ulx}
                                        height={z.box.lry - z.box.uly}
                                      />
                                      <text
                                        class="pv-zonelabel"
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
                    </div>
                  {/if}
                  {#if preview.pageCount > 0}
                    <div class="dock-pane">
                      <div class="dock-label">
                        <span>Encoding</span>
                        <span class="dock-tools">
                          <label class="zoomctl">
                            <input
                              type="range"
                              min="50"
                              max="400"
                              step="25"
                              value={encZoom * 100}
                              oninput={(e) =>
                                (encZoom =
                                  Number((e.target as HTMLInputElement).value) / 100)}
                              aria-label="Encoding zoom"
                            />
                            <span class="mono">{Math.round(encZoom * 100)}%</span>
                          </label>
                        </span>
                      </div>
                      <div class="pv-scroll">
                        <div class="pv-spread" style={`width:${encZoom * 100}%`}>
                          {#if pvSpread.lonelySide === "right"}<div class="pv-spacer"></div>{/if}
                          {#each pvSpread.pages as p (p)}
                            <div class="pv-page enc">
                              {#if p < preview.pageCount}
                                {@html preview.svgs[p + 1] ?? ""}
                              {/if}
                            </div>
                          {/each}
                          {#if pvSpread.lonelySide === "left"}<div class="pv-spacer"></div>{/if}
                        </div>
                      </div>
                    </div>
                  {:else if preview.facs?.length}
                    <div class="dock-pane">
                      <div class="dock-label"><span>Encoding</span></div>
                      <p class="muted dock-note">
                        No encoding to render yet — the measures are generated
                        when the measure correction is submitted.
                      </p>
                    </div>
                  {/if}
                {/if}
              </div>
            </section>
          {/if}
        </div>

        {#if panel && selected}
          <aside class="panel" style={`--panel-w:${panelW}px`}>
            <button
              type="button"
              class="panel-resizer"
              aria-label="Drag to resize the panel"
              title="Drag to resize the panel"
              onpointerdown={(e) => {
                e.preventDefault();
                resizing = "panel";
              }}
            ></button>
            <div class="phead">
              <span class="picon {panel.iconKind}">{panel.icon}</span>
              <div class="ptitles">
                <div class="ptitle">{panel.title}</div>
                <div class="psub mono">{panel.subtitle}</div>
              </div>
              <button
                type="button"
                class="pclose"
                onclick={() => (selected = null)}
                title="Close the panel"
                aria-label="Close the panel">✕</button
              >
            </div>
            <div class="pbody">
              <div class="pills">
                {#each panel.pills as pl}
                  <span class="pill s-{pl.key}">{pl.text}</span>
                {/each}
              </div>
              {#if panel.lockText}
                <div class="lockstrip">
                  {@render lockIcon()}
                  <span class="mono">{panel.lockText}</span>
                </div>
              {/if}
              {#if panel.meta}
                <div class="pmeta mono">{panel.meta}</div>
              {/if}

              <div class="acts">
                {#each panel.actions as a (a.id)}
                  {#if a.id === "zone-editor"}
                    {#if a.disabled}
                      <span class="act disabled" title={a.title}>{a.label}</span>
                    {:else}
                      <a
                        class="act primary"
                        href={`/campaign/${owner}/${repo}/zones/${selected.task}`}
                        title={a.title}>{a.label}</a
                      >
                    {/if}
                  {:else}
                    <button
                      type="button"
                      class="act"
                      class:primary={a.primary && !a.disabled}
                      class:danger={a.id === "validate-fail"}
                      class:good={a.id === "validate-pass"}
                      disabled={busy || a.disabled}
                      title={a.title}
                      onclick={() => panelAction(a)}>{a.label}</button
                    >
                  {/if}
                {/each}
              </div>

              {#each panel.validations as v (v.sub)}
                <div class="valsum">
                  <div class="valsum-head">
                    <span class="seclabel">Validation · {v.sub}</span>
                    <span class="valsum-passes">{v.passes} of {v.threshold} passes</span>
                  </div>
                  <div class="valbar"><div style={`width:${v.pct}%`}></div></div>
                  {#each v.slots as s, i (i)}
                    <div class="valslot">
                      {#if s.state.key === "review"}
                        <span class="mark review">{@render reviewIcon()}</span>
                      {:else if s.state.key === "pass"}
                        <span class="mark pass">✓</span>
                      {:else if s.state.key === "fail"}
                        <span class="mark fail">✗</span>
                      {:else}
                        <span class="mark open"></span>
                      {/if}
                      <span class="mono slotid">{s.label}</span>
                      <span class="slotsub">{s.state.sub}</span>
                    </div>
                  {/each}
                </div>
              {/each}

              <button
                type="button"
                class="expert-toggle"
                onclick={() => (expert = !expert)}
                title="Node metadata (type, dependencies, fragment, pass threshold) and this task's history."
                >{expert
                  ? "Hide node metadata & history"
                  : "Show node metadata & history"}</button
              >
              {#if expert}
                <div class="xsec">
                  <span class="seclabel">Node type · registry</span>
                  {#each panel.metaRows as m (m.k)}
                    <div class="xrow">
                      <span>{m.k}</span>
                      <span class="mono" class:done={m.done}>{m.v}</span>
                    </div>
                  {/each}
                </div>
                <div class="xsec">
                  <span class="seclabel">History</span>
                  {#if panel.history.length === 0}
                    <span class="muted xnote">No history for this task yet.</span>
                  {/if}
                  {#each panel.history as h, i (i)}
                    <div class="xhist">
                      <span class="mono xts">{h.t}</span>
                      <span>{h.text}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </aside>
        {/if}
      </div>
    {:else}
      <div class="tablesview">
        <div class="tcol">
          <div class="tsec">
            <div class="tname">state.csv</div>
            <div class="tcard">
              <div class="trow thead" style="--cols: 1fr 1fr 1.4fr 1fr 1.6fr">
                <span>task_id</span><span>subtask_id</span><span>status</span
                ><span>encoder</span><span>validate_status_*</span>
              </div>
              {#each rows as r (r.task_id + "/" + r.subtask_id)}
                <div
                  class="trow"
                  class:subrow={r.subtask_id !== ""}
                  style="--cols: 1fr 1fr 1.4fr 1fr 1.6fr"
                >
                  <span class="mono">{r.task_id}</span>
                  <span class="mono dim">{r.subtask_id || "—"}</span>
                  <span><span class="pill s-{r.status}">{r.status}</span></span>
                  <span class="mono">{r.encoder || "—"}</span>
                  <span class="mono small">{r.subtask_id ? joinedValidations(r) : "—"}</span>
                </div>
              {/each}
            </div>
          </div>

          <div class="tsec">
            <div class="tname">lock.csv</div>
            <div class="tcard">
              <div class="trow thead" style="--cols: 1fr 1fr 1fr 1.4fr 1fr">
                <span>task_id</span><span>subtask_id</span><span>user_id</span
                ><span>timestamp</span><span>kind</span>
              </div>
              {#each locks as l}
                <div class="trow" style="--cols: 1fr 1fr 1fr 1.4fr 1fr">
                  <span class="mono">{l.task_id}</span>
                  <span class="mono">{l.subtask_id || "—"}</span>
                  <span class="mono">{l.user_id}</span>
                  <span class="mono dim">{l.timestamp}</span>
                  <span class="mono">{l.kind}</span>
                </div>
              {/each}
              {#if locks.length === 0}
                <div class="tempty mono">— no active locks —</div>
              {/if}
            </div>
          </div>

          <div class="tsec">
            <div class="tname">
              history.csv <span class="mono dim small">(append-only, newest first)</span>
            </div>
            <div class="tcard">
              {#each historyNewestFirst as h, i (i)}
                <div class="hrow">
                  <span class="mono xts">{h.timestamp}</span>
                  <span class="mono">@{h.user_id}</span>
                  <span>{h.action}{h.task_id ? ` ${h.task_id}` : ""}{h.subtask_id ? `/${h.subtask_id}` : ""}</span>
                  <span class="outcome" class:bad={h.outcome !== "accepted"}
                    >{h.outcome}</span
                  >
                  <span class="dim">{h.detail}</span>
                </div>
              {/each}
              {#if history.length === 0}
                <div class="tempty mono">— no history yet —</div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .console {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #fafafa;
  }
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .muted {
    color: #777;
  }
  .msg {
    padding: 1rem 1.4rem;
  }

  /* ------------------------------------------------------------ overlay */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.72);
    backdrop-filter: blur(2px);
  }
  .overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 26px 34px;
    background: #fff;
    border: 1px solid #e5e5e5;
    border-radius: 14px;
    box-shadow: 0 12px 44px rgba(0, 0, 0, 0.14);
    text-align: center;
  }
  .spinner {
    width: 34px;
    height: 34px;
    border: 3px solid #e5e5e5;
    border-top-color: #3056d3;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
  }
  .overlay-title {
    margin: 0;
    font-weight: 600;
    font-size: 14px;
  }
  .overlay-sub {
    margin: 0;
    color: #777;
    font-size: 0.85rem;
  }

  /* ------------------------------------------------------------- header */
  .conhead {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 20px;
    border-bottom: 1px solid #eee;
    background: #fff;
    flex: none;
  }
  .back {
    color: #555;
    text-decoration: none;
    font-size: 16px;
    padding: 2px 6px;
  }
  .titles {
    line-height: 1.2;
  }
  .title {
    font-weight: 700;
    font-size: 14px;
  }
  .handle {
    font-size: 11px;
    color: #2a78d6;
    text-decoration: none;
  }
  .handle:hover {
    text-decoration: underline;
  }
  .progress {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 12px;
    background: #fafafa;
    border: 1px solid #eee;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    color: #555;
  }
  .progress .bar {
    width: 120px;
    height: 6px;
    border-radius: 999px;
    background: #eaeaea;
    overflow: hidden;
  }
  .progress .bar div {
    height: 100%;
    background: #7fbf8a;
  }
  .spacer,
  .cspacer {
    flex: 1;
  }
  .hbtn {
    font-size: 11px;
    font-weight: 500;
    padding: 6px 11px;
    border: 1px solid #d0d0d0;
    border-radius: 7px;
    background: #fff;
    color: #555;
    cursor: pointer;
  }
  .hbtn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .tabs {
    display: flex;
    border: 1px solid #d0d0d0;
    border-radius: 7px;
    overflow: hidden;
  }
  .tabs button {
    font-size: 11px;
    font-weight: 500;
    padding: 6px 11px;
    background: #fff;
    color: #999;
    border: none;
    cursor: pointer;
  }
  .tabs button.on {
    font-weight: 600;
    background: #1a1a1a;
    color: #fff;
  }

  /* ------------------------------------------------------------ banners */
  .banner {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 20px;
    font-size: 12.5px;
    flex: none;
  }
  .banner.ok {
    background: #e8f7ec;
    border-bottom: 1px solid #b6e2c1;
    color: #1a6b33;
  }
  .banner.err {
    background: #fdeaea;
    border-bottom: 1px solid #f3c0c0;
    color: #9f3a38;
  }
  .banner.warn {
    background: #fff8e1;
    border-bottom: 1px solid #f0dca0;
    color: #7a6011;
  }
  .banner-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .dismiss {
    font-size: 11px;
    font-weight: 600;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    opacity: 0.6;
    flex: none;
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
  .rawlink {
    display: flex;
    gap: 0.4rem;
  }
  .rawlink input {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    padding: 0.3rem 0.5rem;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    background: #fff;
  }
  .rawlink button {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid #ccc;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }

  /* --------------------------------------------------------- graph body */
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .stage {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .canvas-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .scroller {
    position: absolute;
    inset: 0;
    overflow: auto;
    display: flex;
    background: #fafafa;
    background-image: radial-gradient(#e4e2dc 1px, transparent 1px);
    background-size: 22px 22px;
  }
  .canvas {
    position: relative;
    flex: none;
    /* Centres the flow when it is smaller than the viewport. */
    margin: auto;
  }
  .edges {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .edge {
    fill: none;
    stroke-width: 2.5;
  }
  .edge.green {
    stroke: #7fbf8a;
  }
  .edge.grey {
    stroke: #c7c7c7;
  }
  .edge.open {
    stroke: #d9d9d9;
    stroke-dasharray: 5 5;
  }

  /* Section heights (86 / 28 / 24) must match the layout constants in
     campaign-graph.ts, which computes node heights from them. */
  .node {
    position: absolute;
    display: flex;
    flex-direction: column;
    background: #fff;
    border: 1px solid #e5e5e5;
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  }
  .node.s-completed {
    border-color: #b6e2c1;
  }
  .node.s-encoding,
  .node.s-claimed {
    border-color: #f0dca0;
  }
  .node.s-blocked {
    background: #fbfbfa;
  }
  .node.nextup {
    border-color: #3056d3;
  }
  .node.selected {
    border-color: #3056d3;
    box-shadow:
      0 0 0 1px #3056d3,
      0 5px 15px rgba(48, 86, 211, 0.18);
  }
  .nextup-badge {
    position: absolute;
    top: -9px;
    left: 12px;
    background: #3056d3;
    color: #fff;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 2px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  .port {
    position: absolute;
    /* On the header midline (headH / 2), matching the edge anchors. */
    top: 43px;
    transform: translateY(-50%);
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #fff;
    border: 2px solid #a9a9a9;
    z-index: 1;
  }
  .port.in {
    left: -6px;
  }
  .port.out {
    right: -6px;
    border-color: #d5d5d5;
  }
  .port.green {
    border-color: #7fbf8a;
  }
  .nmain {
    height: 86px;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    border-radius: 12px 12px 0 0;
  }
  .nmain:hover {
    background: #fcfcfb;
  }
  .nhead {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 12px 7px;
    min-width: 0;
  }
  .nicon {
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font: 700 12px ui-monospace, monospace;
  }
  .nicon.pre {
    background: #f3edfa;
    color: #8b5fbf;
  }
  .nicon.encode {
    background: #fff4d6;
    color: #8a6d00;
  }
  .ntitles {
    min-width: 0;
    line-height: 1.2;
    display: flex;
    flex-direction: column;
  }
  .ntitle {
    font-weight: 600;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nsub {
    font-size: 10px;
    color: #aaa;
  }
  .nmeta {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 12px;
    min-width: 0;
  }
  .nmeta-text {
    font-size: 10px;
    color: #888;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .nslots-head {
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    border-top: 1px solid #e8edf6;
    background: #f7faff;
    font-size: 9.5px;
    font-weight: 600;
    color: #2c5aa0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .nslot {
    height: 26px;
    margin: 0 8px 4px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 8px;
    border: 1px solid #e2e8f4;
    border-radius: 7px;
    background: #fbfcfe;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    font-size: 10.5px;
    min-width: 0;
  }
  .nslot:hover {
    border-color: #9db9e8;
    background: #f0f5fd;
  }
  .nslot.selected {
    border-color: #3056d3;
    background: #e8f1fd;
  }
  .nslot.claimable {
    border-color: #bcd4f3;
    background: #f0f6fe;
  }
  .nslot.claimable .nslot-who {
    color: #2c5aa0;
    font-weight: 500;
  }
  .nslot .mark {
    width: 16px;
    height: 16px;
  }
  .nslot-id {
    color: #555;
    flex: none;
  }
  .nslot-who {
    color: #999;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }
  .nslot-arrow {
    flex: none;
    color: #a9bede;
    font-size: 13px;
    line-height: 1;
  }
  .nslot:hover .nslot-arrow,
  .nslot.claimable .nslot-arrow {
    color: #3056d3;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    font-size: 9px;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
    background: #f3f3f3;
    border: 1px solid #ddd;
    color: #999;
  }
  .pill.s-completed,
  .pill.s-pass {
    background: #e8f7ec;
    border-color: #b6e2c1;
    color: #1a7f37;
  }
  .pill.s-encoding_required,
  .pill.s-encoding,
  .pill.s-claimed {
    background: #fff4d6;
    border-color: #f0dca0;
    color: #8a6d00;
  }
  .pill.s-validation_required,
  .pill.s-review {
    background: #e8f1fd;
    border-color: #bcd4f3;
    color: #2c5aa0;
  }
  .pill.s-fail {
    background: #fdecec;
    border-color: #f3c0c0;
    color: #b42318;
  }


  /* -------------------------------------------------------------- panel */
  .panel {
    width: var(--panel-w, 360px);
    flex: none;
    border-left: 1px solid #eee;
    background: #fff;
    display: flex;
    flex-direction: column;
    min-height: 0;
    position: relative;
  }
  .panel-resizer {
    position: absolute;
    left: -5px;
    top: 0;
    bottom: 0;
    width: 9px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: col-resize;
    z-index: 5;
  }
  .panel-resizer:hover,
  .panel-resizer:active {
    background: rgba(48, 86, 211, 0.18);
  }
  .phead {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 14px 16px 12px;
    border-bottom: 1px solid #eee;
    flex: none;
  }
  .picon {
    flex: none;
    width: 30px;
    height: 30px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font: 700 13px ui-monospace, monospace;
  }
  .picon.pre {
    background: #f3edfa;
    color: #8b5fbf;
  }
  .picon.encode {
    background: #fff4d6;
    color: #8a6d00;
  }
  .picon.validate {
    background: #eef2fb;
    color: #5b7bc0;
  }
  .ptitles {
    flex: 1;
    line-height: 1.2;
    min-width: 0;
  }
  .ptitle {
    font-weight: 600;
    font-size: 14.5px;
  }
  .psub {
    font-size: 10px;
    color: #999;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .expert-toggle {
    font-size: 10.5px;
    font-weight: 600;
    font-family: inherit;
    color: #2a78d6;
    border: 1px solid #cfe0f6;
    border-radius: 7px;
    padding: 6px 9px;
    background: #fff;
    cursor: pointer;
    flex: none;
    width: 100%;
  }
  .pclose {
    font-size: 11px;
    font-weight: 600;
    border: none;
    background: none;
    color: #999;
    cursor: pointer;
    padding: 4px;
    flex: none;
  }
  .pbody {
    padding: 15px 16px;
    display: flex;
    flex-direction: column;
    gap: 15px;
    overflow: auto;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .pbody .pill {
    font-size: 10px;
  }
  .lockstrip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 11px;
    background: #f4f7fe;
    border: 1px solid #dfe7fb;
    border-radius: 8px;
    font-size: 10.5px;
    color: #3056d3;
  }
  .pmeta {
    font-size: 10.5px;
    color: #888;
  }
  .acts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
  }
  .act {
    font-size: 11.5px;
    font-weight: 500;
    padding: 8px 12px;
    border: 1px solid #d0d0d0;
    border-radius: 8px;
    text-align: center;
    color: #444;
    background: #fff;
    cursor: pointer;
    text-decoration: none;
    display: block;
  }
  .act.primary {
    font-weight: 600;
    font-size: 12.5px;
    padding: 9px 12px;
    background: #1a1a1a;
    color: #fff;
    border-color: #1a1a1a;
  }
  .act.good {
    color: #1a7f37;
  }
  .act.danger {
    color: #b42318;
  }
  .act:disabled,
  .act.disabled {
    background: #f4f4f4;
    color: #bbb;
    border-color: #eee;
    cursor: default;
  }
  .seclabel {
    font-weight: 600;
    font-size: 10px;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .valsum {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .valsum-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .valsum-passes {
    font-weight: 600;
    font-size: 10.5px;
    color: #555;
  }
  .valbar {
    height: 6px;
    border-radius: 999px;
    background: #eaeaea;
    overflow: hidden;
  }
  .valbar div {
    height: 100%;
    background: #7fbf8a;
  }
  .valslot {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }
  .mark {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 5px;
    display: grid;
    place-items: center;
    font-size: 10px;
    line-height: 1;
  }
  .mark.pass {
    background: #e8f7ec;
    color: #1a7f37;
  }
  .mark.fail {
    background: #fdecec;
    color: #b42318;
  }
  .mark.open {
    border-radius: 50%;
    border: 1.5px dashed #ccc;
  }
  .mark.review {
    background: #e8f1fd;
    color: #2c5aa0;
  }
  .icon-review {
    width: 10px;
    height: 10px;
    display: block;
  }
  .icon-lock {
    flex: none;
    width: 12px;
    height: 12px;
    display: block;
    color: #888;
  }
  .lockstrip .icon-lock {
    width: 14px;
    height: 14px;
    color: #3056d3;
  }
  .slotid {
    color: #777;
  }
  .slotsub {
    color: #999;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .xsec {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .xrow {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 11px;
  }
  .xrow > span:first-child {
    color: #999;
  }
  .xrow .mono {
    color: #555;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .xrow .mono.done {
    color: #1a7f37;
  }
  .xhist {
    display: flex;
    gap: 8px;
    font-size: 10.5px;
    color: #777;
  }
  .xts {
    color: #bbb;
    white-space: nowrap;
  }
  .xnote {
    font-size: 10.5px;
  }

  .dock {
    flex: 0 0 55%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #fff;
    border-top: 1px solid #e5e5e5;
    position: relative;
  }
  .dock-resizer {
    position: absolute;
    top: -5px;
    left: 0;
    right: 0;
    height: 9px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: row-resize;
    z-index: 5;
  }
  .dock-resizer:hover,
  .dock-resizer:active {
    background: rgba(48, 86, 211, 0.18);
  }
  .dock-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    border-bottom: 1px solid #eee;
  }
  .dock-title {
    font-weight: 600;
    font-size: 12px;
  }
  .dock-title .mono {
    color: #777;
    font-weight: 400;
  }
  .dock-nav {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .dock-nav-label {
    min-width: 110px;
    text-align: center;
  }
  .dock-viewmode {
    display: flex;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    overflow: hidden;
  }
  .dock-viewmode button {
    font-size: 10.5px;
    font-weight: 500;
    font-family: inherit;
    padding: 3px 9px;
    background: #fff;
    color: #999;
    border: none;
    cursor: pointer;
  }
  .dock-viewmode button.on {
    font-weight: 600;
    background: #1a1a1a;
    color: #fff;
  }
  .dock-check {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: #666;
  }
  .dock-nav button {
    font: inherit;
    padding: 1px 8px;
    border: 1px solid #d0d0d0;
    border-radius: 5px;
    background: #fff;
    cursor: pointer;
  }
  .dock-nav button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .dock-body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .dock-pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .dock-pane + .dock-pane {
    border-left: 1px solid #eee;
  }
  .dock-label {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 30px;
    font-size: 10px;
    font-weight: 600;
    color: #999;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 3px 14px;
    border-bottom: 1px solid #f2f2f2;
    background: #fafafa;
  }
  .dock-tools {
    display: flex;
    align-items: center;
    gap: 12px;
    text-transform: none;
    letter-spacing: normal;
    font-weight: 400;
  }
  .dock-toggle {
    font-size: 10.5px;
    font-weight: 500;
    font-family: inherit;
    padding: 3px 9px;
    border: 1px solid #d0d0d0;
    border-radius: 999px;
    background: #fff;
    color: #999;
    cursor: pointer;
  }
  .dock-toggle.on {
    color: #2c5aa0;
    border-color: #bcd4f3;
    background: #e8f1fd;
  }
  .zoomctl {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .zoomctl input[type="range"] {
    width: 90px;
    accent-color: #3056d3;
  }
  .zoomctl span {
    min-width: 36px;
    font-size: 10px;
    color: #777;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .pv-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .pv-spread {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    padding: 12px 14px;
    min-width: 100%;
    box-sizing: border-box;
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
    border: 1px solid #e5e5e5;
    border-radius: 6px;
    background: #fff;
  }
  .pv-page.enc :global(svg) {
    width: 100%;
    height: auto;
    display: block;
    border: 1px solid #eee;
    border-radius: 6px;
    background: #fff;
  }
  .pv-page figcaption {
    font-size: 10px;
    color: #999;
    text-align: center;
  }
  .pv-zone {
    fill: rgba(48, 86, 211, 0.1);
    stroke: rgba(48, 86, 211, 0.65);
    stroke-width: 2;
  }
  .pv-zonelabel {
    font: 24px ui-monospace, monospace;
    fill: #1a1a1a;
    paint-order: stroke;
    stroke: #fff;
    stroke-width: 4;
  }
  .dock-note,
  .dock-err {
    margin: 0;
    padding: 14px;
    font-size: 12px;
  }
  .dock-err {
    color: #b42318;
  }

  /* ------------------------------------------------------------- tables */
  .tablesview {
    flex: 1;
    overflow: auto;
    padding: 22px 26px;
  }
  .tcol {
    max-width: 900px;
    display: flex;
    flex-direction: column;
    gap: 26px;
  }
  .tname {
    font-weight: 600;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .tcard {
    border: 1px solid #e5e5e5;
    border-radius: 8px;
    overflow: hidden;
    background: #fff;
  }
  .trow {
    display: grid;
    grid-template-columns: var(--cols);
    border-bottom: 1px solid #f2f2f2;
    align-items: center;
  }
  .trow:last-child {
    border-bottom: none;
  }
  .trow > span {
    padding: 7px 10px;
    font-size: 11px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .trow.thead {
    background: #fafafa;
    border-bottom: 1px solid #eee;
  }
  .trow.thead > span {
    font-weight: 600;
    font-size: 10px;
    color: #777;
    padding: 8px 10px;
  }
  .trow.subrow {
    background: #fcfcfb;
  }
  .dim {
    color: #999;
  }
  .small {
    font-size: 10px;
  }
  .tempty {
    padding: 9px 10px;
    font-size: 11px;
    color: #aaa;
  }
  .hrow {
    display: flex;
    gap: 10px;
    padding: 7px 12px;
    border-bottom: 1px solid #f2f2f2;
    font-size: 11px;
    align-items: baseline;
  }
  .hrow:last-child {
    border-bottom: none;
  }
  .outcome {
    font-weight: 600;
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    background: #e8f7ec;
    color: #1a7f37;
    white-space: nowrap;
  }
  .outcome.bad {
    background: #fdecec;
    color: #b42318;
  }

  /* --------------------------------------------------------- responsive */
  @media (max-width: 900px) {
    .panel-resizer,
    .dock-resizer {
      display: none;
    }
    .panel {
      width: auto;
    }
    .panel {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      max-height: 70vh;
      border-left: none;
      border-top: 1px solid #eee;
      border-radius: 14px 14px 0 0;
      box-shadow: 0 -12px 44px rgba(0, 0, 0, 0.14);
      z-index: 40;
    }
  }
</style>
