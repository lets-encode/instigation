<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { auth, login, forge } from "$lib/auth.svelte.ts";
  import { CommandRunner, readForge, viewerId } from "$lib/command-runner.svelte.ts";
  import { meiFriendUrl } from "$lib/forge/config.ts";
  import type { ForgeClient } from "$lib/forge/types.ts";
  import { lookupSlug, resolveCampaign, resolveFailureMessage } from "$lib/campaign-resolve.ts";
  import type { ResolvedCampaign } from "$lib/campaign-resolve.ts";
  import { findRow, pieceNamesOf } from "$lib/campaign-tables.ts";
  import type {
    TaskRow,
    StateRow,
    LockRow,
    HistoryRow,
    CommentRow,
    PieceRef,
  } from "$lib/campaign-tables.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result, FailComment } from "$lib/commands.ts";
  import { handle, isPreTask, preTaskRoute } from "$lib/campaign-graph.ts";
  import { buildBoard, elapsed, initialOf } from "$lib/campaign-board.ts";
  import type { BoardCard, ColumnKey } from "$lib/campaign-board.ts";
  import { parseMeiHeader } from "$lib/mei-header.ts";
  import type { MeiHeader } from "$lib/mei-header.ts";
  import {
    readSidePanel,
    writeSidePanel,
    readLastTask,
    writeLastTask,
  } from "$lib/side-panels.ts";
  import { piecePreview } from "$lib/piece-previews.ts";
  import type { PiecePreview } from "$lib/piece-previews.ts";
  import CommentsPanel from "$lib/components/CommentsPanel.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import PanelIcon from "$lib/components/PanelIcon.svelte";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import PieceRail from "$lib/components/PieceRail.svelte";
  import PlanEditor from "$lib/components/PlanEditor.svelte";
  import ScoreView from "$lib/components/ScoreView.svelte";
  import TaskRunState from "$lib/components/TaskRunState.svelte";
  import TaskSidePanel from "$lib/components/TaskSidePanel.svelte";
  import VolunteerView from "$lib/components/VolunteerView.svelte";

  // The URL carries only the campaign name; the repo it addresses is resolved
  // from it (name → stable repo id → current owner/name) — see resolveCampaign.
  const campaign = $derived(page.params.campaign!);
  let resolved = $state<ResolvedCampaign | null>(null);
  let resolving = $state(false);
  let notFound = $state(false);
  // The forge lookup of the registry's repo id failed (e.g. rate limit) — the
  // campaign exists but could not be loaded, which is not a "not found".
  let resolveError = $state<string | null>(null);
  // A name that is not (yet) a campaign: held by a setup in progress, reserved
  // for the app's own routes, or blocked. A free name never renders here — it
  // forwards to the wizard.
  let slugState = $state<"pending" | "reserved" | "tombstoned" | null>(null);
  const owner = $derived(resolved?.owner ?? "");
  const repo = $derived(resolved?.repo ?? "");
  const repoId = $derived(resolved?.repoId ?? 0);
  // The acting user's stable numeric id (written to the tables); login is display-only.
  const viewer = $derived(viewerId());

  let loading = $state(false);
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let notInitialised = $state(false);
  let isPrivate = $state(false);
  let canPush = $state(false);
  let taskDefs = $state<TaskRow[]>([]);
  let rows = $state<StateRow[]>([]);
  let validationColumns = $state<string[]>([]);
  let locks = $state<LockRow[]>([]);
  let history = $state<HistoryRow[]>([]);
  let comments = $state<CommentRow[]>([]);
  let pieces = $state<PieceRef[]>([]);
  // Numeric user id → login, for displaying the people the tables reference.
  let logins = $state<Record<string, string>>({});
  let title = $state("");
  let description = $state("");
  let license = $state("");
  let passThreshold = $state(1);
  let allowSelfValidation = $state(false);

  const runner = new CommandRunner();

  // UI-only state — the board, with the owner's manage takeover and the score
  // view (?score=) over it, plus the task panel when ?task= is present.
  // Everything else derives from the tracking tables.
  let manage = $state(false);
  let showInfo = $state(false);
  // The in-page task panel's width; its open state follows ?task=.
  let taskPanel = $state(readSidePanel("task"));
  // The two side panels share one width (side-panels.ts); mirroring the live
  // objects keeps a drag on either panel in step within the session. Writing
  // an unchanged width does not re-trigger the effects.
  $effect(() => {
    taskPanel.width = commentsPanel.width;
  });
  $effect(() => {
    commentsPanel.width = taskPanel.width;
  });
  // The scores a viewer can read end to end: the pieces the tasks address,
  // named from the campaign's config where it names them.
  const previewPieces = $derived.by(() => {
    const paths = [
      ...new Set(
        taskDefs
          .filter((t) => t.subtask_id === "" && t.fragment)
          .map((t) => t.fragment),
      ),
    ];
    return paths.map((path) => {
      const piece = pieces.find((p) => p.path === path);
      return { id: piece?.id ?? path, path, title: piece?.title ?? "" };
    });
  });
  // The stats bar's board filter: every task, or only those someone can act
  // on right now — claimable encodings and validations with a free slot.
  let boardScope = $state<"all" | "open">("all");
  const actionable = (c: BoardCard) =>
    c.column === "ready" ||
    (c.column === "validation" && c.slots.some((s) => s.key === "open"));

  // The score's <meiHead> fields, fetched on first open of the info panel.
  let scoreHead = $state<MeiHeader | null>(null);
  let scoreHeadState = $state<"idle" | "loading" | "done" | "error">("idle");
  async function loadScoreHead() {
    if (scoreHeadState !== "idle") return;
    scoreHeadState = "loading";
    try {
      const f = readForge();
      // The first task's fragment is the piece the campaign opens on.
      const mei = taskDefs[0]?.fragment
        ? await f.getRepoFile(owner, repo, taskDefs[0].fragment)
        : null;
      scoreHead = mei ? parseMeiHeader(mei) : null;
      scoreHeadState = mei ? "done" : "error";
    } catch {
      scoreHeadState = "error";
    }
  }

  // Everyone the campaign history records as having acted on the score.
  const workedOn = $derived(
    [...new Set(history.map((h) => h.user_id))].filter(Boolean),
  );

  const graphData = $derived({
    taskDefs,
    rows,
    validationColumns,
    locks,
    passThreshold,
    allowSelfValidation,
  });
  const pieceNames = $derived(pieceNamesOf(pieces));
  const board = $derived(
    buildBoard(graphData, comments, history, viewer, logins, pieceNames),
  );
  const allCards = $derived(board.columns.flatMap((c) => c.cards));
  // Per-piece task progress, for the piece tiles.
  const pieceProgress = $derived.by(() => {
    const by = new Map<string, { done: number; total: number }>();
    for (const card of allCards) {
      const fragment = findRow(taskDefs, card.task, "")?.fragment ?? "";
      if (!fragment) continue;
      const p = by.get(fragment) ?? { done: 0, total: 0 };
      p.total++;
      if (card.column === "done") p.done++;
      by.set(fragment, p);
    }
    return by;
  });
  // Task id → index into previewPieces, for grouping and tinting by piece.
  const pieceIndexByTask = $derived.by(() => {
    const index = new Map(previewPieces.map((p, i) => [p.path, i]));
    const by = new Map<string, number>();
    for (const t of taskDefs)
      if (t.subtask_id === "") by.set(t.task_id, index.get(t.fragment) ?? 0);
    return by;
  });
  // Tasks with unresolved fails or open comments/questions, behind the hero's
  // attention count.
  const attentionCards = $derived(
    allCards.filter(
      (c) =>
        c.column !== "done" &&
        c.counts.fails + c.counts.comments + c.counts.questions > 0,
    ),
  );
  let showAttention = $state(false);
  // ---------------------------------------------- the instigator piece rail
  // The piece the board is scoped to, or "all" for the full board.
  let selectedPiece = $state<"all" | string>("all");
  const attentionByPiece = $derived.by(() => {
    const by = new Map<string, number>();
    for (const c of attentionCards) {
      const path = previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path;
      if (!path) continue;
      by.set(
        path,
        (by.get(path) ?? 0) +
          c.counts.fails +
          c.counts.comments +
          c.counts.questions,
      );
    }
    return by;
  });
  // Tasks per board category for each piece, shown on its rail row. Ready and
  // blocked share the board's Open column.
  const railCounts = $derived.by(() => {
    const by = new Map<
      string,
      { open: number; encoding: number; validation: number }
    >();
    for (const c of allCards) {
      if (c.column === "done") continue;
      const path = previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path;
      if (!path) continue;
      const n = by.get(path) ?? { open: 0, encoding: 0, validation: 0 };
      if (c.column === "encoding") n.encoding++;
      else if (c.column === "validation") n.validation++;
      else n.open++;
      by.set(path, n);
    }
    return by;
  });
  const railPiece = $derived.by(() => {
    const index = previewPieces.findIndex((p) => p.path === selectedPiece);
    return index >= 0 ? { piece: previewPieces[index], index } : null;
  });
  // The scoped piece's preview, for the context strip over the columns.
  let stripPreview = $state<PiecePreview | null>(null);
  $effect(() => {
    const piece = railPiece?.piece;
    stripPreview = null;
    if (!piece || !owner) return;
    const path = piece.path;
    piecePreview(readForge(), owner, repo, path).then((preview) => {
      if (railPiece?.piece.path === path) stripPreview = preview;
    });
  });
  // Tasks the viewer's accepted submissions just moved on this campaign's
  // board, highlighted in their new column for a short while.
  const recentlyFinished = $derived(
    new Set(
      pendingVerdicts.recentlyFinished
        .filter((m) => m.repoId === repoId)
        .map((m) => m.task),
    ),
  );
  const nextCard = $derived(
    board.nextUp
      ? (allCards.find((c) => c.task === board.nextUp) ?? null)
      : null,
  );

  // ------------------------------------------------ the volunteer's header
  // Everyone the history records, resolved to display handles, first seen
  // first — the header's avatar row and contributor count.
  const volContributors = $derived.by(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const h of history) {
      if (!h.user_id || seen.has(h.user_id)) continue;
      seen.add(h.user_id);
      names.push(handle(logins, h.user_id));
    }
    return names;
  });
  // The task merged last — the done column reads newest first.
  const lastMerged = $derived(
    board.columns.find((c) => c.key === "done")?.cards[0] ?? null,
  );
  // One header cell per task, in plan order: its board column drives the
  // cell's fill (done / in validation / open). Rendered up to 48 tasks; larger
  // campaigns keep the plain bar.
  const mosaic = $derived(
    taskDefs
      .filter((t) => t.subtask_id === "")
      .map(
        (t) => allCards.find((c) => c.task === t.task_id)?.column ?? "ready",
      ),
  );

  // ----------------------------------------- the volunteer's comments panel
  let commentsPanel = $state(readSidePanel("comments"));
  // The piece row the volunteer expanded; the comments panel follows it, and
  // falls back to the next task's piece.
  let volunteerPiece = $state<string | null>(null);
  const volunteerScope = $derived.by(() => {
    const path =
      volunteerPiece ??
      (nextCard
        ? previewPieces[pieceIndexByTask.get(nextCard.task) ?? 0]?.path
        : undefined) ??
      previewPieces[0]?.path;
    const index = previewPieces.findIndex((p) => p.path === path);
    return index >= 0 ? { piece: previewPieces[index], index } : null;
  });
  const scopeCards = $derived(
    volunteerScope
      ? allCards.filter(
          (c) => (pieceIndexByTask.get(c.task) ?? 0) === volunteerScope.index,
        )
      : [],
  );

  // --------------------------------------------------------- the task detail
  // A task's detail opens in the preview panel; the URL carries it as ?task=
  // so the row stays addressable (deep links, post-login resume).
  let detailTask = $state<string | null>(null);
  const detailCard = $derived(
    detailTask ? (allCards.find((c) => c.task === detailTask) ?? null) : null,
  );
  function openTask(task: string) {
    detailTask = task;
    writeLastTask(campaign, task);
    goto(`/${campaign}?task=${encodeURIComponent(task)}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }
  // Close the task panel.
  function closeTask() {
    detailTask = null;
    writeLastTask(campaign, null);
    goto(`/${campaign}`, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // -------------------------------------------------------- the score view
  // The full-page score view is addressed by ?score=<piece path> (and an
  // optional 1-based ?page=), read reactively so back/forward navigate it.
  const scoreView = $derived.by(() => {
    const path = page.url.searchParams.get("score");
    if (!path) return null;
    const index = previewPieces.findIndex((p) => p.path === path);
    return index >= 0 ? { piece: previewPieces[index], index } : null;
  });
  const scoreStartPage = $derived(
    Math.max(0, (Number(page.url.searchParams.get("page")) || 1) - 1),
  );
  const scoreCards = $derived(
    scoreView
      ? allCards.filter(
          (c) => (pieceIndexByTask.get(c.task) ?? 0) === scoreView.index,
        )
      : [],
  );
  // The measure range the score view opens highlighted (from a comment
  // anchor); within the view, anchors work without navigation.
  let anchor = $state<{ page: number; m1: number; m2: number } | null>(null);
  // The open task's ?task= survives entering and leaving the score view.
  function openScoreView(
    path: string,
    startPage?: number,
    a: { page: number; m1: number; m2: number } | null = null,
  ) {
    anchor = a;
    const query = new URLSearchParams();
    if (detailTask) query.set("task", detailTask);
    query.set("score", path);
    if (startPage) query.set("page", String(startPage + 1));
    goto(`/${campaign}?${query}`, { noScroll: true, keepFocus: true });
  }
  function closeScoreView() {
    goto(
      `/${campaign}${detailTask ? `?task=${encodeURIComponent(detailTask)}` : ""}`,
      { noScroll: true, keepFocus: true },
    );
  }
  function viewScorePiece(index: number, startPage?: number) {
    const path = previewPieces[index]?.path;
    if (path) openScoreView(path, startPage);
  }
  // A task's score view opens at its page when the task covers one surface.
  const cardPage = (card: BoardCard) =>
    /^surface-(\d+)$/.exec(card.locator)?.[1] ?? "";
  function viewCardScore(card: BoardCard) {
    const page = cardPage(card);
    viewScorePiece(
      pieceIndexByTask.get(card.task) ?? 0,
      page ? Number(page) - 1 : undefined,
    );
  }
  // A comment anchor outside the score view: open it on the comment's piece,
  // at the anchored page, with the range highlighted.
  function showCommentInScore(c: CommentRow) {
    const index = pieceIndexByTask.get(c.task_id);
    const path = previewPieces[index ?? -1]?.path;
    if (!path) return;
    const m1 = Number(c.measure_start);
    const m2 = Number(c.measure_end || c.measure_start);
    openScoreView(path, c.page ? Number(c.page) - 1 : undefined, {
      page: Number(c.page),
      m1: Number.isFinite(m1) ? m1 : 0,
      m2: Number.isFinite(m2) ? m2 : 0,
    });
  }

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});

  // The context every command runs against; progress updates feed the busy
  // overlay's step log.
  const ctx = (f: ForgeClient): CommandContext =>
    runner.context(f, { repoId, owner, repo }, { meiFriendUrl });

  // Read the tracking tables (and privacy/config) for the console. Only the
  // first read shows the loading state; refreshes update the tables in place.
  async function load() {
    const f = readForge();
    // Tables for a name the page has since navigated away from are dropped.
    const name = campaign;
    if (!loaded) loading = true;
    loadError = null;
    try {
      const tables = await invoke(commands.readTables, {}, ctx(f));
      if (name !== campaign) return;
      notInitialised = tables.notInitialised;
      isPrivate = tables.isPrivate;
      canPush = tables.canPush;
      taskDefs = tables.taskDefs;
      rows = tables.rows;
      validationColumns = tables.validationColumns;
      locks = tables.locks;
      history = tables.history;
      comments = tables.comments;
      pieces = tables.pieces;
      logins = tables.logins;
      title = tables.title;
      description = tables.description;
      license = tables.license;
      passThreshold = tables.passThreshold;
      allowSelfValidation = tables.allowSelfValidation;
      if (!notInitialised) {
        console.log(
          "[load] tables loaded:",
          taskDefs.length,
          "task(s),",
          rows.length,
          "state row(s),",
          locks.length,
          "lock(s),",
          comments.length,
          "comment(s)",
        );
      }
      loaded = true;
    } catch (e) {
      if (name === campaign)
        loadError = `Could not read ${owner}/${repo}: ${(e as Error).message}`;
    } finally {
      if (name === campaign) loading = false;
    }
  }

  // A same-route navigation to another campaign starts over: the resolved
  // repo and the loaded tables belong to the previous name.
  $effect(() => {
    void campaign;
    resolved = null;
    notFound = false;
    resolveError = null;
    slugState = null;
    loaded = false;
    loadError = null;
  });

  // Resolve the campaign name to its repo before anything reads the tables. The
  // load effect below is gated on `owner`/`repo`, so it waits for this.
  // The URL is the campaign's address (/<name>), so the name's registry state
  // decides what the page is: a live campaign renders, a free name forwards to
  // the wizard with the name prefilled, and a name that is held, reserved or
  // blocked explains itself.
  $effect(() => {
    if (
      auth.status === "loading" ||
      resolved ||
      notFound ||
      resolveError ||
      slugState ||
      resolving
    )
      return;
    resolving = true;
    resolve().finally(() => (resolving = false));
  });

  async function resolve() {
    // Results for a name the page has since navigated away from are dropped.
    const name = campaign;
    const info = await lookupSlug(name);
    if (name !== campaign) return;
    if (info?.status === "free") {
      await goto(`/new?slug=${encodeURIComponent(name)}`, { replaceState: true });
      return;
    }
    if (
      info?.status === "pending" ||
      info?.status === "reserved" ||
      info?.status === "tombstoned"
    ) {
      slugState = info.status;
      return;
    }
    // Active — or the registry was unreachable / the name malformed, which
    // resolveCampaign reports as null (notFound). A thrown forge error (e.g.
    // rate limit) is a failed lookup, not a missing campaign. The lookup above
    // is passed through so the name is not fetched from the registry twice.
    let r: ResolvedCampaign | null = null;
    try {
      r = await resolveCampaign(readForge(), name, info);
    } catch (e) {
      if (name === campaign) resolveError = resolveFailureMessage(e);
      return;
    }
    if (name !== campaign) return;
    if (r) resolved = r;
    else notFound = true;
  }

  $effect(() => {
    if (auth.status !== "loading" && owner && repo && !loaded) load();
  });

  // Background verdicts refresh the tables when they land — unless a command
  // overlay is up, whose own after-refresh will catch the change, or the
  // campaign isn't resolved (nothing to refresh).
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (!runner.busy && owner && repo) load();
    }),
  );

  // Run a command: show the busy overlay, capture its result banner, then
  // refresh the tables.
  async function run(
    command: (c: CommandContext) => Promise<Result>,
    refresh = true,
  ) {
    const f = forge();
    if (!f) return;
    await runner.run(
      () => command(ctx(f)),
      async (result) => {
        // A background command changed nothing yet — the settle listener
        // refreshes when its verdict lands.
        if (refresh && !result.background) {
          runner.log.step("Refreshing tables…");
          await load();
        }
      },
    );
  }

  const claim = (task_id: string, subtask_id: string) =>
    run((c) => invoke(commands.claimValidation, { task_id, subtask_id }, c));

  // Claiming a validation slot opens the place the review happens — a
  // pre-task's own editor, or the review view for encoding tasks — but only
  // on a clean claim, so a rejected claim leaves you on the console.
  const claimValidate = async (task_id: string, subtask_id: string) => {
    await claim(task_id, subtask_id);
    if (!runner.result?.ok || runner.result.warn) return;
    const locator = taskDefs.find(
      (t) => t.task_id === task_id && t.subtask_id === "",
    )?.locator;
    await goto(
      isPreTask(locator ?? "")
        ? `/${campaign}/${preTaskRoute(locator ?? "")}/${task_id}`
        : `/${campaign}/review/${task_id}`,
    );
  };

  // Open the task's score in mei-friend (claiming it if needed). The tab opens
  // only after the claim has gone through — never on a rejected or
  // still-pending claim — so it waits until the busy overlay is gone.
  const editor = async (task_id: string) => {
    await run((c) => invoke(commands.openEditor, { task_id }, c));
    if (runner.result?.ok && !runner.result.warn && runner.result.meiFriendUrl) {
      window.open(runner.result.meiFriendUrl, "_blank", "noopener");
    }
  };

  const submitpr = (task_id: string) =>
    run((c) => invoke(commands.submitEncoding, { task_id }, c));

  const validate = (
    task_id: string,
    subtask_id: string,
    verdict: string,
    comment?: FailComment,
  ) =>
    run((c) =>
      invoke(
        commands.submitValidation,
        { task_id, subtask_id, verdict, ...(comment ? { comment } : {}) },
        c,
      ),
    );

  const sendBackTask = (task_id: string) =>
    run((c) => invoke(commands.sendBack, { task_id }, c));

  const postComment = (
    task_id: string,
    kind: string,
    body: string,
    parent_id: string,
    at?: { page: string; measure_start: string; measure_end: string },
  ) =>
    run((c) =>
      invoke(
        commands.submitComment,
        {
          task_id,
          subtask_id: "",
          kind,
          body,
          page: at?.page ?? "",
          measure_start: at?.measure_start ?? "",
          measure_end: at?.measure_end ?? "",
          parent_id,
        },
        c,
      ),
    );

  const resolveCommentRow = (comment_id: string) =>
    run((c) => invoke(commands.resolveComment, { comment_id }, c));

  const reaper = () => run((c) => invoke(commands.runReaper, {}, c));

  // Save the edited plan; a clean save leaves the manage takeover (run() has
  // already refreshed the tables, so the board reflects the new plan).
  async function savePlan(tasks: TaskRow[]) {
    await run((c) => invoke(commands.savePlan, { tasks }, c));
    if (runner.result?.ok) manage = false;
  }

  // Deep links, read once after the first load: ?task= opens that task's
  // detail. On the owner's board the panel defaults open — to the task chosen
  // last time, or the first card on the board.
  let deepLinked = false;
  $effect(() => {
    if (!loaded || deepLinked) return;
    deepLinked = true;
    const task = page.url.searchParams.get("task");
    if (task && findRow(taskDefs, task, "")) {
      detailTask = task;
      return;
    }
    if (!canPush) return;
    const last = readLastTask(campaign);
    detailTask =
      last && allCards.some((c) => c.task === last)
        ? last
        : (displayColumns.find((c) => c.cards.length > 0)?.cards[0]?.task ??
          null);
  });

  function claimCard(card: BoardCard) {
    if (card.pre) goto(`/${campaign}/${preTaskRoute(card.locator)}/${card.task}`);
    else editor(card.task);
  }
  // Act on a card the viewer can work on: claim it when it is open, claim its
  // free validation slot when it awaits review, otherwise open its detail
  // (their claimed work lives there).
  function actOnCard(card: BoardCard) {
    if (card.column === "ready") {
      claimCard(card);
      return;
    }
    const sub = card.slots.find((s) => s.claimable)?.sub;
    if (card.column === "validation" && sub !== undefined)
      claimValidate(card.task, sub);
    else openTask(card.task);
  }
  function actOnNext() {
    if (nextCard) actOnCard(nextCard);
  }

  // The task panel names its piece and carries its colour.
  const pieceNameOf = (task: string) => {
    const p = previewPieces[pieceIndexByTask.get(task) ?? 0];
    return p ? p.title || p.id : "";
  };
  const zoneOf = (task: string) => ((pieceIndexByTask.get(task) ?? 0) % 8) + 1;

  // The board rendered as four columns: queued-but-blocked tasks share the
  // Open column (dimmed, with what they wait for) instead of a fifth column.
  const displayColumns = $derived.by(() => {
    const by = new Map(board.columns.map((c) => [c.key, c]));
    const ready = by.get("ready");
    const blocked = by.get("blocked");
    const encoding = by.get("encoding");
    const validation = by.get("validation");
    const done = by.get("done");
    return [
      {
        key: "ready" as ColumnKey,
        label: "Open",
        cards: [...(ready?.cards ?? []), ...(blocked?.cards ?? [])],
      },
      {
        key: "encoding" as ColumnKey,
        label: "Encoding",
        cards: encoding?.cards ?? [],
      },
      {
        key: "validation" as ColumnKey,
        label: "Awaiting validation",
        cards: validation?.cards ?? [],
      },
      {
        key: "done" as ColumnKey,
        label: "Done",
        cards: done?.cards ?? [],
      },
    ];
  });
  // The rail's selection filters the rendered columns to one piece; the
  // stats-bar toggle keeps only the claimable cards. Every column stays in
  // view, however empty the filters leave it.
  const scopedColumns = $derived.by(() => {
    let cols = displayColumns;
    if (selectedPiece !== "all")
      cols = cols.map((col) => ({
        ...col,
        cards: col.cards.filter(
          (c) =>
            previewPieces[pieceIndexByTask.get(c.task) ?? 0]?.path ===
            selectedPiece,
        ),
      }));
    if (boardScope === "open")
      cols = cols.map((col) => ({
        ...col,
        cards: col.cards.filter(actionable),
      }));
    return cols;
  });

  // The reaper's last trace in the history, for the manage header.
  const lastReap = $derived(
    history.findLast((h) => h.action === "reap") ?? null,
  );
  const elapsedLabel = (iso: string) => {
    const e = elapsed(iso);
    return e === "now" ? "just now" : `${e} ago`;
  };
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key !== "Escape") return;
    if (scoreView) closeScoreView();
    else if (detailTask) closeTask();
  }}
/>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

{#snippet resultBanner()}
  {#if runner.result && runner.result.error}
    <div class="banner bar err">
      <span>
        {runner.result.error}
        {#if runner.result.prUrl}
          <a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
      </span>
      <button type="button" class="dismiss" onclick={() => (runner.result = null)}
        >Dismiss</button
      >
    </div>
  {:else if runner.result && runner.result.ok && !runner.result.background}
    <div class="banner bar {runner.result.warn ? 'warn' : 'ok'}">
      <div class="banner-body">
        {runner.result.message}
        {#if runner.result.prUrl}
          <a href={runner.result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
        {#if runner.result.meiFriendUrl}
          <div class="rawlink">
            <input
              readonly
              value={runner.result.meiFriendUrl}
              onfocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <button type="button" onclick={() => copy(runner.result!.meiFriendUrl!)}
              >Copy</button
            >
          </div>
          <span class="muted">
            <a href={runner.result.meiFriendUrl} target="_blank" rel="noreferrer"
              >Open in mei-friend ↗</a
            >
            (if the tab didn't open automatically)
          </span>
          {#if isPrivate}
            <span class="muted">
              Opening mei-friend shares a short-lived, read-capable GitHub URL
              with that external service.
            </span>
          {/if}
        {/if}
      </div>
      <button type="button" class="dismiss" onclick={() => (runner.result = null)}
        >Dismiss</button
      >
    </div>
  {/if}
{/snippet}

{#snippet slotDot(key: string)}
  <span class="dot {key}" aria-label={key} title={key}></span>
{/snippet}

{#snippet taskSide(card: BoardCard)}
  <TaskSidePanel
    {card}
    pieceName={pieceNameOf(card.task)}
    zone={zoneOf(card.task)}
    {campaign}
    {comments}
    {locks}
    {rows}
    {logins}
    {viewer}
    {canPush}
    {runner}
    {resultBanner}
    bind:panel={taskPanel}
    onclose={closeTask}
    onopenscore={() => viewCardScore(card)}
    onshowanchor={showCommentInScore}
    onclaim={claimValidate}
    oneditor={editor}
    onsubmitencoding={submitpr}
    onvalidate={validate}
    oncomment={(kind, body, parent_id) =>
      postComment(card.task, kind, body, parent_id)}
    onresolve={resolveCommentRow}
    onsendback={sendBackTask}
  />
{/snippet}

<div class="console">
  {#if auth.status === "loading"}
    <p class="msg muted">Loading…</p>
  {:else}
    {#if !auth.user}
      <div class="banner bar warn">
        <span>
          Viewing this public campaign read-only. <button
            type="button"
            class="linkish"
            onclick={() => login()}>Log in with GitHub</button
          >
          to contribute.
        </span>
      </div>
    {/if}
    {#if !detailCard}
      {@render resultBanner()}
    {/if}

    {#if resolveError}
      <div class="banner bar err">
        <span>
          {resolveError}
          <button
            type="button"
            class="linkish"
            onclick={() => (resolveError = null)}>Try again</button
          >
        </span>
      </div>
    {:else if notFound}
      <div class="banner bar err">
        <span>
          No campaign called <code>{campaign}</code> was found. It may have
          been removed, or the name may be misspelled.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else if slugState === "pending"}
      <div class="banner bar warn">
        <span>
          Someone is setting up a campaign called <code>{campaign}</code>.
          If they don't finish it, the name becomes free again.
          <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else if slugState === "reserved"}
      <div class="banner bar err">
        <span>
          <code>{campaign}</code> is reserved and can't be used for a
          campaign. <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else if slugState === "tombstoned"}
      <div class="banner bar err">
        <span>
          The name <code>{campaign}</code> has been blocked and can't be
          used. <a href="/campaigns">Back to all campaigns</a>.
        </span>
      </div>
    {:else}
    <div class="viewcol" class:inscore={!!scoreView}>
      {#if !resolved}
        <p class="msg muted">Finding the campaign…</p>
      {:else if loading}
        <p class="msg muted">Loading campaign…</p>
      {:else if loadError}
        <div class="banner bar err"><span>{loadError}</span></div>
      {:else if notInitialised}
        <div class="banner bar warn">
          <span>
            This repository has no tracking tables (<code
              >tracking/task.csv</code
            >,
            <code>tracking/state.csv</code>, <code>tracking/lock.csv</code>)
            yet — it may not have been initialised. Create it through the home
            page to initialise it.
          </span>
        </div>
      {:else if scoreView}
        {#key scoreView.piece.path}
          <ScoreView
            piece={scoreView.piece}
            zone={(scoreView.index % 8) + 1}
            campaignTitle={title || repo}
            {owner}
            {repo}
            startPage={scoreStartPage}
            {anchor}
            cards={scoreCards}
            {comments}
            {logins}
            {viewer}
            {canPush}
            {runner}
            bind:panel={commentsPanel}
            oncomment={postComment}
            onresolve={resolveCommentRow}
          />
        {/key}
      {:else if manage && canPush}
        <div class="crumbrow">
          <button type="button" class="backlink" onclick={() => (manage = false)}
            >← Back to the board</button
          >
          <span class="bcsep">/</span>
          <span class="crumbtitle">{title || repo}</span>
          <span class="crumbsub">· Manage</span>
          <span class="ownerpill">owner</span>
          <span class="cspacer"></span>
          <span class="reapline">
            {#if lastReap}
              Reaper last released a stale claim {elapsedLabel(lastReap.timestamp)}
            {:else}
              The reaper has not released any stale claims yet
            {/if}
          </span>
          <button
            type="button"
            class="btn"
            onclick={() => reaper()}
            disabled={runner.busy}
            title="Release claims that have gone stale">Run reaper now</button
          >
        </div>
        <PlanEditor
          {taskDefs}
          {rows}
          {validationColumns}
          {locks}
          {logins}
          {pieceNames}
          busy={runner.busy}
          onsave={savePlan}
          oncancel={() => (manage = false)}
        />
      {:else if !canPush}
        <div class="volwrap">
          <div class="volcenter">
            <div class="volhead">
              <div class="voltitle">
                <h1>{title || repo}</h1>
                {#if volContributors.length > 0}
                  <div class="volmeta">
                    <span class="avatars">
                      {#each volContributors.slice(0, 5) as name (name)}
                        <span class="avatar" title={name}>{initialOf(name)}</span>
                      {/each}
                    </span>
                    <span class="volmetaline"
                      >{volContributors.length}
                      {volContributors.length === 1
                        ? "contributor"
                        : "contributors"}{lastMerged
                        ? ` · last merged: ${lastMerged.title} · ${elapsed(lastMerged.finishedAt)}`
                        : ""}</span
                    >
                  </div>
                {/if}
              </div>
              <span class="volspacer"></span>
              <span class="volcount">{board.done} of {board.total} done</span>
              {#if mosaic.length > 0 && mosaic.length <= 48}
                <span class="mosaic">
                  {#each mosaic as column, i (i)}
                    <span
                      class="mcell"
                      class:done={column === "done"}
                      class:review={column === "validation"}
                    ></span>
                  {/each}
                </span>
              {:else}
                <div class="volbar">
                  <div
                    style={`width:${board.total ? Math.round((board.done / board.total) * 100) : 0}%`}
                  ></div>
                </div>
              {/if}
              {#if volunteerScope && !commentsPanel.open && !detailCard}
                <button
                  type="button"
                  class="cptoggle"
                  title="Show the comments panel"
                  onclick={() => {
                    commentsPanel.open = true;
                    writeSidePanel("comments", { ...commentsPanel });
                  }}><PanelIcon /></button
                >
              {/if}
            </div>
            <div class="volrow">
              <VolunteerView
                {owner}
                {repo}
                cards={allCards}
                {nextCard}
                {taskDefs}
                {locks}
                {viewer}
                pieces={previewPieces}
                progress={pieceProgress}
                pieceIndex={pieceIndexByTask}
                busy={runner.busy}
                bind:expandedPiece={volunteerPiece}
                onact={actOnCard}
                onopen={openTask}
                onviewscore={viewScorePiece}
              />
              {#if detailCard}
                {@render taskSide(detailCard)}
              {:else if volunteerScope && commentsPanel.open}
                <div class="cpholder">
                  <CommentsPanel
                    piece={volunteerScope.piece}
                    zone={(volunteerScope.index % 8) + 1}
                    cards={scopeCards}
                    {comments}
                    {logins}
                    {viewer}
                    {canPush}
                    {runner}
                    fitEmpty
                    bind:panel={commentsPanel}
                    onanchor={showCommentInScore}
                    oncomment={postComment}
                    onresolve={resolveCommentRow}
                  />
                </div>
              {/if}
            </div>
          </div>
        </div>
      {:else}
        <div class="hero">
          <div class="hero-line">
            <h1>{title || repo}</h1>
            <a
              class="mono slug"
              href={`https://github.com/${owner}/${repo}`}
              target="_blank"
              rel="noreferrer">{owner}/{repo} ↗</a
            >
            <button
              type="button"
              class="infochip"
              class:on={showInfo}
              onclick={() => {
                showInfo = !showInfo;
                if (showInfo) loadScoreHead();
              }}
              title="Show or hide campaign information"
              >ⓘ Info {showInfo ? "▾" : "▸"}</button
            >
            <span class="cspacer"></span>
            {#if auth.user && canPush}
              <button
                type="button"
                class="btn btn-lg managechip"
                onclick={() => (manage = true)}
                disabled={runner.busy}
                title="Owner only — plan editor and reaper">⚙ Manage</button
              >
            {/if}
            <button
              type="button"
              class="btn btn-lg btn-primary"
              disabled={runner.busy || !auth.user || !nextCard}
              title={!auth.user
                ? "Log in to claim a task."
                : !nextCard
                  ? "Nothing to claim right now."
                  : "Claim the first task that is open for you."}
              onclick={actOnNext}>Claim the next task</button
            >
          </div>
          {#if showInfo}
            <div class="infoblock">
              <div class="isec">
                <span class="seclabel">Score</span>
                {#if scoreHeadState === "loading"}
                  <span class="muted inote">Loading the score header…</span>
                {:else if scoreHeadState === "error"}
                  <span class="muted inote">Could not read the score.</span>
                {:else if scoreHeadState === "done" && !scoreHead}
                  <span class="muted inote">The score has no MEI header.</span>
                {:else if scoreHead}
                  <div class="irow">
                    <span>Title</span>
                    <span>{scoreHead.title || "—"}</span>
                  </div>
                  <div class="irow">
                    <span>Composer</span>
                    <span>{scoreHead.composer || "—"}</span>
                  </div>
                  {#each scoreHead.contributors as c (c.role + c.name)}
                    <div class="irow">
                      <span>{c.role || "contributor"}</span>
                      <span>{c.name}</span>
                    </div>
                  {/each}
                {/if}
                <div
                  class="irow"
                  title="Everyone the campaign history records: claims, submissions and validations."
                >
                  <span>Worked on this</span>
                  <span>
                    {#if workedOn.length}
                      {#each workedOn as u, i (u)}{i > 0 ? ", " : ""}<a
                          class="mono"
                          href={`https://github.com/${logins[u] || u}`}
                          target="_blank"
                          rel="noreferrer">@{logins[u] || u}</a
                        >{/each}
                    {:else}—{/if}
                  </span>
                </div>
              </div>
              <div class="isec">
                <span class="seclabel">Campaign</span>
                <div class="irow">
                  <span>About</span>
                  <span>{description || "—"}</span>
                </div>
                <div class="irow">
                  <span>Visibility</span>
                  <span>{isPrivate ? "Private" : "Public"}</span>
                </div>
                <div
                  class="irow"
                  title="Contributions to this campaign are published under this license."
                >
                  <span>License</span>
                  <span>{license || "—"}</span>
                </div>
                <div
                  class="irow"
                  title="Validation passes each task needs before it counts as validated."
                >
                  <span>Passes required</span>
                  <span>{passThreshold}</span>
                </div>
              </div>
            </div>
          {/if}
          <div class="hero-stats">
            <span class="stat"><b class="c-ok">{board.done}</b> done</span>
            <span class="sep">·</span>
            <span class="stat"><b class="c-info">{board.inFlight}</b> in flight</span>
            <span class="sep">·</span>
            {#if board.attention > 0}
              <button
                type="button"
                class="stat statbtn"
                onclick={() => (showAttention = !showAttention)}
                title="Show the tasks with unresolved fails, comments or questions."
                ><b>{board.attention}</b> need{board.attention === 1
                  ? "s"
                  : ""} attention {showAttention ? "▾" : "▸"}</button
              >
            {:else}
              <span class="stat"><b>0</b> need attention</span>
            {/if}
            <span class="sep">·</span>
            <span class="stat"
              ><b>{board.contributorsWeek}</b> contributor{board.contributorsWeek ===
              1
                ? ""
                : "s"} this week</span
            >
            <div class="hbar">
              <div
                style={`width:${board.total ? Math.round((board.done / board.total) * 100) : 0}%`}
              ></div>
            </div>
            <span class="hbarlabel">{board.done}/{board.total} tasks done</span>
            <div class="seg">
              <button
                type="button"
                class:on={boardScope === "all"}
                onclick={() => (boardScope = "all")}>All tasks</button
              >
              <button
                type="button"
                class:on={boardScope === "open"}
                onclick={() => (boardScope = "open")}
                title="Only tasks with something to do right now: open encodings and free review slots."
                >Claimable</button
              >
            </div>
          </div>
          {#if showAttention && attentionCards.length > 0}
            <div class="attnbox">
              {#each attentionCards as card (card.task)}
                <button
                  type="button"
                  class="attnrow"
                  onclick={() => openTask(card.task)}
                  title="Open this task"
                >
                  <span class="attntitle">{card.title}</span>
                  <span class="mono card-id">{card.task}</span>
                  <span class="attnspacer"></span>
                  {#if card.counts.fails > 0}
                    <span class="chip chip-fail"
                      >{card.counts.fails} fail{card.counts.fails === 1
                        ? ""
                        : "s"}</span
                    >
                  {/if}
                  {#if card.counts.comments > 0}
                    <span class="chip chip-note"
                      >{card.counts.comments} comment{card.counts.comments === 1
                        ? ""
                        : "s"}</span
                    >
                  {/if}
                  {#if card.counts.questions > 0}
                    <span class="chip chip-question"
                      >{card.counts.questions} question{card.counts.questions ===
                      1
                        ? ""
                        : "s"}</span
                    >
                  {/if}
                  <span class="attnchev">›</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="instrow">
        {#if previewPieces.length > 0}
          <PieceRail
            pieces={previewPieces}
            {owner}
            {repo}
            progress={pieceProgress}
            counts={railCounts}
            attention={attentionByPiece}
            openCount={board.columns.find((c) => c.key === "ready")?.cards
              .length ?? 0}
            selected={selectedPiece}
            onselect={(sel) => (selectedPiece = sel)}
          />
        {/if}
        <div class="boardcol">
        {#if railPiece}
          {@const p = pieceProgress.get(railPiece.piece.path)}
          <div
            class="ctxstrip"
            style="--zone: var(--zone-{(railPiece.index % 8) + 1})"
          >
            <span class="ctxpaper">
              {#if stripPreview?.thumb}
                <img src={stripPreview.thumb} alt="" loading="lazy" />
              {/if}
            </span>
            <div class="ctxinfo">
              <span class="ctxname"
                >{railPiece.piece.title || railPiece.piece.id}</span
              >
              <span class="ctxmeta"
                >{stripPreview?.pageMeasures.length
                  ? `${stripPreview.pageMeasures.length} page${stripPreview.pageMeasures.length === 1 ? "" : "s"} · ${stripPreview.pageMeasures.reduce((a, b) => a + b, 0)} measures · `
                  : ""}{p?.done ?? 0} of {p?.total ?? 0} done</span
              >
            </div>
            <div class="ctxincipit">
              {#if stripPreview?.incipit}
                {@html stripPreview.incipit}
              {:else if stripPreview?.incipitPending}
                <span class="ctxincnote">incipit appears after the preparation tasks</span>
              {/if}
            </div>
            <button
              type="button"
              class="btn"
              onclick={() => viewScorePiece(railPiece.index)}
              title="Show every page of this piece's score.">View score →</button
            >
          </div>
        {/if}
        <div class="board">
          {#each scopedColumns as col (col.key)}
            <div class="bcol">
              <div class="bcol-head c-{col.key}">
                <span class="bcol-name">{col.label}</span>
                <span class="bcol-count">{col.cards.length}</span>
              </div>
              <div class="well">
                  {#each col.cards as card (card.task)}
                    <!-- A focusable div, not a <button>: the run state inside
                         it can render a PR link, which HTML does not allow
                         nested in a button. -->
                    <div
                      class="card col-{card.column}"
                      class:nextup={card.nextUp}
                      class:justmoved={recentlyFinished.has(card.task)}
                      class:pre={card.pre}
                      class:tinted={previewPieces.length > 1}
                      class:paneled={detailTask === card.task}
                      style={previewPieces.length > 1
                        ? `--piece-tint: var(--zone-${zoneOf(card.task)})`
                        : undefined}
                      class:failtint={card.counts.fails > 0 &&
                        card.column !== "done"}
                      role="button"
                      tabindex="0"
                      onclick={() => openTask(card.task)}
                      onkeydown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openTask(card.task);
                        }
                      }}
                      title="Open this task"
                    >
                      {#if card.nextUp}
                        <span class="nextup-badge">next step</span>
                      {/if}
                      {#if recentlyFinished.has(card.task)}
                        <span class="justmoved-badge">just submitted</span>
                      {/if}
                      <div class="card-title">{card.title}</div>
                      <div class="card-type">
                        {card.column === "validation"
                          ? `${card.typeLine} · ${card.passes} of ${card.threshold} passes`
                          : card.typeLine}
                        <span class="mono card-id">{card.task}</span>
                        <button
                          type="button"
                          class="card-score"
                          onclick={(e) => {
                            e.stopPropagation();
                            viewCardScore(card);
                          }}
                          title="Open the score at this task's pages"
                          >{cardPage(card) ? `p. ${cardPage(card)} →` : "score →"}</button
                        >
                      </div>
                      <TaskRunState task={card.task} />
                      {#if card.column === "blocked"}
                        <div class="card-foot">
                          waits for <strong>{card.waitsFor}</strong>
                        </div>
                      {:else if card.column === "encoding" && card.worker}
                        <div class="card-worker">
                          <span class="avatar"
                            >{initialOf(card.worker.login)}</span
                          >
                          <span class="worker-line"
                            >{card.worker.login} · {card.worker
                              .elapsed}</span
                          >
                        </div>
                      {:else if card.column === "validation"}
                        <div class="card-dots">
                          {#each card.dots as key, i (i)}
                            {@render slotDot(key)}
                          {/each}
                        </div>
                      {:else if card.column === "done"}
                        <div class="card-done">
                          <img class="hand-done" src="/green-hand.svg" alt="" />
                          {card.doneLine}
                        </div>
                      {/if}
                      {#if card.column !== "done" && card.counts.fails + card.counts.comments + card.counts.questions > 0}
                        <div class="card-chips">
                          {#if card.counts.fails > 0}
                            <span class="chip chip-fail"
                              >{card.counts.fails} fail{card.counts.fails === 1
                                ? ""
                                : "s"}</span
                            >
                          {/if}
                          {#if card.counts.comments > 0}
                            <span class="chip chip-note"
                              >{card.counts.comments} comment{card.counts
                                .comments === 1
                                ? ""
                                : "s"}</span
                            >
                          {/if}
                          {#if card.counts.questions > 0}
                            <span class="chip chip-question"
                              >{card.counts.questions} question{card.counts
                                .questions === 1
                                ? ""
                                : "s"}</span
                            >
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
              </div>
            </div>
          {/each}
        </div>
        </div>
        {#if detailCard}
          {@render taskSide(detailCard)}
        {/if}
        </div>

        <div class="ticker">
          <span class="ticker-label">Activity</span>
          {#each board.ticker as t, i (i)}
            {#if i > 0}<span class="ticker-sep">|</span>{/if}
            <span class="ticker-entry"
              ><strong>{t.login}</strong>
              {t.text}
              <span class="ticker-when">· {t.elapsed}</span></span
            >
          {/each}
          {#if board.ticker.length === 0}
            <span class="ticker-entry muted">No activity yet.</span>
          {/if}
        </div>
      {/if}
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
    background: var(--bg-alt);
    background-image:
      radial-gradient(
        60% 90% at 15% 0%,
        var(--glow-blue),
        transparent 60%
      ),
      radial-gradient(
        60% 90% at 85% 10%,
        var(--glow-green),
        transparent 60%
      );
    /* Board-only aliases onto the global recessed-surface tokens. */
    --well: var(--bg-inset);
    --track: var(--bg-tint);
    --hairline: var(--line);
  }
  .mono {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .muted {
    color: var(--ink-faint);
  }
  .msg {
    padding: 1rem 1.4rem;
  }

  /* Banner styles are shared app-wide in ui.css. */
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
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
  }
  .rawlink button {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
    cursor: pointer;
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

  /* --------------------------------------------------------------- main */
  /* The view fills the window — the rail, board and task panel share every
     available column. Its minimum height is its content's. The width minimum
     is explicit: the inline-size containment below makes the content's own
     width invisible to sizing, and the board's stacking reacts to the
     column's width instead. */
  .viewcol {
    flex: 1;
    min-width: 340px;
    width: 100%;
    display: flex;
    flex-direction: column;
    container-type: inline-size;
  }
  /* The score view scrolls inside its panes, so the column must cap at the
     window instead of growing to its content. */
  .viewcol.inscore {
    min-height: 0;
  }

  /* The volunteer view: the header row, the task column and the comments
     panel form one centred group; the group's width is the row's content
     width (the fixed task column plus the panel). */
  .volwrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    padding: 18px 32px 8px;
    box-sizing: border-box;
  }
  .volcenter {
    flex: 1;
    min-height: 0;
    max-width: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .volhead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 14px;
    /* The header follows the row's width instead of contributing its own —
       a long title wraps rather than widening the group. */
    width: 0;
    min-width: 100%;
    box-sizing: border-box;
  }
  .volhead h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
  }
  .voltitle {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .volmeta {
    display: flex;
    align-items: center;
  }
  .avatars {
    display: flex;
  }
  .avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    box-sizing: border-box;
    background: var(--bg-tint);
    border: 1.5px solid var(--card);
    margin-right: -6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9.5px;
    font-weight: 700;
    color: var(--ink-soft);
  }
  .volmetaline {
    font-size: 12px;
    color: var(--ink-soft);
    margin-left: 14px;
  }
  .mosaic {
    flex: none;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    max-width: 240px;
    justify-content: flex-end;
  }
  .mcell {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    box-sizing: border-box;
    background: color-mix(in srgb, var(--card) 60%, transparent);
    border: 1px solid var(--line-input);
  }
  .mcell.done {
    background: linear-gradient(135deg, var(--blue), var(--green));
    border: 0;
  }
  .mcell.review {
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .volspacer {
    flex: 1;
  }
  .volcount {
    font-size: 12px;
    color: var(--ink-soft);
    white-space: nowrap;
    flex: none;
  }
  .volbar {
    flex: none;
    width: 160px;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-tint);
    overflow: hidden;
  }
  .volbar > div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .volrow {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
  }
  /* The comments panel's top edge lines up with the next-task card, below
     the task column's section label. */
  .cpholder {
    flex: none;
    min-height: 0;
    display: flex;
    padding-top: 26px;
    box-sizing: border-box;
  }
  .cptoggle {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex: none;
    padding: 0;
  }

  /* ---------------------------------------------------------- info block */
  /* Campaign info, collapsed into the header area behind the Info toggle. */
  .infoblock {
    flex: none;
    padding: 14px 18px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 18px 56px;
  }
  .isec {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 400px;
    min-width: 0;
  }
  .inote {
    font-size: 11px;
  }
  /* A fixed label column with the value directly after it, left-aligned. */
  .irow {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr);
    gap: 10px;
    font-size: 12px;
  }
  .irow > span:first-child {
    color: var(--ink-faint);
  }
  .irow > :last-child {
    overflow-wrap: anywhere;
  }
  .irow a {
    color: var(--link);
    text-decoration: none;
  }
  .irow a:hover {
    text-decoration: underline;
  }
  .seclabel {
    font-weight: 600;
    font-size: 10px;
    color: var(--ink-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* ---------------------------------------------------------------- hero */
  .hero {
    flex: none;
    padding: 18px 32px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .hero-line {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .hero-line h1 {
    margin: 0;
    font-size: 26px;
    line-height: 1.2;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .slug {
    font-size: 13px;
    color: var(--ink-faint);
    text-decoration: none;
    flex: none;
  }
  .slug:hover {
    text-decoration: underline;
  }
  .infochip {
    font: 600 12.5px var(--font);
    color: var(--ink-soft);
    background: var(--bg-tint);
    border: 0;
    border-radius: 999px;
    padding: 5px 13px;
    cursor: pointer;
    flex: none;
  }
  .infochip:hover,
  .infochip.on {
    color: var(--accent);
  }
  .cspacer {
    flex: 1;
  }
  /* Sizing comes from .btn.btn-lg; only the owner-amber tint is local. */
  .managechip {
    color: var(--owner);
    background: var(--owner-bg);
    border-color: var(--owner-line);
  }
  .managechip:hover:not(:disabled) {
    color: var(--owner);
    border-color: var(--owner);
  }
  .hero-stats {
    display: flex;
    gap: 14px;
    align-items: center;
    flex-wrap: wrap;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 18px;
    box-shadow: var(--shadow-sm);
  }
  .hbar {
    flex: 1;
    max-width: 420px;
    height: 6px;
    border-radius: 3px;
    background: var(--track);
    overflow: hidden;
  }
  .hbar div {
    height: 100%;
    background: linear-gradient(90deg, var(--blue), var(--green));
  }
  .hbarlabel {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .stat {
    font-size: 13px;
    color: var(--ink-soft);
  }
  .stat b.c-ok {
    color: var(--ok);
  }
  .stat b.c-info {
    color: var(--info);
  }
  .sep {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .statbtn {
    font: inherit;
    font-size: 13px;
    color: var(--danger);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }
  /* The tasks behind the attention count, unfolded from the stat. */
  .attnbox {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
    border-radius: 12px;
    padding: 10px 14px;
  }
  .attnrow {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: inherit;
    font-size: 13px;
    text-align: left;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 14px;
    cursor: pointer;
  }
  .attnrow:hover {
    border-color: var(--accent);
  }
  .attntitle {
    font-weight: 600;
  }
  .attnspacer {
    flex: 1;
  }
  .attnchev {
    font-size: 15px;
    color: var(--ink-faint);
  }
  /* -------------------------------------------------------------- pieces */
  /* ---------------------------------------- rail · board · task panel row */
  .instrow {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 14px;
    padding: 0 32px;
  }
  .boardcol {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  /* The scoped piece's preview over the columns. */
  .ctxstrip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 16px;
    background: color-mix(in srgb, var(--zone) 8%, var(--card));
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    padding: 10px 16px;
    box-shadow: var(--shadow-sm);
  }
  .ctxpaper {
    flex: none;
    width: 36px;
    height: 47px;
    background: var(--facsimile-paper);
    border: 1px solid var(--line);
    border-radius: 2px;
    overflow: hidden;
  }
  .ctxpaper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .ctxinfo {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ctxname {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }
  .ctxmeta {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .ctxincipit {
    flex: 1;
    min-width: 0;
    height: 34px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 10px;
    display: flex;
    align-items: center;
    overflow: hidden;
  }
  .ctxincipit :global(svg) {
    height: 100%;
    width: auto;
    max-width: 100%;
  }
  .ctxincnote {
    font-size: 11px;
    color: var(--ink-faint);
  }
  /* --------------------------------------------------------------- board */
  .board {
    flex: 1;
    /* Roughly a column head and one card row — the least the board is ever
       shown with, so the dock panels stop growing before crushing it. */
    min-height: 170px;
    display: flex;
    gap: 14px;
  }
  .bcol {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
  }
  .bcol-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px;
  }
  .bcol-name {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .bcol-count {
    font-size: 11px;
    font-weight: 600;
    background: var(--track);
    border-radius: 999px;
    padding: 1px 7px;
  }
  .bcol-head.c-blocked {
    color: var(--ink-faint);
  }
  .bcol-head.c-ready {
    color: var(--ink-soft);
  }
  .bcol-head.c-encoding {
    color: var(--info);
  }
  .bcol-head.c-encoding .bcol-count {
    background: var(--info-bg);
  }
  .bcol-head.c-validation {
    color: var(--warn);
  }
  .bcol-head.c-validation .bcol-count {
    background: var(--warn-bg);
  }
  .bcol-head.c-done {
    color: var(--ok);
  }
  .bcol-head.c-done .bcol-count {
    background: var(--ok-bg);
  }
  .well {
    background: var(--well);
    box-shadow: var(--shadow-inset);
    border: 1px dashed var(--line-strong);
    border-radius: 14px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    /* Sized by its column, never by its cards: a long card list scrolls in
       here instead of growing the board — and the board's own minimum stays
       one card row, however many tasks there are. */
    contain: size;
  }
  .card {
    position: relative;
    /* A flex column, so each column's footer row (waits-for, worker,
       completion line) pins to the card's bottom edge via margin-top: auto
       instead of leaving the uniform height unused. */
    display: flex;
    flex-direction: column;
    text-align: left;
    font-family: inherit;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
    flex: none;
    /* One height for every card, whichever footer line its column gives it. */
    min-height: 88px;
    box-sizing: border-box;
  }
  /* The piece's colour threads from the rail through every card's edge. */
  .card.tinted {
    border-left: 3px solid var(--piece-tint);
  }
  /* The card whose task panel is open. */
  .card.paneled {
    background: var(--info-bg);
    border-color: var(--info-line);
  }
  .card:hover {
    border-color: var(--accent);
  }
  .card.col-blocked {
    opacity: 0.8;
    box-shadow: none;
  }
  .card.col-encoding {
    border: 1.5px solid var(--info-line);
  }
  .card.col-validation {
    border: 1.5px solid var(--warn-line);
  }
  .card.col-done {
    box-shadow: none;
  }
  .card.pre {
    border-left: 3px solid var(--pre);
  }
  /* Before .card.failtint: a recorded fail outweighs the finished highlight. */
  .card.justmoved {
    border-color: var(--ok-line);
    background: var(--ok-wash);
  }
  .card.failtint {
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }
  .card.nextup {
    border-color: var(--accent);
  }
  .nextup-badge {
    position: absolute;
    top: -9px;
    left: 12px;
    background: var(--accent);
    color: var(--invert-ink);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 2px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  :global([data-theme="dark"]) .nextup-badge {
    color: #fff;
  }
  .justmoved-badge {
    position: absolute;
    top: -9px;
    right: 12px;
    background: var(--ok);
    color: var(--invert-ink);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.03em;
    padding: 2px 9px;
    border-radius: 999px;
    white-space: nowrap;
  }
  :global([data-theme="dark"]) .justmoved-badge {
    color: #fff;
  }
  .card-title {
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .card.col-blocked .card-title,
  .card.col-done .card-title {
    color: var(--ink-soft);
  }
  .card-type {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 3px;
  }
  .card-id {
    font-size: 10px;
    opacity: 0.8;
    margin-left: 4px;
  }
  .card-score {
    font: 600 11px var(--font);
    color: var(--info);
    background: none;
    border: 0;
    padding: 0;
    margin-left: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .card-foot {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: auto;
    border-top: 1px solid var(--hairline);
    padding-top: 8px;
  }
  .card-worker {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: auto;
    padding-top: 6px;
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
  .worker-line {
    font-size: 11.5px;
    color: var(--info);
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-dots {
    display: flex;
    gap: 4px;
    margin-top: auto;
    padding-top: 6px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line-input);
    flex: none;
    display: inline-block;
  }
  .dot.pass {
    background: var(--green);
    border-color: var(--ok);
  }
  :global([data-theme="dark"]) .dot.pass {
    background: var(--ok);
    border-color: var(--ok-line);
  }
  .dot.fail {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
  }
  .dot.review {
    background: var(--info-bg);
    border-color: var(--info);
  }
  .card-chips {
    display: flex;
    gap: 6px;
    margin-top: 9px;
    border-top: 1px solid var(--hairline);
    padding-top: 9px;
    flex-wrap: wrap;
  }
  .chip {
    font-size: 11px;
    font-weight: 600;
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
  .card-done {
    font-size: 11.5px;
    color: var(--ok);
    font-weight: 600;
    margin-top: auto;
    padding-top: 6px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .hand-done {
    height: 12px;
    flex: none;
  }
  /* -------------------------------------------------------------- ticker */
  .ticker {
    flex: none;
    margin: 16px 32px 24px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow-sm);
    height: 56px;
    display: flex;
    align-items: center;
    padding: 0 18px;
    gap: 18px;
    overflow: hidden;
  }
  .ticker-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    flex: none;
  }
  .ticker-entry {
    font-size: 12.5px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .ticker-when {
    color: var(--ink-faint);
  }
  .ticker-sep {
    color: var(--line-strong);
    flex: none;
  }
  /* ----------------------------------------------- manage takeover chrome */
  .crumbrow {
    flex: none;
    padding: 14px 32px 0;
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .backlink {
    font: 600 13px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    flex: none;
  }
  .backlink:hover {
    text-decoration: underline;
  }
  .bcsep {
    color: var(--line-input);
  }
  .crumbtitle {
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumbsub {
    font-size: 15px;
    color: var(--ink-faint);
    flex: none;
  }
  .ownerpill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--owner);
    background: var(--owner-bg);
    border: 1px solid var(--owner-line);
    border-radius: 999px;
    padding: 2px 10px;
  }
  .reapline {
    font-size: 12.5px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* --------------------------------------------------------- responsive */
  /* Container-based, so the board also stacks when a side panel narrows it,
     not only when the window itself is narrow. Stacked, the board scrolls
     as a whole instead of per column — the containment moves up with the
     scrolling, so the stack can't grow the view past the window either. */
  @container (max-width: 1100px) {
    .board {
      flex-direction: column;
      overflow-y: auto;
      contain: size;
    }
    .bcol {
      min-height: auto;
    }
    .well {
      overflow-y: visible;
      contain: none;
    }
  }
</style>
