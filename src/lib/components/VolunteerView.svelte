<!--
  The campaign page for viewers without push access: the viewer's next task
  as the one action card, every other open task as a list filtered by kind,
  and every piece as a table row that expands to its tasks. Rows only
  navigate — the actions live on the next-task card, the list rows and the
  task panel.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { login } from "$lib/auth.svelte.ts";
  import { readForge } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { LockRow, PieceRef, TaskRow } from "$lib/campaign-tables.ts";
  import { cardPill } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import { piecePreview } from "$lib/piece-previews.ts";
  import type { PagePreview, PiecePreview } from "$lib/piece-previews.ts";

  let {
    owner,
    repo,
    cards,
    nextCard,
    taskDefs,
    locks,
    viewer,
    pieces,
    progress,
    pieceIndex,
    busy,
    panelOpen,
    expandedPiece = $bindable(null),
    onact,
    onopen,
    onviewscore,
  }: {
    owner: string;
    repo: string;
    /** Every board card, in column order. */
    cards: BoardCard[];
    /** The first card the viewer can act on, or null. */
    nextCard: BoardCard | null;
    taskDefs: TaskRow[];
    locks: LockRow[];
    viewer: string;
    pieces: PieceRef[];
    /** Fragment path → tasks done / tasks total, for the piece rows. */
    progress: Map<string, { done: number; total: number }>;
    /** Task id → index into `pieces`, for grouping and tinting by piece. */
    pieceIndex: Map<string, number>;
    busy: boolean;
    /** A task panel is open beside the view. Its action is then the one solid
        button; the next-task card's action becomes an outline. */
    panelOpen: boolean;
    /** The piece row expanded to its task list; the comments panel follows it. */
    expandedPiece: string | null;
    /** Perform a card's action (claim, or open its detail). */
    onact: (card: BoardCard) => void;
    /** Open a task's panel. */
    onopen: (task: string) => void;
    /** Open the score on the piece at this index, optionally at a 0-based page. */
    onviewscore: (index: number, page?: number) => void;
  } = $props();

  const mine = (c: BoardCard) =>
    viewer !== "" &&
    locks.some((l) => l.task_id === c.task && l.user_id === viewer);
  /** Tasks anyone could pick up: open ones, and validations with a free slot. */
  const openCards = $derived(
    cards.filter(
      (c) =>
        c.task !== nextCard?.task &&
        !mine(c) &&
        (c.column === "ready" ||
          (c.column === "validation" && c.slots.some((s) => s.key === "open"))),
    ),
  );

  // The kind filters over the open-task list; a card's kind is the stage its
  // claim starts.
  type Kind = "enc" | "review" | "pre";
  const kindOf = (c: BoardCard): Kind =>
    c.column === "validation" ? "review" : c.pre ? "pre" : "enc";
  const KINDS: { key: Kind; label: string }[] = [
    { key: "enc", label: "Encoding" },
    { key: "review", label: "Review" },
    { key: "pre", label: "Preparation" },
  ];
  let kinds = $state<Record<Kind, boolean>>({ enc: true, review: true, pre: true });
  const listed = $derived(openCards.filter((c) => kinds[kindOf(c)]));
  /** Kinds present among the open tasks; the filters show only for those. */
  const presentKinds = $derived(new Set(openCards.map(kindOf)));

  const tintOf = (i: number) => `--piece-tint: var(--zone-${(i % 8) + 1})`;
  const pieceName = (p: PieceRef) => p.title || p.id;
  // A card title without its leading piece name, for rows under the piece.
  const partTitle = (title: string, piece: PieceRef) => {
    const prefix = `${pieceName(piece)} · `;
    return title.startsWith(prefix) ? title.slice(prefix.length) : title;
  };
  // A single-piece campaign keeps its one piece expanded.
  const lone = $derived(pieces.length === 1);

  const actLabel = (c: BoardCard): string => {
    if (viewer === "") return "Log in to claim";
    if (c.column === "ready")
      return c.locator === "score-setup"
        ? "Claim & open setup editor"
        : c.pre
          ? "Claim & open zone editor"
          : "Claim & open editor";
    if (c.column === "validation" && c.slots.some((s) => s.claimable))
      return "Claim to review";
    return "Open task";
  };
  // What the card's button does, for its tooltip.
  const actTitle = (c: BoardCard): string => {
    if (viewer === "") return "Log in with GitHub to claim this task.";
    if (c.column === "validation") return "Takes a review slot on this task.";
    if (c.pre) return "Claims this task for you and opens its editor.";
    return "Claims this section for you and opens mei-friend in a new tab.";
  };

  // The stage a claim starts, as the button's colour class.
  const stageClass = (c: BoardCard) =>
    c.column === "validation" ? "btn-review" : c.pre ? "btn-pre" : "btn-enc";

  const typeOf = (c: BoardCard) =>
    c.column === "validation" ? "validation" : c.typeLine.toLowerCase();

  const startPage = (c: BoardCard): number | null => {
    const m = /^surface-(\d+)$/.exec(c.locator);
    return m ? Number(m[1]) : null;
  };

  // First-page thumbnails, page crops and measure counts, loaded per piece.
  let previews = $state<Record<string, PiecePreview>>({});
  $effect(() => {
    const f = readForge();
    for (const piece of pieces) {
      const path = piece.path;
      if (previews[path]) continue;
      piecePreview(f, owner, repo, path).then((preview) => {
        previews[path] = preview;
      });
    }
  });

  const nextPiece = $derived(
    nextCard ? pieces[pieceIndex.get(nextCard.task) ?? 0] : undefined,
  );
  const nextPreview = $derived(nextPiece ? previews[nextPiece.path] : undefined);
  const nextPage = $derived(nextCard ? startPage(nextCard) : null);
  /** The next task's own page, when the piece has facsimile pages. */
  const nextPagePreview = $derived<PagePreview | undefined>(
    nextPreview?.pages[(nextPage ?? 1) - 1],
  );

  // The next-task card's context line: the task's kind (the title names the
  // piece and page), the page's size, and for an encoding section whose
  // preceding section is done, where it picks up.
  const nextContext = $derived.by(() => {
    if (!nextCard) return "";
    const parts = [typeOf(nextCard)];
    const measures = nextPage ? (nextPreview?.pageMeasures[nextPage - 1] ?? 0) : 0;
    if (measures) {
      const staves = nextPreview?.staves ?? 0;
      parts.push(
        `≈ ${measures} measures${staves ? `, ${staves} ${staves === 1 ? "staff" : "staves"}` : ""}`,
      );
    }
    const dep = findRow(taskDefs, nextCard.task, "")?.depends_on;
    const depCard = dep ? cards.find((c) => c.task === dep) : undefined;
    if (
      nextCard.column === "ready" &&
      !nextCard.pre &&
      depCard?.column === "done" &&
      !depCard.pre
    )
      parts.push("continues where the previous section ended");
    return parts.join(" · ");
  });

  // The crop box's width on screen, for placing the page image so that the
  // page's measures span it, read from their top: the box shows the first
  // systems of the task's page.
  let cropW = $state(0);
  const cropStyle = $derived.by(() => {
    const page = nextPagePreview;
    if (!page?.box || !page.width || !cropW) return "";
    const bw = page.box.lrx - page.box.ulx;
    if (bw <= 0) return "";
    const scale = cropW / bw;
    return `width:${page.width * scale}px;transform:translate(${-page.box.ulx * scale}px,${-page.box.uly * scale}px)`;
  });

  // The expanded piece's tasks: actionable ones first, then blocked, then
  // merged, keeping the board order within each group.
  const groupOrder: Record<string, number> = {
    ready: 0,
    encoding: 0,
    validation: 0,
    blocked: 1,
    done: 2,
  };
  const pieceTasks = (index: number) =>
    cards
      .filter((c) => (pieceIndex.get(c.task) ?? 0) === index)
      .toSorted((a, b) => groupOrder[a.column] - groupOrder[b.column]);
  // A piece's open work by stage: preparation and encoding tasks open to
  // claim, and reviews with a free slot.
  const stageCounts = (index: number) => {
    const counts = { pre: 0, enc: 0, review: 0 };
    for (const c of pieceTasks(index)) {
      if (c.column === "ready") counts[c.pre ? "pre" : "enc"]++;
      else if (c.column === "validation" && c.slots.some((s) => s.key === "open")) counts.review++;
    }
    return counts;
  };
  // Tasks in validation, for the piece bar's review segment.
  const reviewing = (index: number) =>
    pieceTasks(index).filter((c) => c.column === "validation").length;

  function toggle(path: string) {
    expandedPiece = expandedPiece === path ? null : path;
  }
</script>

{#snippet thumb(path: string)}
  {@const url = previews[path]?.thumb}
  <span class="paper">
    {#if url}
      <img src={url} alt="" loading="lazy" />
    {/if}
  </span>
{/snippet}

{#snippet chips(card: BoardCard)}
  {#if card.counts.fails > 0}
    <span class="chip chip-fail">{card.counts.fails} fail{card.counts.fails === 1 ? "" : "s"}</span>
  {/if}
  {#if card.counts.comments > 0}
    <span class="chip chip-note">{card.counts.comments} comment{card.counts.comments === 1 ? "" : "s"}</span>
  {/if}
  {#if card.counts.questions > 0}
    <span class="chip chip-question">{card.counts.questions} question{card.counts.questions === 1 ? "" : "s"}</span>
  {/if}
{/snippet}

<div class="volunteer">
  <div class="vcol">
    {#if nextCard}
      <div class="vsec">
        <h2 class="seclabel c-next">Your next task</h2>
        <!-- The title button's hit area covers the card; the action buttons
             sit above it. -->
        <div class="nextcard">
          <!-- The task's own page, cropped to its measures; a page without
               zones shows from its top; a piece without pages shows its
               opening system. -->
          <div class="crop" bind:clientWidth={cropW}>
            {#if nextPagePreview?.url}
              <img
                src={nextPagePreview.url}
                alt=""
                class:whole={!cropStyle}
                style={cropStyle}
              />
            {:else if nextPreview?.incipit}
              <div class="incipit">{@html nextPreview.incipit}</div>
            {/if}
            {#if nextPage}
              <span class="croplabel">p. {nextPage}</span>
            {/if}
          </div>
          <div class="nextbody">
            <button
              type="button"
              class="nexttitle"
              onclick={() => onopen(nextCard.task)}
              title="Open this task">{nextCard.title}</button
            >
            <span class="nextcontext">{nextContext}</span>
          </div>
          <div class="nextacts">
            <button
              type="button"
              class="btn btn-lg {stageClass(nextCard)}"
              class:btn-primary={!panelOpen}
              onclick={() => (viewer === "" ? login() : onact(nextCard))}
              disabled={busy}
              title={actTitle(nextCard)}>{actLabel(nextCard)}{#if actLabel(nextCard) === "Claim & open editor"}<Icon name="external" />{/if}</button
            >
            <button
              type="button"
              class="previewlink"
              onclick={() => {
                onviewscore(
                  pieceIndex.get(nextCard.task) ?? 0,
                  nextPage ? nextPage - 1 : undefined,
                );
              }}>Preview these pages first</button
            >
          </div>
        </div>
      </div>
    {/if}

    {#if openCards.length > 0}
      <div class="vsec">
        <div class="sechead">
          <h2 class="seclabel">
            Open tasks <span class="seccount">{openCards.length}</span>
          </h2>
          {#if presentKinds.size > 1}
            <span class="vspacer"></span>
            {#each KINDS.filter((k) => presentKinds.has(k.key)) as kind (kind.key)}
              <button
                type="button"
                class="chip-switch"
                class:on={kinds[kind.key]}
                aria-pressed={kinds[kind.key]}
                onclick={() => (kinds[kind.key] = !kinds[kind.key])}
                title="Show or hide {kind.label.toLowerCase()} tasks in the list"
                ><span class="sw"></span>{kind.label}</button
              >
            {/each}
          {/if}
        </div>
        <div class="tlist">
          {#each listed as card (card.task)}
            {@const index = pieceIndex.get(card.task) ?? 0}
            <div class="trow" style={tintOf(index)}>
              <span class="sdot"></span>
              <button
                type="button"
                class="stitle"
                onclick={() => onopen(card.task)}
                title="Open this task">{card.title}</button
              >
              <span class="stype">{typeOf(card)}</span>
              <span class="vspacer"></span>
              {@render chips(card)}
              {#if viewer !== ""}
                <button
                  type="button"
                  class="btn {stageClass(card)}"
                  onclick={() => onact(card)}
                  disabled={busy}>Claim</button
                >
              {/if}
            </div>
          {:else}
            <span class="none">No open tasks of these kinds.</span>
          {/each}
        </div>
      </div>
    {/if}

    {#if !nextCard && openCards.length === 0}
      <span class="none"
        >No tasks are open right now: every task is claimed, in review, waiting
        for an earlier task, or done.</span
      >
    {/if}

    {#if pieces.length > 0}
      <div class="vsec">
        <h2 class="seclabel c-pieces">Pieces</h2>
        <div class="ptable">
          {#each pieces as piece, index (piece.path)}
            {@const p = progress.get(piece.path)}
            {@const open = lone || expandedPiece === piece.path}
            {@const counts = stageCounts(index)}
            {@const review = reviewing(index)}
            <div class="piece" style={tintOf(index)}>
              <div class="prow">
                {@render thumb(piece.path)}
                {#if lone}
                  <span class="piecename">{pieceName(piece)}</span>
                {:else}
                  <button
                    type="button"
                    class="piecename"
                    aria-expanded={open}
                    onclick={() => toggle(piece.path)}
                    title={open ? "Collapse this piece" : "Show this piece's tasks"}
                    >{pieceName(piece)}</button
                  >
                {/if}
                <!-- Done, in review and the rest, in the stage colours. -->
                <div class="segbar">
                  {#if p?.done}
                    <div class="seg done" style="flex: {p.done}"></div>
                  {/if}
                  {#if review}
                    <div class="seg review" style="flex: {review}"></div>
                  {/if}
                  {#if p && p.total - p.done - review > 0}
                    <div class="seg" style="flex: {p.total - p.done - review}"></div>
                  {/if}
                </div>
                {#if p && p.total > 0 && p.done === p.total}
                  <span class="piecedone complete"><Icon name="check" size={12} /> complete</span>
                {:else}
                  <span class="piecedone">{p?.done ?? 0} of {p?.total ?? 0} done</span>
                {/if}
                {#if counts.enc > 0}
                  <span class="scount enc">{counts.enc} open</span>
                {/if}
                {#if counts.review > 0}
                  <span class="scount review">{counts.review} review{counts.review === 1 ? "" : "s"}</span>
                {/if}
                {#if counts.pre > 0}
                  <span class="scount pre">{counts.pre} preparation</span>
                {/if}
                <span class="vspacer"></span>
                <button
                  type="button"
                  class="btn"
                  onclick={() => onviewscore(index)}
                  title="Show every page of this piece's score, without opening a task."
                  >View score</button
                >
                {#if !lone}
                  <span class="pchev"><Icon name={open ? "chevron-down" : "chevron-right"} /></span>
                {/if}
              </div>
              {#if open}
                <div class="piecetasks">
                  {#each pieceTasks(index) as card (card.task)}
                    {#if card.column === "blocked" || card.column === "done"}
                      <div class="taskrow still">
                        <span class="tasktitle">{partTitle(card.title, piece)}</span>
                        <span class="ttype">{typeOf(card)}</span>
                        <span class="vspacer"></span>
                        {#if card.column === "done"}
                          <span class="merged"><Icon name="check" size={12} /> done</span>
                        {:else}
                          <span class="waits">waits for {partTitle(card.waitsFor, piece)}</span>
                        {/if}
                      </div>
                    {:else}
                      <div class="taskrow">
                        <button
                          type="button"
                          class="tasktitle"
                          onclick={() => onopen(card.task)}
                          title="Open this task">{partTitle(card.title, piece)}</button
                        >
                        <span class="ttype">{typeOf(card)}</span>
                        <span class="vspacer"></span>
                        {@render chips(card)}
                        {#if card.nextUp}
                          <span class="taskpill next">your next task</span>
                        {:else if card.column === "validation"}
                          <span class="taskpill review">review</span>
                        {:else}
                          <span class="taskpill">{cardPill(card, viewer)}</span>
                        {/if}
                        <span class="tchev"><Icon name="chevron-right" /></span>
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .volunteer {
    /* The column takes what the host's group leaves beside the comments
       panel (800px without one). It is the container for the narrow layout
       below. */
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    container-type: inline-size;
    min-height: 0;
    overflow-y: auto;
    /* Room for the scrollbar beside the content, not over its right edge. */
    scrollbar-gutter: stable;
    padding-right: 10px;
    box-sizing: border-box;
  }
  .vcol {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 8px;
  }
  .vspacer {
    flex: 1;
  }

  .vsec {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sechead {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .seclabel {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .seclabel.c-next {
    color: var(--info);
  }
  .seclabel.c-pieces {
    color: var(--ok);
  }
  .seccount {
    font-size: 11px;
    font-weight: 600;
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 1px 7px;
    letter-spacing: 0;
  }

  /* A row's title button reaches over the whole row; the row's other buttons
     and pills sit above it. The focus ring is drawn on the row. */
  :where(.nexttitle, .stitle, button.piecename, .tasktitle) {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .nexttitle::after,
  .stitle::after,
  button.piecename::after,
  .tasktitle::after {
    content: "";
    position: absolute;
    inset: 0;
  }
  .nexttitle:focus-visible,
  .stitle:focus-visible,
  button.piecename:focus-visible,
  .tasktitle:focus-visible {
    outline: none;
  }
  .nextcard:has(.nexttitle:focus-visible),
  .trow:has(.stitle:focus-visible),
  .prow:has(.piecename:focus-visible),
  .taskrow:has(.tasktitle:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .nextcard .btn,
  .previewlink,
  .trow .btn,
  .prow .btn,
  .scount {
    position: relative;
    z-index: 1;
  }

  /* ------------------------------------------------------- next-task card */
  .nextcard {
    position: relative;
    display: flex;
    align-items: center;
    gap: 18px;
    background: var(--card);
    border: 1.5px solid var(--info-line);
    border-radius: 14px;
    padding: 18px 22px;
    box-shadow: var(--shadow-md);
    transition: border-color 0.15s ease;
  }
  .nextcard:hover {
    border-color: var(--accent);
  }
  .crop {
    position: relative;
    flex: none;
    width: 260px;
    height: 144px;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    background: var(--facsimile-paper);
    box-shadow:
      4px 4px 0 var(--mat),
      var(--shadow-md);
  }
  .crop img {
    display: block;
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  }
  /* A page without a measure box: the page from its top edge. */
  .crop img.whole {
    position: static;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top;
  }
  .incipit {
    height: 100%;
    display: flex;
    align-items: center;
    padding: 8px;
    box-sizing: border-box;
  }
  .incipit :global(svg) {
    width: 100%;
    height: auto;
    max-height: 100%;
  }
  .croplabel {
    position: absolute;
    left: 8px;
    bottom: 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 2px 8px;
  }
  .nextbody {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    flex: 1;
  }
  .nexttitle {
    font-size: 17px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .nextcontext {
    font-size: 13px;
    color: var(--ink-soft);
  }
  .nextacts {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    flex: none;
  }
  .previewlink {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    font: 600 12px var(--font);
    color: var(--info);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }

  /* ------------------------------------------------------- open-task list */
  .tlist {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .trow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 12px;
    transition: background-color 0.15s ease;
  }
  .trow + .trow {
    border-top: 1px solid var(--line);
  }
  .trow:hover {
    background: var(--accent-tint);
  }
  .sdot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--piece-tint);
  }
  .stitle {
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .stype {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .trow .chip,
  .taskrow .chip {
    padding: 2px 8px;
  }
  .tlist .none {
    display: block;
    padding: 10px 12px;
  }

  .none {
    font-size: 12px;
    color: var(--ink-faint);
  }

  /* --------------------------------------------------------- pieces table */
  .ptable {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .piece + .piece {
    border-top: 1px solid var(--line);
  }
  .prow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    background: color-mix(in srgb, var(--piece-tint) 6%, var(--card));
    padding: 9px 12px;
  }
  .paper {
    flex: none;
    width: 32px;
    height: 42px;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
    box-sizing: border-box;
    box-shadow: var(--shadow-sm);
  }
  .paper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .piecename {
    font-size: 13px;
    font-weight: 600;
    flex: none;
    width: 230px;
    overflow-wrap: anywhere;
  }
  .segbar {
    flex: none;
    display: flex;
    gap: 2px;
    width: 120px;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    overflow: hidden;
  }
  .seg.done {
    background: var(--green);
  }
  .seg.review {
    background: var(--warn-line);
  }
  .piecedone {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
    width: 78px;
  }
  .piecedone.complete {
    color: var(--ok);
    font-weight: 600;
  }
  /* Open work per stage, in the stage colours. */
  .scount {
    font-size: 11px;
    font-weight: 600;
    border-radius: 999px;
    padding: 1px 8px;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .scount.pre {
    color: var(--pre);
    background: var(--pre-wash);
    border-color: var(--pre);
  }
  .scount.review {
    color: var(--warn);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .scount.enc {
    color: var(--info);
    background: var(--info-bg);
    border-color: var(--info-line);
  }
  .pchev {
    font-size: 20px;
    line-height: 1;
    width: 20px;
    text-align: center;
    color: var(--ink-soft);
  }
  .piecetasks {
    padding: 8px 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid color-mix(in srgb, var(--piece-tint) 25%, var(--line));
  }
  .taskrow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    transition: border-color 0.15s ease;
  }
  .taskrow:not(.still):hover {
    border-color: var(--accent);
  }
  .taskrow.still {
    opacity: 0.75;
  }
  .tasktitle {
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .ttype {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .taskrow.still .tasktitle {
    color: var(--ink-soft);
  }
  .taskpill {
    font-weight: 600;
    font-size: 11px;
    padding: 2px 9px;
    border-radius: 999px;
    white-space: nowrap;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
  }
  .taskpill.next {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .taskpill.review {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .merged {
    font-size: 12px;
    color: var(--ok);
    font-weight: 600;
    white-space: nowrap;
  }
  .waits {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .tchev {
    font-size: 14px;
    color: var(--ink-faint);
  }

  /* Narrow column: the next-task card puts its actions on a full-width line
     under the crop and text, and every row wraps its meta and controls onto
     a second line. */
  @container (max-width: 640px) {
    .nextcard {
      flex-wrap: wrap;
      gap: 14px;
      padding: 14px 16px;
    }
    .crop {
      width: 100%;
      height: 120px;
    }
    .nextbody {
      flex: 1 1 160px;
    }
    .nextacts {
      flex-basis: 100%;
      align-items: stretch;
    }
    .sechead {
      flex-wrap: wrap;
    }
    .trow,
    .prow,
    .taskrow {
      flex-wrap: wrap;
    }
    .trow .vspacer,
    .prow .vspacer {
      display: none;
    }
    .stitle {
      flex: 1;
    }
    .stype,
    .trow .chip {
      order: 2;
      white-space: normal;
    }
    .stype {
      flex-basis: 100%;
      padding-left: 20px;
    }
    /* The name holds the first line (with the chevron); the bar, count and
       button wrap below it. */
    .piecename {
      flex: 1 0 60%;
      width: auto;
      min-width: 0;
    }
    .pchev {
      order: 1;
    }
    .segbar,
    .piecedone,
    .scount,
    .prow .btn {
      order: 2;
    }
    .segbar {
      flex: 1 1 80px;
    }
    .piecedone {
      width: auto;
    }
    .tasktitle {
      flex-basis: 100%;
    }
    .ttype {
      white-space: normal;
    }
  }
  /* The host stacks the comments panel under this column below 700px of its
     own width (the campaign page's .viewcol) and scrolls the whole view; the
     column then stops scrolling on its own. Both values are the host's. */
  @container (max-width: 700px) {
    .volunteer {
      flex: none;
      overflow-y: visible;
      scrollbar-gutter: auto;
      padding-right: 0;
    }
  }
</style>
