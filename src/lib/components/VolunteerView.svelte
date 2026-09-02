<!--
  The campaign page for viewers without push access: the campaign title with
  its progress, the viewer's next task as the one action card, three other
  open tasks to pick instead, and every piece as an expandable row listing its
  tasks. Task rows only navigate — the actions live on the next-task card, the
  suggestion rows and the task panel.
-->
<script lang="ts">
  import { readForge } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { LockRow, PieceRef, TaskRow } from "$lib/campaign-tables.ts";
  import { cardPill } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import { piecePreview } from "$lib/piece-previews.ts";
  import type { PiecePreview } from "$lib/piece-previews.ts";

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
  const suggestions = $derived(openCards.slice(0, 3));

  const tintOf = (i: number) => `--piece-tint: var(--zone-${(i % 8) + 1})`;
  const pieceName = (p: PieceRef) => p.title || p.id;
  // A single-piece campaign keeps its one piece expanded, with a larger cover.
  const lone = $derived(pieces.length === 1);

  const actLabel = (c: BoardCard): string => {
    if (c.column === "ready")
      return c.locator === "score-setup"
        ? "Claim & open setup editor"
        : c.pre
          ? "Claim & open zone editor"
          : "Claim & open editor ↗";
    if (c.column === "validation" && c.slots.some((s) => s.claimable))
      return "Claim to review";
    return "Open task";
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

  // The next-task card's context line: the piece and page, plus where the
  // task picks up when the task it builds on is already merged.
  const nextContext = $derived.by(() => {
    if (!nextCard) return "";
    const piece = pieces[pieceIndex.get(nextCard.task) ?? 0];
    const page = startPage(nextCard);
    const parts = [piece ? pieceName(piece) : "", page ? `p. ${page}` : typeOf(nextCard)];
    const dep = findRow(taskDefs, nextCard.task, "")?.depends_on;
    if (dep && cards.find((c) => c.task === dep)?.column === "done")
      parts.push("continues where the last merged section ended");
    return parts.filter(Boolean).join(" · ");
  });

  // First-page thumbnails and per-page measure counts, loaded per piece.
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

  const nextEffort = $derived.by(() => {
    if (!nextCard) return "";
    const piece = pieces[pieceIndex.get(nextCard.task) ?? 0];
    const page = startPage(nextCard);
    if (!piece || !page) return "";
    const preview = previews[piece.path];
    const measures = preview?.pageMeasures[page - 1] ?? 0;
    if (!measures) return "";
    const staves = preview.staves;
    return `≈ ${measures} measures${staves ? `, ${staves} ${staves === 1 ? "staff" : "staves"}` : ""} — most sections take under an hour`;
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

  function toggle(path: string) {
    expandedPiece = expandedPiece === path ? null : path;
  }
</script>

{#snippet thumb(path: string, cls: string)}
  {@const url = previews[path]?.thumb}
  <span class="paper {cls}">
    {#if url}
      <img src={url} alt="" loading="lazy" />
    {/if}
  </span>
{/snippet}

<div class="volunteer">
  <div class="vcol">
    {#if nextCard}
      <div class="vsec">
        <span class="seclabel c-next">Your next task</span>
        <!-- A focusable div, not a <button>: the action button sits inside it. -->
        <div
          class="nextcard"
          role="button"
          tabindex="0"
          onclick={() => onopen(nextCard.task)}
          onkeydown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onopen(nextCard.task);
            }
          }}
          title="Open this task"
        >
          {@render thumb(
            pieces[pieceIndex.get(nextCard.task) ?? 0]?.path ?? "",
            "big",
          )}
          <div class="nextbody">
            <span class="nexttitle">{nextCard.title}</span>
            <span class="nextcontext">{nextContext}</span>
            {#if nextEffort}
              <span class="nexteffort">{nextEffort}</span>
            {/if}
          </div>
          <span class="vspacer"></span>
          <div class="nextacts">
            <button
              type="button"
              class="btn btn-lg btn-primary {stageClass(nextCard)}"
              onclick={(e) => {
                e.stopPropagation();
                onact(nextCard);
              }}
              disabled={busy || viewer === ""}
              title={viewer === ""
                ? "Log in to claim a task."
                : "The first task that is open for you."}>{actLabel(nextCard)}</button
            >
            <button
              type="button"
              class="previewlink"
              onclick={(e) => {
                e.stopPropagation();
                const page = startPage(nextCard);
                onviewscore(
                  pieceIndex.get(nextCard.task) ?? 0,
                  page ? page - 1 : undefined,
                );
              }}>Preview these pages first</button
            >
          </div>
        </div>
      </div>
    {/if}

    {#if suggestions.length > 0}
      <div class="vsec">
        <span class="seclabel"
          >Or pick another <span class="seccount">{suggestions.length}</span
          ></span
        >
        {#each suggestions as card (card.task)}
          {@const index = pieceIndex.get(card.task) ?? 0}
          <div
            class="suggestion"
            style={tintOf(index)}
            role="button"
            tabindex="0"
            onclick={() => onopen(card.task)}
            onkeydown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onopen(card.task);
              }
            }}
            title="Open this task"
          >
            <span class="sdot"></span>
            <span class="stitle">{card.title}</span>
            <span class="stype"
              >{pieces[index] ? pieceName(pieces[index]) : ""} · {typeOf(
                card,
              )}</span
            >
            <span class="vspacer"></span>
            <button
              type="button"
              class="btn {stageClass(card)}"
              onclick={(e) => {
                e.stopPropagation();
                onact(card);
              }}
              disabled={busy || viewer === ""}
              title={viewer === "" ? "Log in to claim a task." : undefined}
              >Claim</button
            >
          </div>
        {/each}
      </div>
    {/if}

    {#if !nextCard && suggestions.length === 0}
      <span class="none">No tasks are open for you right now.</span>
    {/if}

    {#if pieces.length > 0}
      <div class="vsec">
        <span class="seclabel c-pieces">Pieces</span>
        {#each pieces as piece, index (piece.path)}
          {@const p = progress.get(piece.path)}
          {@const open = lone || expandedPiece === piece.path}
          {#snippet piecehead()}
            {@render thumb(piece.path, lone ? "mid" : "small")}
            <span class="piecename">{pieceName(piece)}</span>
            <div class="piecebar">
              <div
                style={`width:${p?.total ? Math.round((p.done / p.total) * 100) : 0}%`}
              ></div>
            </div>
            {#if p && p.total > 0 && p.done === p.total}
              <span class="piecedone complete">✓ complete</span>
            {:else}
              <span class="piecedone">{p?.done ?? 0} of {p?.total ?? 0} done</span>
            {/if}
            <span class="vspacer"></span>
            <button
              type="button"
              class="btn"
              onclick={(e) => {
                e.stopPropagation();
                onviewscore(index);
              }}
              title="Show every page of this piece's score, without opening a task."
              >View score</button
            >
          {/snippet}
          <div class="piece" class:open style={tintOf(index)}>
            {#if lone}
              <div class="piecerow lone">
                {@render piecehead()}
              </div>
            {:else}
              <div
                class="piecerow"
                role="button"
                tabindex="0"
                onclick={() => toggle(piece.path)}
                onkeydown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(piece.path);
                  }
                }}
                title={open ? "Collapse this piece" : "Show this piece's tasks"}
              >
                {@render piecehead()}
                <span class="pchev">{open ? "▾" : "▸"}</span>
              </div>
            {/if}
            {#if open}
              <div class="piecetasks">
                {#each pieceTasks(index) as card (card.task)}
                  {#if card.column === "blocked" || card.column === "done"}
                    <div class="taskrow still">
                      <span class="tasktitle">{card.title}</span>
                      <span class="ttype">{typeOf(card)}</span>
                      <span class="vspacer"></span>
                      {#if card.column === "done"}
                        <span class="merged">✓ merged</span>
                      {:else}
                        <span class="taskpill">not ready yet</span>
                      {/if}
                    </div>
                  {:else}
                    <div
                      class="taskrow"
                      role="button"
                      tabindex="0"
                      onclick={() => onopen(card.task)}
                      onkeydown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onopen(card.task);
                        }
                      }}
                      title="Open this task"
                    >
                      <span class="tasktitle">{card.title}</span>
                      <span class="ttype">{typeOf(card)}</span>
                      <span class="vspacer"></span>
                      {#if card.nextUp}
                        <span class="taskpill next">your next task</span>
                      {:else if card.column === "validation"}
                        <span class="taskpill review">review</span>
                      {:else}
                        <span class="taskpill">{cardPill(card, viewer)}</span>
                      {/if}
                      <span class="tchev">›</span>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .volunteer {
    /* A fixed reading width: the host centres the column together with the
       comments panel as one group. */
    flex: none;
    width: min(800px, 100%);
    min-height: 0;
    overflow-y: auto;
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
  .seclabel {
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

  .paper {
    flex: none;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
    box-sizing: border-box;
  }
  .paper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .paper.big {
    width: 156px;
    height: 208px;
    border-radius: 3px;
    box-shadow:
      4px 4px 0 var(--mat),
      var(--shadow-md);
  }
  .paper.mid {
    width: 64px;
    height: 85px;
    box-shadow: var(--shadow-sm);
  }
  .paper.small {
    width: 44px;
    height: 58px;
    box-shadow: var(--shadow-sm);
  }

  .nextcard {
    display: flex;
    align-items: center;
    gap: 22px;
    background: var(--card);
    border: 1.5px solid var(--info-line);
    border-radius: 14px;
    padding: 18px 22px;
    box-shadow: var(--shadow-md);
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  .nextcard:hover {
    border-color: var(--accent);
  }
  .nextbody {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
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
  .nexteffort {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .nextacts {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    flex: none;
  }
  .previewlink {
    font: 600 12px var(--font);
    color: var(--info);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }

  .suggestion {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 14px;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  .suggestion:hover {
    border-color: var(--accent);
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
    font-size: 11.5px;
    color: var(--ink-faint);
    white-space: nowrap;
  }

  .none {
    font-size: 12px;
    color: var(--ink-faint);
  }

  .piece {
    border: 1px solid color-mix(in srgb, var(--piece-tint) 40%, var(--line));
    border-radius: 10px;
    background: var(--card);
    overflow: hidden;
  }
  .piecerow {
    display: flex;
    align-items: center;
    gap: 12px;
    background: color-mix(in srgb, var(--piece-tint) 8%, var(--card));
    padding: 10px 14px;
    cursor: pointer;
  }
  .piecerow.lone {
    cursor: default;
  }
  .piecename {
    font-size: 13px;
    font-weight: 600;
    flex: none;
  }
  .piecebar {
    flex: 1;
    max-width: 280px;
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--piece-tint) 22%, var(--card));
    overflow: hidden;
  }
  .piecebar > div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .piecedone {
    font-size: 11.5px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .piecedone.complete {
    color: var(--ok);
    font-weight: 600;
  }
  .pchev {
    font-size: 14px;
    color: var(--ink-faint);
    margin-left: 8px;
  }
  .piecetasks {
    padding: 8px 14px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid color-mix(in srgb, var(--piece-tint) 25%, var(--line));
  }
  .taskrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s ease;
  }
  .taskrow:not(.still):hover {
    border-color: var(--accent);
  }
  .taskrow.still {
    opacity: 0.75;
    cursor: default;
  }
  .tasktitle {
    font-size: 12.5px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .ttype {
    font-size: 11.5px;
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
    font-size: 11.5px;
    color: var(--ok);
    font-weight: 600;
    white-space: nowrap;
  }
  .tchev {
    font-size: 14px;
    color: var(--ink-faint);
  }
</style>
