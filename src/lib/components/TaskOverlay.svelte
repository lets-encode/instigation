<!--
  The console's task overlay: a modal over the board with the task's score
  preview (facsimile and rendered encoding, book-style paging), the validation
  record and the discussion thread. Commands run through callbacks the console
  page passes in; the shared CommandRunner carries the busy state and result.
-->
<script module lang="ts">
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
        // Write each measure's number as data-n, so a fail's measure range can
        // be highlighted in the rendered encoding.
        svgAdditionalAttribute: ["measure@n"],
      });
    }
    return verovio;
  }
</script>

<script lang="ts">
  import DOMPurify from "dompurify";
  import { untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { TaskRow, LockRow, CommentRow } from "$lib/campaign-tables.ts";
  import type { FailComment } from "$lib/commands.ts";
  import { handle, statusPill } from "$lib/campaign-graph.ts";
  import {
    buildRecord,
    buildThreads,
    elapsed,
    initialOf,
  } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import { parseFacsimileMei } from "$lib/mei-facsimile.ts";
  import type { MeasureBox } from "$lib/mei-facsimile.ts";
  import { resolveFacsimileImageUrls } from "$lib/facsimile-images.ts";
  import { buildSpreads } from "$lib/page-spreads.ts";

  let {
    card,
    campaign,
    owner,
    repo,
    taskDefs,
    comments,
    locks,
    logins,
    viewer,
    canPush,
    runner,
    resultBanner,
    slotDot,
    onclaim,
    oneditor,
    onsubmitencoding,
    onvalidate,
    oncomment,
    onresolve,
    onsendback,
    onrawlink,
    onclose,
  }: {
    card: BoardCard;
    campaign: string;
    owner: string;
    repo: string;
    taskDefs: TaskRow[];
    comments: CommentRow[];
    locks: LockRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    resultBanner: Snippet;
    slotDot: Snippet<[string]>;
    onclaim: (task_id: string, subtask_id: string) => Promise<void>;
    oneditor: (task_id: string) => Promise<void>;
    onsubmitencoding: (task_id: string) => Promise<void>;
    onvalidate: (
      task_id: string,
      subtask_id: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<void>;
    oncomment: (kind: string, body: string, parent_id: string) => Promise<void>;
    onresolve: (comment_id: string) => Promise<void>;
    onsendback: (task_id: string) => Promise<void>;
    onrawlink: (task_id: string) => Promise<void>;
    onclose: () => void;
  } = $props();

  const record = $derived(buildRecord(card, comments, viewer, logins));
  const threads = $derived(buildThreads(comments, card.task));
  const mineEncoding = $derived(
    viewer !== "" &&
      locks.some(
        (l) =>
          l.task_id === card.task &&
          l.subtask_id === "" &&
          l.kind === "encoding" &&
          l.user_id === viewer,
      ),
  );

  // The measure range a fail refers to, highlighted in both preview panes.
  let anchor = $state<{ page: number; m1: number; m2: number } | null>(null);
  // The inline form a fail verdict fills in (its mandatory comment).
  let failForm = $state<{
    sub: string;
    body: string;
    page: string;
    m1: string;
    m2: string;
  } | null>(null);
  // Composer state for the discussion thread.
  let composerText = $state("");
  let composerKind = $state<"question" | "addition">("question");
  let replyTo = $state<CommentRow | null>(null);

  function showAnchorFor(c: CommentRow) {
    const m1 = Number(c.measure_start);
    const m2 = Number(c.measure_end || c.measure_start);
    anchor = {
      page: Number(c.page),
      m1: Number.isFinite(m1) ? m1 : 0,
      m2: Number.isFinite(m2) ? m2 : 0,
    };
    showZones = true;
    if (anchor.page >= 1 && anchor.page <= pvPageTotal) {
      pvFirstVisible = anchor.page - 1;
      renderSpread();
    }
  }
  const anchorLabel = (c: CommentRow): string => {
    const range =
      c.measure_end && c.measure_end !== c.measure_start
        ? `m. ${c.measure_start}–${c.measure_end}`
        : `m. ${c.measure_start}`;
    return `${c.page ? `p. ${c.page} · ` : ""}${range}`;
  };
  const hasAnchor = (c: CommentRow): boolean =>
    c.measure_start !== "" || c.page !== "";

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
  // Mark the anchored measures in a rendered encoding page (Verovio writes the
  // measure number as data-n — see svgAdditionalAttribute below).
  function flagSvg(svg: string): string {
    if (!anchor || !svg) return svg;
    const a = anchor;
    try {
      const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
      for (const g of doc.querySelectorAll("g.measure")) {
        const n = Number(g.getAttribute("data-n"));
        if (Number.isFinite(n) && n >= a.m1 && n <= a.m2)
          g.classList.add("m-flag");
      }
      return new XMLSerializer().serializeToString(doc);
    } catch {
      return svg;
    }
  }
  // Flagged pages, derived so the DOMParser round trip re-runs only when the
  // rendered pages or the anchor change — not on every overlay re-render.
  const flaggedSvgs = $derived.by(() => {
    const out: Record<number, string> = {};
    if (!preview) return out;
    for (const [n, svg] of Object.entries(preview.svgs)) {
      out[Number(n)] = flagSvg(svg);
    }
    return out;
  });

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

  // Preview display state: book-style paging shared by both panes, one zoom
  // for both, and the zone overlay toggle.
  let pvView = $state<"single" | "double">("single");
  let pvFirstOnRight = $state(true);
  let pvFirstVisible = $state(0);
  let pvZoom = $state(1);
  let showZones = $state(true);
  const PV_ZOOM_MIN = 0.5;
  const PV_ZOOM_MAX = 4;
  const pvZoomBy = (step: number) =>
    (pvZoom = Math.min(
      PV_ZOOM_MAX,
      Math.max(PV_ZOOM_MIN, Math.round((pvZoom + step) * 100) / 100),
    ));

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

  // Render the encoding pages the current spread needs (kept for later visits).
  function renderSpread() {
    if (!preview || preview.loading || !verovio || preview.pageCount === 0)
      return;
    let changed = false;
    const svgs = { ...preview.svgs };
    for (const p of pvSpread.pages) {
      const n = p + 1;
      if (n <= preview.pageCount && !svgs[n]) {
        // The MEI behind the render is volunteer-supplied; sanitise the SVG
        // before it is ever injected with {@html}.
        svgs[n] = DOMPurify.sanitize(verovio.renderToSVG(n), {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
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

  // Preview both sides of the score: the facsimile pages (when the score
  // references any) and the rendered encoding (when it holds measures).
  async function loadPreview(task_id: string, startPage = 0) {
    const f = readForge();
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
        const urls = await resolveFacsimileImageUrls(
          f,
          owner,
          repo,
          fragment,
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
        if (!tk.loadData(mei))
          throw new Error(`Verovio could not parse ${fragment}.`);
        pageCount = tk.getPageCount();
      }

      if (preview?.taskId === task_id) {
        preview = {
          taskId: task_id,
          loading: false,
          facs,
          pageCount,
          svgs: {},
        };
        const total = Math.max(facs?.length ?? 0, pageCount);
        pvFirstVisible = Math.min(startPage, Math.max(0, total - 1));
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

  const fragmentOf = (taskId: string) =>
    findRow(taskDefs, taskId, "")?.fragment;

  async function submitFail() {
    if (!failForm || !failForm.body.trim()) return;
    const form = failForm;
    await onvalidate(card.task, form.sub, "fail", {
      body: form.body,
      page: form.page.trim(),
      measure_start: form.m1.trim(),
      measure_end: form.m2.trim(),
    });
    if (runner.result?.ok) failForm = null;
  }

  async function postComment() {
    if (!composerText.trim()) return;
    const kind = replyTo ? "reply" : composerKind;
    const parent_id = replyTo?.comment_id ?? "";
    await oncomment(kind, composerText, parent_id);
    if (runner.result?.ok) {
      composerText = "";
      replyTo = null;
    }
  }

  const canResolve = (c: CommentRow) =>
    viewer !== "" && (canPush || c.author_id === viewer);

  const commentLogin = (c: CommentRow) => handle(logins, c.author_id);

  // The preview loads once, when the overlay opens. A per-page task opens on
  // its page; whole-file tasks open on page 1.
  untrack(() => {
    const locator = findRow(taskDefs, card.task, "")?.locator ?? "";
    const pg = /^surface-(\d+)$/.exec(locator);
    const startPage = pg ? Number(pg[1]) - 1 : 0;
    loadPreview(card.task, startPage);
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") onclose();
  }}
/>

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="modal"
    role="dialog"
    aria-modal="true"
    aria-label={`Task ${card.title}`}
  >
    {@render resultBanner()}
    <div class="mhead">
      <span class="ticon" class:pre={card.pre}
        >{card.pre ? "M" : "E"}</span
      >
      <span class="mtitle">{card.title}</span>
      <span class="mono mtask">{card.task}</span>
      <span class="pill s-{card.statusKey}">
        {card.statusKey === "validation_required"
          ? `validation · ${card.passes} of ${card.threshold} passes`
          : statusPill(card.statusKey, card.pre)}
      </span>
      {#if card.counts.fails > 0}
        <span class="chip chip-fail"
          >{card.counts.fails} fail{card.counts.fails === 1
            ? ""
            : "s"}</span
        >
      {/if}
      <span class="mspacer"></span>
      <button
        type="button"
        class="mbtn"
        onclick={() => onrawlink(card.task)}
        disabled={runner.busy}
        title="Copy a direct link to the score file to paste into mei-friend manually."
        >Copy raw link</button
      >
      {#if mineEncoding}
        <button
          type="button"
          class="mbtn primary"
          onclick={() => onsubmitencoding(card.task)}
          disabled={runner.busy}
          title="After committing your encoding in mei-friend, submit it for validation."
          >Submit encoding</button
        >
      {/if}
      {#if card.pre}
        <a
          class="mbtn blue"
          href={`/${campaign}/zones/${card.task}`}
          title="Open the measure zones on the facsimile."
          >Open zone editor</a
        >
      {:else}
        <button
          type="button"
          class="mbtn blue"
          onclick={() => oneditor(card.task)}
          disabled={runner.busy || !auth.user || card.column === "blocked"}
          title="Opens the score in mei-friend; claims the task for you first when it is open to claim."
          >Open in mei-friend ↗</button
        >
      {/if}
      <button
        type="button"
        class="mclose"
        onclick={onclose}
        aria-label="Close the preview"
        title="Close the preview">×</button
      >
    </div>
    <div class="mbody">
      <div class="mpreview">
        <div class="ptoolbar">
          <button
            type="button"
            class="tbtn-sq"
            onclick={() => pvGo(-1)}
            disabled={pvSpreadIndex <= 0}
            aria-label="Previous page">‹</button
          >
          <span class="pglabel">{pvSpreadLabel}</span>
          <button
            type="button"
            class="tbtn-sq"
            onclick={() => pvGo(1)}
            disabled={pvSpreadIndex >= pvSpreads.length - 1}
            aria-label="Next page">›</button
          >
          <span class="mspacer"></span>
          {#if preview?.facs?.length}
            <button
              type="button"
              class="tchip"
              class:on={showZones}
              onclick={() => (showZones = !showZones)}
              title="Show or hide the measure zones on the facsimile"
              >Measure zones · {showZones ? "on" : "off"}</button
            >
          {/if}
          <button
            type="button"
            class="tchip"
            class:on={pvView === "double"}
            onclick={() =>
              pvSetView(pvView === "double" ? "single" : "double")}
            title="Show a two-page spread">Double page</button
          >
          {#if pvView === "double"}
            <label
              class="pcheck"
              title="Whether page 1 is a right-hand page, so a spread pairs 2–3, 4–5, … the way the score opens"
            >
              <input
                type="checkbox"
                checked={pvFirstOnRight}
                onchange={(e) =>
                  pvSetFirstOnRight(
                    (e.target as HTMLInputElement).checked,
                  )}
              />
              Page 1 right
            </label>
          {/if}
          <span class="vline"></span>
          <button
            type="button"
            class="tbtn-sq"
            onclick={() => pvZoomBy(-0.25)}
            disabled={pvZoom <= PV_ZOOM_MIN}
            aria-label="Zoom out">−</button
          >
          <span class="zval mono">{Math.round(pvZoom * 100)}%</span>
          <button
            type="button"
            class="tbtn-sq"
            onclick={() => pvZoomBy(0.25)}
            disabled={pvZoom >= PV_ZOOM_MAX}
            aria-label="Zoom in">+</button
          >
        </div>
        <div class="pbody-panes">
          {#if !preview || preview.loading}
            <p class="muted pnote">Loading the score…</p>
          {:else if preview.error}
            <p class="perr">{preview.error}</p>
          {:else}
            {#if preview.facs?.length}
              <div class="pane">
                <div class="pv-scroll">
                  <div class="pv-spread" style={`width:${pvZoom * 100}%`}>
                    {#if pvSpread.lonelySide === "right"}<div
                        class="pv-spacer"
                      ></div>{/if}
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
                            {#if showZones}
                              {#each pg.zones as z, zi (zi)}
                                <rect
                                  class="pv-zone"
                                  class:flagged={anchor &&
                                    p + 1 === anchor.page &&
                                    zoneFlagged(z.label)}
                                  x={z.box.ulx}
                                  y={z.box.uly}
                                  width={z.box.lrx - z.box.ulx}
                                  height={z.box.lry - z.box.uly}
                                />
                                <text
                                  class="pv-zonelabel"
                                  class:flagged={anchor &&
                                    p + 1 === anchor.page &&
                                    zoneFlagged(z.label)}
                                  x={z.box.ulx + 6}
                                  y={z.box.uly + 30}>{z.label}</text
                                >
                              {/each}
                            {/if}
                          </svg>
                          <figcaption class="mono">
                            page {p + 1}
                          </figcaption>
                        {/if}
                      </figure>
                    {/each}
                    {#if pvSpread.lonelySide === "left"}<div
                        class="pv-spacer"
                      ></div>{/if}
                  </div>
                </div>
                <div class="pane-cap">Facsimile</div>
              </div>
            {/if}
            {#if preview.pageCount > 0}
              <div class="pane">
                <div class="pv-scroll">
                  <div class="pv-spread" style={`width:${pvZoom * 100}%`}>
                    {#if pvSpread.lonelySide === "right"}<div
                        class="pv-spacer"
                      ></div>{/if}
                    {#each pvSpread.pages as p (p)}
                      <div class="pv-page enc">
                        {#if p < preview.pageCount}
                          {@html flaggedSvgs[p + 1] ?? ""}
                        {/if}
                      </div>
                    {/each}
                    {#if pvSpread.lonelySide === "left"}<div
                        class="pv-spacer"
                      ></div>{/if}
                  </div>
                </div>
                <div class="pane-cap">
                  Current encoding — rendered with Verovio
                </div>
              </div>
            {:else if preview.facs?.length}
              <div class="pane">
                <p class="muted pnote">
                  No encoding to render yet — the measures are generated
                  when the measure correction is submitted.
                </p>
                <div class="pane-cap">Current encoding</div>
              </div>
            {/if}
          {/if}
        </div>
      </div>
      <div class="mrail">
        <div class="rail-scroll">
          <div class="rsec">
            <div class="rlabel">Validation record</div>
            {#each record as r (r.sub + "/" + r.slot)}
              {#if r.key === "fail"}
                <div class="failbox">
                  <div class="failhead">
                    {@render slotDot("fail")}
                    <span class="failtitle">Slot {r.slot + 1} · fail</span>
                    <span class="rwho">{r.login} · {r.elapsed}</span>
                  </div>
                  {#if r.comment}
                    <div class="failbody">“{r.comment.body}”</div>
                    {#if hasAnchor(r.comment)}
                      <div class="failchips">
                        <button
                          type="button"
                          class="chip chip-question anchorchip"
                          onclick={() => showAnchorFor(r.comment!)}
                          title="Highlight this measure range in the preview"
                          >{anchorLabel(r.comment)} — show in the preview</button
                        >
                      </div>
                    {/if}
                  {:else}
                    <div class="failbody muted">
                      No comment was recorded with this fail.
                    </div>
                  {/if}
                  <div class="failacts">
                    {#if r.comment && r.comment.resolved !== "true" && canResolve(r.comment)}
                      <button
                        type="button"
                        class="linkish"
                        onclick={() =>
                          onresolve(r.comment!.comment_id)}
                        disabled={runner.busy}
                        title="Mark this fail's comment as handled — it leaves the attention counts."
                        >Resolve</button
                      >
                    {:else if r.comment?.resolved === "true"}
                      <span class="muted small-note">resolved</span>
                    {/if}
                    <span class="mspacer"></span>
                    {#if viewer !== "" && (canPush || r.userId === viewer)}
                      <button
                        type="button"
                        class="dangerbtn"
                        onclick={() => onsendback(card.task)}
                        disabled={runner.busy}
                        title="Return the task to encoding: attribution and validations reset."
                        >Send back for encoding</button
                      >
                    {/if}
                  </div>
                </div>
              {:else}
                <div class="rrow">
                  {@render slotDot(r.key)}
                  <span class="rslot"
                    >Slot {r.slot + 1} · {r.key === "review"
                      ? "in review"
                      : r.key}</span
                  >
                  {#if r.login}
                    <span class="rwho">{r.login} · {r.elapsed}</span>
                  {/if}
                  <span class="mspacer"></span>
                  {#if r.key === "pass"}
                    <span class="muted small-note">no remarks</span>
                  {:else if r.key === "open" && r.claimable}
                    <button
                      type="button"
                      class="claimbtn"
                      onclick={() =>
                        onclaim(card.task, r.sub)}
                      disabled={runner.busy}
                      title="Reserve this validation slot for review."
                      >Claim to review</button
                    >
                  {:else if r.key === "open"}
                    <span class="muted small-note">{r.note}</span>
                  {:else if r.mine}
                    <button
                      type="button"
                      class="passbtn"
                      onclick={() =>
                        onvalidate(card.task, r.sub, "pass")}
                      disabled={runner.busy}
                      title="Record a passing verdict.">Pass</button
                    >
                    <button
                      type="button"
                      class="failbtn"
                      class:on={failForm?.sub === r.sub}
                      onclick={() =>
                        (failForm =
                          failForm?.sub === r.sub
                            ? null
                            : {
                                sub: r.sub,
                                body: "",
                                page: String(
                                  (pvSpread.pages[0] ?? 0) + 1,
                                ),
                                m1: "",
                                m2: "",
                              })}
                      disabled={runner.busy}
                      title="Record a failing verdict — a fail carries a comment saying why."
                      >Fail</button
                    >
                  {/if}
                </div>
                {#if failForm && failForm.sub === r.sub && r.mine}
                  <div class="failform">
                    <textarea
                      rows="3"
                      bind:value={failForm.body}
                      placeholder="Why does this fail? (required)"
                    ></textarea>
                    <div class="failform-anchor">
                      <label
                        >p. <input
                          size="3"
                          bind:value={failForm.page}
                        /></label
                      >
                      <label
                        >m. <input
                          size="4"
                          bind:value={failForm.m1}
                          placeholder="from"
                        /></label
                      >
                      <label
                        >– <input
                          size="4"
                          bind:value={failForm.m2}
                          placeholder="to"
                        /></label
                      >
                      <span class="mspacer"></span>
                      <button
                        type="button"
                        class="dangerbtn"
                        onclick={submitFail}
                        disabled={runner.busy || !failForm.body.trim()}
                        >Submit fail</button
                      >
                    </div>
                  </div>
                {/if}
              {/if}
            {/each}
            <div class="rfoot">
              A fail always carries a comment — the validator cannot submit
              one without saying why.
            </div>
          </div>
          <div class="rsec discussion">
            <div class="rlabel">
              Discussion · {threads.reduce(
                (n, t) => n + 1 + t.replies.length,
                0,
              )}
            </div>
            {#each threads as t (t.root.comment_id)}
              <div class="crow" class:resolved={t.root.resolved === "true"}>
                <div class="chead">
                  <span class="avatar small"
                    >{initialOf(commentLogin(t.root))}</span
                  >
                  <span class="cwho">{commentLogin(t.root)}</span>
                  {#if t.root.kind === "question"}
                    <span class="chip chip-question">? question</span>
                  {:else}
                    <span class="chip chip-note">note</span>
                  {/if}
                  {#if t.root.resolved === "true"}
                    <span class="muted small-note">resolved</span>
                  {/if}
                  <span class="cwhen">{elapsed(t.root.timestamp)}</span>
                </div>
                <div class="cbody">“{t.root.body}”</div>
                <div class="cacts">
                  {#if auth.user}
                    <button
                      type="button"
                      class="linkish"
                      onclick={() => (replyTo = t.root)}>Reply</button
                    >
                  {/if}
                  {#if t.root.resolved !== "true" && canResolve(t.root)}
                    <button
                      type="button"
                      class="linkish"
                      onclick={() => onresolve(t.root.comment_id)}
                      disabled={runner.busy}>Resolve</button
                    >
                  {/if}
                </div>
                {#each t.replies as reply (reply.comment_id)}
                  <div class="creply">
                    <div class="chead">
                      <span class="avatar small"
                        >{initialOf(commentLogin(reply))}</span
                      >
                      <span class="cwho">{commentLogin(reply)}</span>
                      <span class="cwhen">{elapsed(reply.timestamp)}</span>
                    </div>
                    <div class="cbody">“{reply.body}”</div>
                  </div>
                {/each}
              </div>
            {/each}
            {#if threads.length === 0}
              <div class="muted small-note cnone">No discussion yet.</div>
            {/if}
          </div>
        </div>
        {#if auth.user}
          <div class="composer">
            {#if replyTo}
              <div class="replying">
                Replying to <strong>{commentLogin(replyTo)}</strong>
                <button
                  type="button"
                  class="linkish"
                  onclick={() => (replyTo = null)}>Cancel</button
                >
              </div>
            {:else}
              <div class="kindpick">
                <button
                  type="button"
                  class="tchip"
                  class:on={composerKind === "question"}
                  onclick={() => (composerKind = "question")}
                  title="Ask the campaign a question">question</button
                >
                <button
                  type="button"
                  class="tchip"
                  class:on={composerKind === "addition"}
                  onclick={() => (composerKind = "addition")}
                  title="Leave a note">note</button
                >
              </div>
            {/if}
            <div class="composer-row">
              <input
                bind:value={composerText}
                placeholder="Reply or leave a note…"
                onkeydown={(e) => {
                  if (e.key === "Enter" && composerText.trim())
                    postComment();
                }}
              />
              <button
                type="button"
                class="sendbtn"
                onclick={postComment}
                disabled={runner.busy || !composerText.trim()}>Send</button
              >
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .muted {
    color: var(--ink-faint);
  }
  .linkish {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    cursor: pointer;
  }
  .linkish:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mspacer {
    flex: 1;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-btn);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .avatar.small {
    width: 22px;
    height: 22px;
    font-size: 11px;
  }
  .chip {
    font-size: 11px;
    font-weight: 700;
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .chip-fail {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
  .chip-note {
    color: var(--warn);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
  }
  .chip-question {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }

  /* ------------------------------------------------------------- overlay */
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(31, 36, 51, 0.42);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 30;
    padding: 24px;
  }
  :global([data-theme="dark"]) .scrim {
    background: rgba(0, 0, 0, 0.55);
  }
  .modal {
    width: min(1440px, 100%);
    height: min(820px, 100%);
    background: var(--card);
    border-radius: 14px;
    box-shadow: 0 24px 80px rgba(31, 36, 51, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .modal :global(.banner) {
    border-radius: 0;
  }
  .mhead {
    min-height: 58px;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    padding: 6px 20px;
    gap: 12px;
    flex-wrap: wrap;
  }
  .ticon {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: var(--info-bg);
    border: 1px solid var(--info-line);
    color: var(--info);
    font:
      700 12px ui-monospace,
      monospace;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .ticon.pre {
    background: var(--pre-bg);
    border-color: var(--pre);
    color: var(--pre);
  }
  .mtitle {
    font-size: 16px;
    font-weight: 700;
  }
  .mtask {
    font-size: 11px;
    color: var(--ink-faint);
  }
  .mbtn {
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 7px 15px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    text-decoration: none;
    flex: none;
  }
  .mbtn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .mbtn.blue {
    border-color: var(--info-line);
    color: var(--info);
  }
  .mbtn.primary {
    border: 0;
    background: var(--accent-btn);
    color: #fff;
  }
  .mbtn.primary:hover:not(:disabled) {
    background: var(--accent-btn-hover);
    color: #fff;
  }
  .mbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mclose {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-faint);
    font-size: 15px;
    cursor: pointer;
    flex: none;
  }
  .mclose:hover {
    color: var(--ink);
  }
  .mbody {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .mpreview {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--line);
  }
  .ptoolbar {
    height: 44px;
    flex: none;
    border-bottom: 1px solid var(--line);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 10px;
    overflow-x: auto;
  }
  .tbtn-sq {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
    font-family: inherit;
  }
  .tbtn-sq:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .pglabel {
    font-size: 12.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .tchip {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
    white-space: nowrap;
  }
  .tchip.on {
    border-color: var(--info-line);
    background: var(--info-bg);
    color: var(--info);
  }
  .pcheck {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .vline {
    width: 1px;
    height: 18px;
    background: var(--line);
    flex: none;
  }
  .zval {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--ink-soft);
    min-width: 38px;
    text-align: center;
  }
  .pbody-panes {
    flex: 1;
    min-height: 0;
    background: var(--bg-inset);
    display: flex;
    gap: 16px;
    padding: 16px;
  }
  .pane {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .pane-cap {
    font-size: 11.5px;
    color: var(--ink-faint);
    text-align: center;
    flex: none;
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
  .pv-spread {
    display: flex;
    gap: 14px;
    align-items: flex-start;
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
  .pv-zone {
    fill: rgba(109, 195, 255, 0.12);
    stroke: rgba(37, 99, 201, 0.55);
    stroke-width: 2;
  }
  .pv-zone.flagged {
    fill: rgba(180, 35, 24, 0.1);
    stroke: #b42318;
    stroke-width: 3;
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
    font-weight: 700;
  }
  .pv-page.enc :global(g.measure.m-flag *) {
    fill: #b42318;
    stroke: #b42318;
  }

  /* ---------------------------------------------------------- right rail */
  .mrail {
    width: 400px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 6px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .rlabel {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    padding-bottom: 4px;
  }
  .rrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .rslot {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
  }
  .rwho {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .small-note {
    font-size: 11.5px;
    white-space: nowrap;
  }
  .claimbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--info-line);
    background: var(--card);
    color: var(--info);
    cursor: pointer;
    flex: none;
  }
  .claimbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .passbtn,
  .failbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--ok-line);
    background: var(--card);
    color: var(--ok);
    cursor: pointer;
    flex: none;
  }
  .failbtn {
    border-color: var(--danger-line);
    color: var(--danger);
  }
  .failbtn.on {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
    color: #fff;
  }
  .passbtn:disabled,
  .failbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .failbox {
    margin: 10px 0;
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    background: var(--danger-wash);
    padding: 12px 14px;
  }
  .failhead {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .failtitle {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--danger);
  }
  .failbody {
    font-size: 12.5px;
    color: var(--ink);
    margin-top: 8px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .failchips {
    display: flex;
    gap: 6px;
    margin-top: 9px;
    flex-wrap: wrap;
  }
  .anchorchip {
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .failacts {
    display: flex;
    gap: 12px;
    margin-top: 10px;
    align-items: center;
  }
  .dangerbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 5px 12px;
    border-radius: 999px;
    border: 0;
    background: var(--danger-solid);
    color: #fff;
    cursor: pointer;
    flex: none;
  }
  .dangerbtn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .rfoot {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 8px;
    line-height: 1.5;
  }
  .failform {
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    padding: 10px 12px;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--danger-wash);
  }
  .failform textarea {
    font: inherit;
    font-size: 12.5px;
    padding: 7px 10px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
    resize: vertical;
  }
  .failform-anchor {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--ink-soft);
    flex-wrap: wrap;
  }
  .failform-anchor input {
    font: inherit;
    font-size: 11.5px;
    padding: 3px 6px;
    border: 1px solid var(--line-input);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    width: 3.2em;
  }

  /* ---------------------------------------------------------- discussion */
  .discussion {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .crow {
    padding: 10px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .crow.resolved {
    opacity: 0.55;
  }
  .chead {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cwho {
    font-size: 12.5px;
    font-weight: 600;
  }
  .cwhen {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-left: auto;
  }
  .cbody {
    font-size: 12.5px;
    color: var(--ink-soft);
    margin-top: 6px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .cacts {
    display: flex;
    gap: 12px;
    margin-top: 6px;
  }
  .creply {
    padding: 10px 0 0 18px;
  }
  .cnone {
    padding: 8px 0;
  }
  .composer {
    flex: none;
    padding: 10px 20px 16px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .replying {
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .kindpick {
    display: flex;
    gap: 6px;
  }
  .composer-row {
    display: flex;
    gap: 8px;
  }
  .composer-row input {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-family: inherit;
    padding: 8px 12px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
  }
  .sendbtn {
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 8px 16px;
    border-radius: 999px;
    border: 0;
    background: var(--accent-btn);
    color: #fff;
    cursor: pointer;
    flex: none;
  }
  .sendbtn:hover:not(:disabled) {
    background: var(--accent-btn-hover);
  }
  .sendbtn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* ---------------------------------------------------------------- pills */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 999px;
    white-space: nowrap;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
  }
  .pill.s-completed,
  .pill.s-pass {
    background: var(--ok-bg);
    border-color: var(--ok-line);
    color: var(--ok);
  }
  .pill.s-encoding_required,
  .pill.s-encoding,
  .pill.s-claimed {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .pill.s-validation_required,
  .pill.s-review {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .pill.s-fail {
    background: var(--danger-bg);
    border-color: var(--danger-line);
    color: var(--danger);
  }

  /* --------------------------------------------------------- responsive */
  @media (max-width: 1100px) {
    .mbody {
      flex-direction: column;
      overflow-y: auto;
    }
    .mpreview {
      border-right: none;
      border-bottom: 1px solid var(--line);
      min-height: 380px;
    }
    .mrail {
      width: auto;
    }
  }
</style>
