<!--
  The dashboard rail's "Your work" panel: one row per task the viewer has in
  motion across every campaign, urgency first. A fail expands inline with the
  validator's comment; every row links into its campaign console with the task
  overlay opened.
-->
<script lang="ts">
  import { elapsed } from "$lib/campaign-board.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import type { MyTask } from "$lib/campaign-stats.ts";

  let { tasks, loading }: { tasks: MyTask[]; loading: boolean } = $props();

  const order: Record<MyTask["group"], number> = {
    fix: 0,
    encoding: 1,
    awaiting: 2,
    done: 3,
  };
  const active = $derived(
    tasks
      .filter((t) => t.group !== "done")
      .sort((a, b) => order[a.group] - order[b.group]),
  );
  const taskHref = (t: MyTask) =>
    `/${t.campaignSlug}?task=${encodeURIComponent(t.task)}`;
  const handleOf = (t: MyTask, id: string) => handle(t.logins, id);
  const sub = (t: MyTask): string => {
    if (t.group === "encoding")
      return `${t.campaignSlug} · encoding · claimed ${elapsed(t.claimedAt)} ago`;
    if (t.group === "awaiting")
      return `${t.campaignSlug} · awaiting validation · ${t.passes} of ${t.threshold} passes`;
    return t.campaignSlug;
  };
</script>

<div class="panel">
  <div class="head">
    <span class="label">Your work · {active.length}</span>
    <a class="linkish-a" href="/dashboard">Your dashboard →</a>
  </div>
  {#if loading && active.length === 0}
    <p class="empty">Looking for your claimed tasks…</p>
  {:else if active.length === 0}
    <p class="empty">Nothing claimed right now — pick a task from a campaign.</p>
  {:else}
    {#each active as t (t.campaignSlug + t.task)}
      {#if t.group === "fix"}
        <div class="failbox">
          <a class="row" href={taskHref(t)}>
            <span class="dot dot-fail"></span>
            <span class="row-body">
              <span class="row-title"
                >{t.title}
                <span class="failchip"
                  >{t.dots.filter((d) => d === "fail").length} fail{t.dots.filter(
                    (d) => d === "fail",
                  ).length === 1
                    ? ""
                    : "s"}</span
                ></span
              >
              <span class="row-sub">
                {t.campaignSlug}{#if t.failComment}
                  · “{t.failComment.body}” — {handleOf(
                    t,
                    t.failComment.author_id,
                  )}{/if}
              </span>
            </span>
          </a>
          <a class="openlink" href={taskHref(t)}>Open the task →</a>
        </div>
      {:else}
        <a class="row" href={taskHref(t)}>
          <span class="dot dot-{t.group}"></span>
          <span class="row-body">
            <span class="row-title">{t.title}</span>
            <span class="row-sub">{sub(t)}</span>
          </span>
        </a>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .panel {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.06);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow: auto;
  }
  .head {
    display: flex;
    align-items: baseline;
  }
  .label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .linkish-a {
    margin-left: auto;
    font-size: 12px;
    font-weight: 600;
    color: var(--link);
    text-decoration: none;
  }
  .linkish-a:hover {
    text-decoration: underline;
  }
  .empty {
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    text-decoration: none;
    color: var(--ink);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    margin-top: 5px;
  }
  .dot-encoding {
    background: var(--info);
  }
  .dot-fail {
    background: var(--danger);
  }
  .dot-awaiting {
    background: var(--warn);
  }
  .row-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .row-title {
    font-size: 13px;
    font-weight: 600;
  }
  .row-title:hover {
    color: var(--accent);
  }
  .row-sub {
    font-size: 11.5px;
    color: var(--ink-faint);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .failchip {
    font-size: 11px;
    font-weight: 700;
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
    border-radius: 999px;
    padding: 1px 7px;
    margin-left: 4px;
  }
  .failbox {
    border: 1px solid var(--danger-line);
    background: var(--danger-wash);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .openlink {
    font-size: 12px;
    font-weight: 600;
    padding-left: 17px;
    color: var(--link);
    text-decoration: none;
  }
  .openlink:hover {
    text-decoration: underline;
  }
</style>
