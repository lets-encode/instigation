<!--
  The personal dashboard: the viewer's claimed work across every campaign,
  grouped by what needs doing (fix requested → encoding → awaiting validation →
  recently completed), with every comment on their work as a feed on the right.
  Actions run the same commands as the campaign console, against the campaign
  the task lives in; anything richer deep-links into that console. The name
  "dashboard" is reserved in the slug registry, so no campaign can shadow this
  route.
-->
<script lang="ts">
  import { auth, forge, login } from "$lib/auth.svelte.ts";
  import { createForge } from "$lib/forge/index.ts";
  import { provider, meiFriendUrl } from "$lib/forge/config.ts";
  import { commands, invoke } from "$lib/commands.ts";
  import type { CommandContext, Result } from "$lib/commands.ts";
  import { elapsed } from "$lib/campaign-board.ts";
  import {
    commentsOnMyWork,
    invalidateStats,
    loadCampaignStats,
    myTasksIn,
  } from "$lib/campaign-stats.ts";
  import type {
    CampaignStats,
    FeedComment,
    MyTask,
  } from "$lib/campaign-stats.ts";
  import type { RepoSummary } from "$lib/forge/github-rest.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import LoadingOverlay from "$lib/components/LoadingOverlay.svelte";
  import { ProgressLog } from "$lib/progress-log.svelte.ts";

  const viewer = $derived(auth.user?.id != null ? String(auth.user.id) : "");
  const readForge = () => forge() ?? createForge("");

  let stats = $state<CampaignStats[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (auth.status === "loading" || !auth.user || loaded || loading) return;
    loading = true;
    loadAll().finally(() => {
      loading = false;
      loaded = true;
    });
  });

  async function loadAll() {
    const f = readForge();
    let repos: RepoSummary[];
    try {
      repos = await f.searchReposByTopic(provider.repoTopic);
    } catch (err) {
      error = (err as Error).message;
      return;
    }
    error = null;
    const all = await Promise.all(
      repos.map((repo) => loadCampaignStats(f, repo).catch(() => null)),
    );
    stats = all.filter((s): s is CampaignStats => s !== null);
  }

  const tasks = $derived(stats.flatMap((s) => myTasksIn(s, viewer)));
  const fix = $derived(tasks.filter((t) => t.group === "fix"));
  const encoding = $derived(tasks.filter((t) => t.group === "encoding"));
  const awaiting = $derived(tasks.filter((t) => t.group === "awaiting"));
  const done = $derived(
    tasks
      .filter((t) => t.group === "done")
      .sort(
        (a, b) =>
          Date.parse(b.submittedAt || "0") - Date.parse(a.submittedAt || "0"),
      ),
  );
  const activeCount = $derived(tasks.length - done.length);

  const feed = $derived(
    stats
      .flatMap((s) => commentsOnMyWork(s, viewer))
      .sort(
        (a, b) =>
          Date.parse(b.comment.timestamp || "0") -
          Date.parse(a.comment.timestamp || "0"),
      ),
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
  let busy = $state(false);
  const busyLog = new ProgressLog();
  let result = $state<Result | null>(null);

  const ctxFor = (t: MyTask): CommandContext | null => {
    const s = stats.find((x) => x.name === t.campaignSlug);
    if (!s) return null;
    return {
      forge: readForge(),
      repoId: s.repoId,
      owner: s.owner,
      repo: s.repo,
      viewer,
      viewerLogin: auth.user?.login ?? "",
      meiFriendUrl,
      progress: (u) => {
        if (u.step) busyLog.step(u.step);
        if (u.detail) busyLog.detail(u.detail);
      },
    };
  };

  async function run(t: MyTask, command: (c: CommandContext) => Promise<Result>) {
    const c = ctxFor(t);
    if (!c || busy) return;
    busy = true;
    busyLog.clear();
    try {
      result = await command(c);
      busyLog.step("Refreshing…");
      invalidateStats();
      loaded = false;
      stats = [];
    } finally {
      busyLog.done();
      busy = false;
    }
  }

  const openEditor = async (t: MyTask) => {
    await run(t, (c) => invoke(commands.openEditor, { task_id: t.task }, c));
    if (result?.ok && !result.warn && result.meiFriendUrl) {
      window.open(result.meiFriendUrl, "_blank", "noopener");
    }
  };
  const submit = (t: MyTask) =>
    run(t, (c) => invoke(commands.submitEncoding, { task_id: t.task }, c));

  const taskHref = (slug: string, task: string) =>
    `/${slug}?task=${encodeURIComponent(task)}`;

  const handleOf = (logins: Record<string, string>, id: string) =>
    logins[id] || id;
  const initialOf = (name: string) => name[0]?.toUpperCase() ?? "?";
  const ago = (iso: string) => {
    const e = elapsed(iso);
    return e === "now" ? "just now" : `${e} ago`;
  };
  const anchorChip = (c: CommentRow): string => {
    if (!c.page && !c.measure_start) return "";
    const range =
      c.measure_end && c.measure_end !== c.measure_start
        ? `m. ${c.measure_start}–${c.measure_end}`
        : c.measure_start
          ? `m. ${c.measure_start}`
          : "";
    return [c.page ? `p. ${c.page}` : "", range].filter(Boolean).join(" · ");
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
  const kindOf = (c: CommentRow): { label: string; cls: string } => {
    if (c.resolved === "true") return { label: "resolved", cls: "grey" };
    if (c.kind === "fail") return { label: "fail", cls: "red" };
    if (c.kind === "question") return { label: "question", cls: "blue" };
    if (c.kind === "reply") return { label: "reply", cls: "grey" };
    return { label: c.kind, cls: "grey" };
  };
</script>

{#if busy}
  <LoadingOverlay log={busyLog} />
{/if}

<div class="wrap">
  {#if auth.status === "loading"}
    <p class="note">Checking your session…</p>
  {:else if !auth.user}
    <div class="loginbox">
      <p class="note">Your dashboard shows the tasks you have claimed and the
        comments on your work — log in with GitHub to see it.</p>
      <button type="button" class="btn btn-primary" onclick={() => login()}>
        Log in with GitHub
      </button>
    </div>
  {:else}
    <div class="hero">
      <div class="hero-titles">
        <div class="eyebrow">Your work</div>
        <div class="hero-line">
          <h1>{auth.user.login}</h1>
          <span class="hero-sub"
            >{activeCount} active · {done.length} completed{since
              ? ` · contributing since ${since}`
              : ""}</span
          >
        </div>
      </div>
      <a class="findbtn" href="/">Find a new task →</a>
    </div>

    {#if result}
      <div
        class="banner"
        class:ok={result.ok && !result.warn && !result.error}
        class:warn={result.warn}
        class:err={!!result.error}
      >
        <span>{result.error ?? result.message}</span>
        {#if result.prUrl}
          <a href={result.prUrl} target="_blank" rel="noreferrer">View PR →</a>
        {/if}
        <button type="button" class="dismiss" onclick={() => (result = null)}
          >×</button
        >
      </div>
    {/if}

    <div class="cols">
      <div class="groups">
        {#if error}
          <p class="note">Couldn't load your work: {error}</p>
        {:else if loading && tasks.length === 0}
          <p class="note">Looking for your claimed tasks…</p>
        {:else if tasks.length === 0}
          <p class="note">
            Nothing in motion — <a href="/">find a task to claim</a>.
          </p>
        {/if}

        {#if fix.length > 0}
          <div class="group">
            <span class="glabel red">Fix requested · {fix.length}</span>
            {#each fix as t (t.campaignSlug + t.task)}
              <div class="gcard fixcard">
                <div class="gline">
                  <span class="gtitle">{t.title}</span>
                  <span class="mono repo">{t.repoPath}</span>
                  <span class="gpill red">validation failed</span>
                  <span class="gspacer"></span>
                  {#if t.submittedAt}
                    <span class="gwhen">submitted {ago(t.submittedAt)}</span>
                  {/if}
                </div>
                {#if t.failComment}
                  <div class="quotebox">
                    <div class="qline">
                      <span class="avatar"
                        >{initialOf(
                          handleOf(t.logins, t.failComment.author_id),
                        )}</span
                      >
                      <span class="qauthor"
                        >{handleOf(t.logins, t.failComment.author_id)}</span
                      >
                      {#if anchorChip(t.failComment)}
                        <span class="mono anchor">{anchorChip(t.failComment)}</span>
                      {/if}
                      {#if t.failComment.timestamp}
                        <span class="gwhen">{ago(t.failComment.timestamp)}</span>
                      {/if}
                    </div>
                    <div class="qbody">“{t.failComment.body}”</div>
                  </div>
                {/if}
                <div class="acts">
                  <button
                    type="button"
                    class="abtn primary"
                    disabled={busy}
                    onclick={() => openEditor(t)}>Open in mei-friend ↗</button
                  >
                  <a class="abtn" href={taskHref(t.campaignSlug, t.task)}
                    >Reply</a
                  >
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if encoding.length > 0}
          <div class="group">
            <span class="glabel blue">Encoding now · {encoding.length}</span>
            {#each encoding as t (t.campaignSlug + t.task)}
              <div class="gcard enccard">
                <div class="gline">
                  <span class="gtitle">{t.title}</span>
                  <span class="mono repo">{t.repoPath}</span>
                  <span class="gpill blue">encoding</span>
                  <span class="gspacer"></span>
                  <span class="gwhen"
                    >claimed {ago(t.claimedAt)}{expiresIn(t)
                      ? ` · ${expiresIn(t)}`
                      : ""}</span
                  >
                </div>
                <div class="acts">
                  <button
                    type="button"
                    class="abtn primary"
                    disabled={busy}
                    onclick={() => openEditor(t)}>Open in mei-friend ↗</button
                  >
                  <button
                    type="button"
                    class="abtn"
                    disabled={busy}
                    onclick={() => submit(t)}>Submit for validation</button
                  >
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if awaiting.length > 0}
          <div class="group">
            <span class="glabel orange"
              >Awaiting validation · {awaiting.length}</span
            >
            {#each awaiting as t (t.campaignSlug + t.task)}
              <a class="gcard rowcard" href={taskHref(t.campaignSlug, t.task)}>
                <span class="gtitle">{t.title}</span>
                <span class="mono repo">{t.repoPath}</span>
                <span class="gpill orange"
                  >{t.passes} of {t.threshold} passes</span
                >
                <span class="dots">
                  {#each t.dots as d, i (i)}
                    <span class="sdot {d}"></span>
                  {/each}
                </span>
                <span class="gspacer"></span>
                {#if t.submittedAt}
                  <span class="gwhen">submitted {ago(t.submittedAt)}</span>
                {/if}
              </a>
            {/each}
          </div>
        {/if}

        {#if done.length > 0}
          <div class="group donegroup">
            <span class="glabel green">Recently completed · {done.length}</span>
            <div class="gcard donecard">
              {#each done.slice(0, 5) as t (t.campaignSlug + t.task)}
                <a
                  class="donerow"
                  href={taskHref(t.campaignSlug, t.task)}
                >
                  <span class="check">✓</span>
                  <span class="donetitle">{t.title}</span>
                  <span class="mono donerepo">{t.campaignSlug}</span>
                  <span class="gspacer"></span>
                  <span class="gwhen"
                    >passed {t.passes} of {t.threshold}{t.submittedAt
                      ? ` · ${ago(t.submittedAt)}`
                      : ""}</span
                  >
                </a>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <div class="feed">
        <div class="feedcard">
          <span class="glabel plain">Comments on your work</span>
          {#if feed.length === 0}
            <p class="note small">
              {loading ? "Loading…" : "No comments on your work yet."}
            </p>
          {/if}
          {#each feed as f (f.comment.comment_id || f.comment.timestamp + f.task)}
            {@const kind = kindOf(f.comment)}
            <div class="fitem" class:resolved={f.comment.resolved === "true"}>
              <div class="fline">
                <span
                  class="fdot"
                  class:red={kind.cls === "red"}
                  class:blue={kind.cls === "blue"}
                ></span>
                <span class="avatar"
                  >{initialOf(handleOf(f.logins, f.comment.author_id))}</span
                >
                <span class="qauthor"
                  >{handleOf(f.logins, f.comment.author_id)}</span
                >
                <span class="gpill {kind.cls}">{kind.label}</span>
                {#if f.comment.timestamp}
                  <span class="gwhen right">{ago(f.comment.timestamp)}</span>
                {/if}
              </div>
              <div class="qbody indent">“{f.comment.body}”</div>
              <div class="fmeta indent">
                <span class="mono anchor"
                  >{f.taskTitle}{anchorChip(f.comment)
                    ? ` · ${anchorChip(f.comment)}`
                    : ""}</span
                >
                {#if f.comment.resolved !== "true"}
                  <a class="replylink" href={taskHref(f.campaignSlug, f.task)}
                    >Reply →</a
                  >
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .wrap {
    min-height: 100%;
    box-sizing: border-box;
    padding: 24px 32px;
    background:
      radial-gradient(60% 90% at 15% 0%, rgba(109, 195, 255, 0.12), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, rgba(118, 222, 118, 0.12), transparent 60%),
      radial-gradient(50% 80% at 50% 100%, rgba(255, 167, 109, 0.1), transparent 60%);
  }
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
  .note.small {
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .note a {
    color: var(--link);
  }
  .loginbox {
    max-width: 34rem;
    margin: 3rem auto;
    text-align: center;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 2.5rem 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    align-items: center;
  }
  .hero {
    display: flex;
    align-items: flex-end;
    gap: 24px;
    padding-bottom: 18px;
  }
  .hero-titles {
    flex: 1;
    min-width: 0;
  }
  .eyebrow {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .hero-line {
    display: flex;
    align-items: baseline;
    gap: 14px;
    margin-top: 4px;
  }
  h1 {
    margin: 0;
    font-size: 30px;
    font-weight: 700;
  }
  .hero-sub {
    font-size: 13px;
    color: var(--ink-faint);
  }
  .findbtn {
    font: 600 13px var(--font);
    padding: 8px 18px;
    border-radius: 999px;
    background: var(--accent-btn);
    color: #fff;
    text-decoration: none;
    box-shadow: 0 1px 3px rgba(37, 99, 201, 0.3);
  }
  .findbtn:hover {
    background: var(--accent-btn-hover);
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 10px 14px;
    margin-bottom: 14px;
    font-size: 13px;
    background: var(--card);
  }
  .banner.ok {
    color: var(--ok);
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }
  .banner.warn {
    color: var(--warn);
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .banner.err {
    color: var(--danger);
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }
  .banner a {
    font-weight: 600;
    color: inherit;
  }
  .dismiss {
    margin-left: auto;
    font-size: 16px;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  .cols {
    display: flex;
    gap: 20px;
    align-items: flex-start;
  }
  .groups {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .glabel {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .glabel.red {
    color: var(--danger);
  }
  .glabel.blue {
    color: var(--info);
  }
  .glabel.orange {
    color: var(--warn);
  }
  .glabel.green {
    color: var(--ok);
  }
  .glabel.plain {
    color: var(--ink-faint);
  }
  .gcard {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.05);
  }
  .fixcard {
    border: 1.5px solid var(--danger-line);
  }
  .enccard {
    border: 1.5px solid var(--info-line);
  }
  .rowcard {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    color: var(--ink);
  }
  .rowcard:hover {
    border-color: var(--info-line);
  }
  .gline {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .gtitle {
    font-size: 15px;
    font-weight: 700;
  }
  .mono {
    font-family: ui-monospace, Menlo, monospace;
  }
  .repo {
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .gpill {
    font-size: 11px;
    font-weight: 700;
    border-radius: 999px;
    padding: 1px 8px;
    white-space: nowrap;
  }
  .gpill.red {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
  .gpill.blue {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .gpill.orange {
    color: var(--warn);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
  }
  .gpill.grey {
    color: var(--ink-faint);
    background: var(--bg-tint);
    border: 1px solid var(--line);
  }
  .gspacer {
    flex: 1;
  }
  .gwhen {
    font-size: 11.5px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .gwhen.right {
    margin-left: auto;
  }
  .quotebox {
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .qline {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--warn-solid);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .qauthor {
    font-size: 12px;
    font-weight: 600;
  }
  .anchor {
    font-size: 11px;
    font-weight: 700;
    color: var(--ink-soft);
    background: var(--bg-tint);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px;
  }
  .qbody {
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  .acts {
    display: flex;
    gap: 10px;
  }
  .abtn {
    font: 600 12.5px var(--font);
    padding: 6px 15px;
    border-radius: 999px;
    border: 1px solid var(--line-input);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    text-decoration: none;
  }
  .abtn:hover:not(:disabled) {
    border-color: var(--info-line);
    color: var(--accent);
  }
  .abtn.primary {
    border: 0;
    background: var(--accent-btn);
    color: #fff;
  }
  .abtn.primary:hover:not(:disabled) {
    background: var(--accent-btn-hover);
  }
  .abtn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .dots {
    display: flex;
    gap: 4px;
  }
  .sdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line-input);
  }
  .sdot.pass {
    background: var(--ok-soft);
    border-color: var(--ok-soft);
  }
  .sdot.fail {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
  }
  .donegroup {
    margin-top: auto;
  }
  .donecard {
    padding: 6px 18px;
    gap: 0;
  }
  .donerow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid var(--bg-tint);
    text-decoration: none;
    color: var(--ink);
  }
  .donerow:last-child {
    border-bottom: 0;
  }
  .check {
    color: var(--ok);
    font-size: 13px;
  }
  .donetitle {
    font-size: 13px;
    font-weight: 600;
  }
  .donerepo {
    font-size: 11px;
    color: var(--ink-faint);
  }
  .feed {
    flex: none;
    width: 430px;
  }
  .feedcard {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.06);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .fitem {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--bg-tint);
  }
  .fitem:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }
  .fitem.resolved {
    opacity: 0.55;
  }
  .fline {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ink-faint);
    flex: none;
  }
  .fdot.red {
    background: var(--danger);
  }
  .fdot.blue {
    background: var(--info);
  }
  .indent {
    padding-left: 16px;
  }
  .fmeta {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .replylink {
    font-size: 12px;
    font-weight: 600;
    color: var(--link);
    text-decoration: none;
  }
  .replylink:hover {
    text-decoration: underline;
  }
  @media (max-width: 1100px) {
    .cols {
      flex-direction: column;
    }
    .feed {
      width: 100%;
    }
  }
</style>
