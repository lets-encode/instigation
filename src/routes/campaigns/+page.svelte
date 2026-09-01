<!--
  The main screen — the app's only dashboard. Top to bottom, for a logged-in
  viewer: what needs their attention (fix requests and unresolved comments on
  their work), their open work, every campaign as a searchable list of
  full-width rows (each carrying its suggested next task, claimable in
  place), and unfinished wizard drafts. Logged out, only the list renders.
  Campaign creation lives behind the top bar's New campaign button. One stats
  load serves the whole screen.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { auth, login } from "$lib/auth.svelte.ts";
  import {
    CommandRunner,
    readForge,
    viewerId,
  } from "$lib/command-runner.svelte.ts";
  import { provider, meiFriendUrl } from "$lib/forge/config.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";
  import { elapsed } from "$lib/campaign-board.ts";
  import { handle, preTaskRoute } from "$lib/campaign-graph.ts";
  import {
    commentsOnMyWork,
    invalidateStats,
    loadAllCampaignStats,
    loadCampaignStats,
    myTasksIn,
  } from "$lib/campaign-stats.ts";
  import type {
    CampaignStats,
    FeedComment,
    MyTask,
    NextTask,
  } from "$lib/campaign-stats.ts";
  import CampaignRow from "$lib/components/CampaignRow.svelte";
  import CampaignDrafts from "$lib/components/CampaignDrafts.svelte";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  const PER_PAGE = 12;

  const viewer = $derived(viewerId());

  let stats = $state<CampaignStats[]>([]);
  let listLoading = $state(false);
  let listError = $state<string | null>(null);
  let listLoaded = $state(false);
  // Repositories the search found but whose tables could not be read.
  let listFailed = $state(0);
  let listFailureMessage = $state("");

  $effect(() => {
    if (auth.status === "loading" || listLoaded || listLoading) return;
    listLoading = true;
    loadAll().finally(() => {
      listLoading = false;
      listLoaded = true;
    });
  });

  // Stats arrive one campaign at a time; each resolves into the grid as it
  // lands rather than waiting for the slowest repository.
  async function loadAll() {
    try {
      const listing = await loadAllCampaignStats(readForge(), provider.repoTopic, {
        onEach: (s) =>
          (stats = [...stats.filter((x) => x.repoId !== s.repoId), s]),
      });
      listFailed = listing.failed;
      listFailureMessage = listing.failureMessage;
      listError = null;
    } catch (err) {
      listError = (err as Error).message;
    }
  }

  // ----------------------------------------------------- the viewer's work
  const tasks = $derived(
    viewer ? stats.flatMap((s) => myTasksIn(s, viewer)) : ([] as MyTask[]),
  );
  const fix = $derived(tasks.filter((t) => t.group === "fix"));
  const encoding = $derived(tasks.filter((t) => t.group === "encoding"));
  const validating = $derived(tasks.filter((t) => t.group === "validating"));
  const awaiting = $derived(tasks.filter((t) => t.group === "awaiting"));
  const done = $derived(
    tasks
      .filter((t) => t.group === "done")
      .sort(
        (a, b) =>
          Date.parse(b.submittedAt || "0") - Date.parse(a.submittedAt || "0"),
      ),
  );
  let showCompleted = $state(false);

  // Unresolved questions and notes on the viewer's work; fails surface through
  // the fix group instead, so they are not repeated here.
  const openComments = $derived(
    viewer
      ? stats
          .flatMap((s) => commentsOnMyWork(s, viewer))
          .filter(
            (f) =>
              (f.comment.kind === "question" || f.comment.kind === "addition") &&
              f.comment.resolved !== "true",
          )
          .sort(
            (a, b) =>
              Date.parse(b.comment.timestamp || "0") -
              Date.parse(a.comment.timestamp || "0"),
          )
      : ([] as FeedComment[]),
  );

  // The viewer's first recorded action anywhere, for "contributing since".
  const since = $derived.by(() => {
    let first = Infinity;
    for (const s of stats) {
      for (const h of s.history) {
        if (h.user_id !== viewer) continue;
        const t = Date.parse(h.timestamp);
        if (Number.isFinite(t)) first = Math.min(first, t);
      }
    }
    return Number.isFinite(first) && first !== Infinity
      ? new Date(first).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        })
      : "";
  });

  // ------------------------------------------------------------ commands
  const runner = new CommandRunner();

  const ctxOf = (s: CampaignStats): CommandContext =>
    runner.context(
      readForge(),
      { repoId: s.repoId, owner: s.owner, repo: s.repo },
      { meiFriendUrl },
    );

  const ctxFor = (t: MyTask): CommandContext | null => {
    const s = stats.find((x) => x.name === t.campaignSlug);
    return s ? ctxOf(s) : null;
  };

  // Re-read one campaign's stats and swap its grid row in place, leaving the
  // rest of the listing as it is.
  async function refreshStats(s: CampaignStats) {
    invalidateStats(s.repoId);
    try {
      const fresh = await loadCampaignStats(readForge(), {
        id: s.repoId,
        owner: s.owner,
        name: s.repo,
        full_name: `${s.owner}/${s.repo}`,
        html_url: `https://github.com/${s.owner}/${s.repo}`,
        private: s.isPrivate,
        description: null,
        updated_at: "",
        created_at: s.createdAt,
      });
      stats = stats.map((x) => (x.repoId === fresh.repoId ? fresh : x));
    } catch {
      // The stale row stays; the next full listing load replaces it.
    }
  }

  async function run(
    t: MyTask,
    command: (c: CommandContext) => Promise<Result>,
  ) {
    const c = ctxFor(t);
    if (!c) return;
    await runner.run(
      () => command(c),
      async () => {
        runner.log.step("Refreshing…");
        const s = stats.find((x) => x.repoId === c.repoId);
        if (s) await refreshStats(s);
      },
    );
  }

  // Background verdicts settle against a campaign the viewer has work in;
  // refresh those campaigns' rows so the settled task moves group.
  $effect(() =>
    pendingVerdicts.onSettled(() => {
      if (runner.busy) return;
      const mine = new Set(
        tasks.filter((t) => t.group !== "done").map((t) => t.campaignSlug),
      );
      for (const s of stats) if (mine.has(s.name)) refreshStats(s);
    }),
  );

  const openEditor = async (t: MyTask) => {
    await run(t, (c) => invoke(commands.openEditor, { task_id: t.task }, c));
    if (runner.result?.ok && !runner.result.warn && runner.result.meiFriendUrl) {
      window.open(runner.result.meiFriendUrl, "_blank", "noopener");
    }
  };
  const submit = (t: MyTask) =>
    run(t, (c) => invoke(commands.submitEncoding, { task_id: t.task }, c));

  // Claim a campaign row's suggested next task. Encoding claims open
  // mei-friend (a pre-task claims in its own editor instead); a clean review
  // claim lands on the place the review happens.
  async function claimNext(s: CampaignStats, next: NextTask) {
    if (next.action === "encode" && next.pre) {
      await goto(`/${s.name}/${preTaskRoute(next.locator)}/${next.task}`);
      return;
    }
    const c = ctxOf(s);
    const refresh = async () => {
      runner.log.step("Refreshing…");
      await refreshStats(s);
    };
    if (next.action === "encode") {
      await runner.run(
        () => invoke(commands.openEditor, { task_id: next.task }, c),
        refresh,
      );
      if (runner.result?.ok && !runner.result.warn && runner.result.meiFriendUrl) {
        window.open(runner.result.meiFriendUrl, "_blank", "noopener");
      }
    } else if (next.action === "review") {
      await runner.run(
        () =>
          invoke(
            commands.claimValidation,
            { task_id: next.task, subtask_id: next.subtask },
            c,
          ),
        refresh,
      );
      if (runner.result?.ok && !runner.result.warn) {
        await goto(
          next.pre
            ? `/${s.name}/${preTaskRoute(next.locator)}/${next.task}`
            : `/${s.name}/review/${next.task}`,
        );
      }
    }
  }

  const taskHref = (slug: string, task: string) =>
    `/${slug}?task=${encodeURIComponent(task)}`;
  const taskLine = (t: MyTask) => `${t.campaign} · ${t.task} · ${t.title}`;
  const ago = (iso: string) => {
    const e = elapsed(iso);
    return e === "now" ? "just now" : `${e} ago`;
  };
  const expiresIn = (t: MyTask): string => {
    if (!t.expiresAt) return "";
    const ms = Date.parse(t.expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return "";
    if (ms <= 0) return "claim has gone stale";
    const days = Math.round(ms / (24 * 3600_000));
    if (days >= 2) return `claim expires in ${days} days`;
    const hours = Math.max(1, Math.round(ms / 3600_000));
    return `claim expires in ${hours} h`;
  };

  // ------------------------------------------------------------- the list
  let search = $state("");
  let filter = $state<"all" | "open" | "nearly" | "yours">("all");
  let sort = $state<"active" | "newest" | "progress">("active");
  let visibleCount = $state(PER_PAGE);
  // A changed search, filter or sort starts the listing over.
  $effect(() => {
    void search;
    void filter;
    void sort;
    visibleCount = PER_PAGE;
  });

  const matchesSearch = (s: CampaignStats) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [s.name, s.title, s.composer, ...Object.values(s.pieceNames)].some(
      (v) => v.toLowerCase().includes(q),
    );
  };
  const isOwned = (s: CampaignStats) =>
    Boolean(auth.user) && s.owner === auth.user!.login;
  const matchesFilter = (s: CampaignStats) =>
    filter === "open"
      ? s.ready > 0 || s.toValidate > 0
      : filter === "nearly"
        ? s.nearlyDone
        : filter === "yours"
          ? isOwned(s)
          : true;
  const filtered = $derived.by(() => {
    const list = stats.filter(matchesSearch).filter(matchesFilter);
    const ts = (v: string) => Date.parse(v || "0") || 0;
    if (sort === "newest") list.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    else if (sort === "progress")
      list.sort(
        (a, b) =>
          (b.total ? b.done / b.total : 0) - (a.total ? a.done / a.total : 0),
      );
    else list.sort((a, b) => ts(b.lastActivity) - ts(a.lastActivity));
    return list;
  });
  const shown = $derived(filtered.slice(0, visibleCount));
  const more = $derived(filtered.length - shown.length);
</script>

{#if runner.busy && runner.overlay}
  <LoadingOverlay
    log={runner.log}
    finished={runner.held}
    error={runner.result?.error}
    onContinue={() => runner.dismiss()}
  />
{/if}

<div class="screen">
  {#if runner.result}
    <div
      class="banner"
      class:ok={runner.result.ok && !runner.result.warn && !runner.result.error}
      class:warn={runner.result.warn}
      class:err={!!runner.result.error}
    >
      <span>
        {runner.result.error ?? runner.result.message}
        {#if runner.result.prUrl}
          <a href={runner.result.prUrl} target="_blank" rel="noreferrer"
            >View PR →</a
          >
        {/if}
      </span>
      <button
        type="button"
        class="dismiss"
        onclick={() => (runner.result = null)}>Dismiss</button
      >
    </div>
  {/if}

  {#if auth.user && (fix.length > 0 || openComments.length > 0)}
    <section class="block">
      <div class="slabel danger">
        <img class="hand-attn" src="/attention-hand.svg" alt="" />Needs your attention
      </div>
      <div class="rows">
        {#each fix as t (t.campaignSlug + t.task)}
          <a class="row attention" href={taskHref(t.campaignSlug, t.task)}>
            <span class="pill red">Fix requested</span>
            <span class="rowtitle">{taskLine(t)}</span>
            {#if t.failComment}
              <span class="excerpt"
                >@{handle(t.logins, t.failComment.author_id)}: “{t.failComment
                  .body}”</span
              >
            {/if}
            <span class="spacer"></span>
            <span class="golink red">Open task →</span>
          </a>
        {/each}
        {#each openComments as f (f.comment.comment_id || f.comment.timestamp + f.task)}
          <a class="row" href={taskHref(f.campaignSlug, f.task)}>
            <span class="pill {f.comment.kind === 'question' ? 'blue' : 'grey'}"
              >{f.comment.kind === "question" ? "Question" : "Note"}</span
            >
            <span class="rowtitle">{f.taskTitle}</span>
            <span class="excerpt"
              >@{handle(f.logins, f.comment.author_id)}: “{f.comment
                .body}”</span
            >
            <span class="spacer"></span>
            <span class="golink">Reply →</span>
          </a>
        {/each}
      </div>
    </section>
  {/if}

  {#if auth.user}
    <section class="block">
      <div class="shead">
        <div class="slabel">Your open work</div>
        <span class="smeta"
          >{since ? `contributing since ${since} · ` : ""}{done.length} completed</span
        >
        <span class="spacer"></span>
        {#if done.length > 0}
          <button
            type="button"
            class="expander"
            onclick={() => (showCompleted = !showCompleted)}
            >{done.length} completed {showCompleted ? "▾" : "▸"}</button
          >
        {/if}
      </div>
      <div class="rows">
        {#if listLoading && tasks.length === 0}
          <p class="note">Looking for your claimed tasks…</p>
        {:else if encoding.length === 0 && validating.length === 0 && awaiting.length === 0 && fix.length === 0}
          <p class="note">
            Nothing in motion — claim a task from a campaign below.
          </p>
        {/if}
        {#each encoding as t (t.campaignSlug + t.task)}
          <div class="row">
            <span class="rowtitle">{taskLine(t)}</span>
            <span class="pill blue">encoding</span>
            <span class="rowmeta"
              >claimed {ago(t.claimedAt)}{expiresIn(t)
                ? ` · ${expiresIn(t)}`
                : ""}</span
            >
            <span class="spacer"></span>
            <button
              type="button"
              class="btn"
              disabled={runner.busy}
              onclick={() => openEditor(t)}>Open editor ↗</button
            >
            <button
              type="button"
              class="btn btn-soft"
              disabled={runner.busy}
              onclick={() => submit(t)}>Submit</button
            >
          </div>
        {/each}
        {#each validating as t (t.campaignSlug + t.task)}
          <div class="row">
            <span class="rowtitle">{taskLine(t)}</span>
            <span class="pill grey">validating</span>
            <span class="rowmeta"
              >claimed {ago(t.claimedAt)}{expiresIn(t)
                ? ` · ${expiresIn(t)}`
                : ""}</span
            >
            <span class="spacer"></span>
            <a class="golink" href={taskHref(t.campaignSlug, t.task)}
              >Details →</a
            >
          </div>
        {/each}
        {#each awaiting as t (t.campaignSlug + t.task)}
          <div class="row">
            <span class="rowtitle">{taskLine(t)}</span>
            <span class="pill green">awaiting validation</span>
            <span class="rowmeta"
              >{t.submittedAt ? `submitted ${ago(t.submittedAt)} · ` : ""}{t.passes}
              of {t.threshold} passes</span
            >
            <span class="spacer"></span>
            <a class="golink" href={taskHref(t.campaignSlug, t.task)}
              >Details →</a
            >
          </div>
        {/each}
        {#if showCompleted}
          {#each done.slice(0, 10) as t (t.campaignSlug + t.task)}
            <a class="row donerow" href={taskHref(t.campaignSlug, t.task)}>
              <span class="check">✓</span>
              <span class="rowtitle">{taskLine(t)}</span>
              <span class="spacer"></span>
              <span class="rowmeta"
                >passed {t.passes} of {t.threshold}{t.submittedAt
                  ? ` · ${ago(t.submittedAt)}`
                  : ""}</span
              >
            </a>
          {/each}
        {/if}
      </div>
    </section>
  {/if}

  <section class="block grow">
    <div class="filterbar">
      <span class="glass">⌕</span>
      <input
        type="text"
        bind:value={search}
        placeholder="Search campaigns, composers, pieces…"
        aria-label="Search campaigns"
      />
      <div class="seg">
        <button
          type="button"
          class:on={filter === "all"}
          onclick={() => (filter = "all")}>All</button
        >
        <button
          type="button"
          class:on={filter === "open"}
          onclick={() => (filter = "open")}>Open to claim</button
        >
        <button
          type="button"
          class:on={filter === "nearly"}
          onclick={() => (filter = "nearly")}>Nearly done</button
        >
        {#if auth.user}
          <button
            type="button"
            class="yoursopt"
            class:on={filter === "yours"}
            onclick={() => (filter = "yours")}>Yours</button
          >
        {/if}
      </div>
      <select class="sortsel" bind:value={sort} aria-label="Sort campaigns">
        <option value="active">Sort: recently active</option>
        <option value="newest">Sort: newest</option>
        <option value="progress">Sort: most progress</option>
      </select>
    </div>
    <div class="shead">
      <div class="slabel">All campaigns</div>
      <span class="countpill">{filtered.length}</span>
    </div>
    {#if listError}
      <p class="note">Couldn't load the campaigns: {listError}</p>
    {:else if listLoaded && stats.length === 0}
      <p class="note">No campaigns yet. Be the first to create one!</p>
    {:else if (listLoading || auth.status === "loading") && stats.length === 0}
      <p class="note">Loading campaigns…</p>
    {:else if shown.length === 0}
      <p class="note">No campaign matches.</p>
    {:else}
      <div class="shelf">
        {#each shown as s (s.repoId)}
          <CampaignRow
            stats={s}
            owned={isOwned(s)}
            viewer={viewer ?? ""}
            busy={runner.busy}
            onact={claimNext}
          />
        {/each}
      </div>
      {#if more > 0}
        <button
          type="button"
          class="showmore"
          onclick={() => (visibleCount += PER_PAGE)}
          >Show {Math.min(PER_PAGE, more)} more campaign{Math.min(
            PER_PAGE,
            more,
          ) === 1
            ? ""
            : "s"} ▾</button
        >
      {/if}
    {/if}
    {#if !listError && listFailed > 0}
      <p class="note partial">
        {listFailed} campaign{listFailed === 1 ? "" : "s"} couldn't be loaded
        — {listFailureMessage}
      </p>
    {/if}
    {#if !auth.user && auth.status === "anonymous"}
      <p class="note login-hint">
        Browsing works logged out —
        <button type="button" class="linkish" onclick={() => login()}
          >log in with GitHub</button
        > to claim a task or see your work here.
      </p>
    {/if}
  </section>

  {#if auth.user}
    <CampaignDrafts />
  {/if}
</div>

<style>
  .screen {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 20px 32px 16px;
    /* The content stops widening at --page-max and centres past it, while the
       page gradient keeps running to both edges. */
    padding-inline: max(32px, calc((100% - var(--page-max)) / 2 + 32px));
    box-sizing: border-box;
    background:
      radial-gradient(60% 90% at 15% 0%, var(--glow-blue), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, var(--glow-green), transparent 60%),
      var(--bg-alt);
  }
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
  .note.partial {
    font-size: 12.5px;
    color: var(--warn);
  }
  .block {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .block.grow {
    flex: 1;
  }
  .shead {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .slabel {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-faint);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .slabel.danger {
    color: var(--danger);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* The orange finger-up hand leads the attention section. */
  .hand-attn {
    height: 24px;
    flex: none;
  }
  .smeta {
    font-size: 12px;
    color: var(--ink-faint);
  }
  .expander {
    font: 600 12.5px var(--font);
    color: var(--ink-faint);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .expander:hover {
    color: var(--accent);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 16px;
    color: inherit;
    text-decoration: none;
    min-width: 0;
  }
  a.row:hover {
    border-color: var(--info-line);
  }
  .row.attention {
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }
  a.row.attention:hover {
    border-color: var(--danger);
  }
  .rowtitle {
    flex: none;
    font-size: 13.5px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }
  .excerpt {
    font-size: 13px;
    color: var(--ink-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .rowmeta {
    font-size: 12.5px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .pill {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 9px;
    white-space: nowrap;
  }
  .pill.red {
    color: var(--danger);
    background: var(--card);
    border: 1px solid var(--danger-line);
  }
  .pill.blue {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .pill.green {
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid var(--ok-line);
  }
  .pill.grey {
    color: var(--ink-faint);
    background: var(--bg-tint);
    border: 1px solid var(--line);
  }
  .golink {
    flex: none;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--link);
    text-decoration: none;
  }
  .golink.red {
    color: var(--danger);
  }
  .donerow {
    color: var(--ink-faint);
  }
  .donerow .rowtitle {
    font-weight: 500;
    color: var(--ink-soft);
  }
  .check {
    color: var(--ok);
    font-weight: 600;
  }
  /* The one search & filter bar above the listing. */
  .filterbar {
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 999px;
    box-shadow: var(--shadow-sm);
    padding: 8px 18px;
  }
  .filterbar:focus-within {
    border-color: var(--accent);
  }
  .glass {
    color: var(--ink-faint);
    font-size: 14px;
  }
  .filterbar input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: none;
    font: 400 13px var(--font);
    background: transparent;
    color: var(--ink);
  }
  .filterbar input::placeholder {
    color: var(--ink-faint);
  }
  .yoursopt {
    color: var(--owner);
  }
  .seg > button.yoursopt.on {
    color: var(--owner);
  }
  .sortsel {
    flex: none;
    font: 600 12px var(--font);
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    padding: 5px 12px;
    cursor: pointer;
  }
  .countpill {
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-soft);
    background: var(--bg-tint);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .shelf {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .showmore {
    align-self: center;
    font: 600 12.5px var(--font);
    color: var(--link);
    background: none;
    border: 0;
    padding: 4px 8px;
    cursor: pointer;
  }
  .showmore:hover {
    text-decoration: underline;
  }
  .login-hint {
    text-align: center;
    font-size: 12.5px;
    color: var(--ink-faint);
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
  /* Banner styles are shared app-wide in ui.css. */
</style>
