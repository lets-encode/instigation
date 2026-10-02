<!--
  The side panel of every campaign view, always shown. With a task it holds
  the host's task box pinned on top, the task's comments and the composer;
  without one (task '') it holds the campaign comments. Beside the content
  it is resizable by its left edge; in portrait on a narrow screen
  (DOCKED_QUERY) it docks below the content, resizable by its top edge, and
  below PANEL_LOWERED shows only its task box. Sizes persist per browser
  (side-panels.ts).
-->
<script module lang="ts">
  // Whether resolved threads are hidden; held for the session across views.
  let hideResolved = $state(false);
</script>

<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import type { Snippet } from "svelte";
  import type { Result } from "$lib/commands.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { buildThreads } from "$lib/campaign-board.ts";
  import {
    DOCKED_QUERY,
    PANEL_LOWERED,
    defaultPanelHeight,
    writeSidePanel,
    type SidePanelState,
  } from "$lib/side-panels.ts";
  import Icon from "./Icon.svelte";
  import CommentCard from "./CommentCard.svelte";
  import CommentComposer from "./CommentComposer.svelte";
  import PanelResizeHandle from "./PanelResizeHandle.svelte";

  let {
    task,
    subtitle = "",
    zone = 0,
    comments,
    logins,
    viewer,
    canPush,
    runner,
    panel = $bindable(),
    review = false,
    inScore = false,
    composerHint = "",
    emptyLine = "",
    banner,
    taskBox,
    ondeselect,
    onanchor,
    oncomment,
    onresolve,
  }: {
    /** The task the panel shows, or '' for the campaign. */
    task: string;
    /** Shown after the heading, e.g. the task's piece. */
    subtitle?: string;
    /** The piece's colour slot, 1-based (--zone-N); 0 for none. */
    zone?: number;
    /** The whole comment log; the panel filters to its task. */
    comments: CommentRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    panel: SidePanelState;
    /** Tint the comments in the review colour. */
    review?: boolean;
    /** Anchor links read as in-view highlights instead of score links. */
    inScore?: boolean;
    /** Composer placeholder override (e.g. when a measure is selected). */
    composerHint?: string;
    /** The line shown in place of a task box, e.g. how to select a task. */
    emptyLine?: string;
    /** Rendered at the panel's top, e.g. the result of the last command. */
    banner?: Snippet;
    /** The task's record and controls, pinned above the comments. */
    taskBox?: Snippet;
    /** Return to the campaign; absent where the view is the task's own. */
    ondeselect?: () => void;
    /** Show a comment's measure range. */
    onanchor: (comment: CommentRow) => void;
    oncomment: (
      kind: string,
      body: string,
      parent_id: string,
    ) => Promise<Result | null>;
    onresolve: (comment_id: string) => Promise<unknown>;
  } = $props();

  const dockedQuery = new MediaQuery(DOCKED_QUERY, false);
  const docked = $derived(dockedQuery.current);
  // Docked, or in a window too short to hold the task box beside a list.
  const shortQuery = new MediaQuery("(max-height: 500px)", false);
  const cramped = $derived(docked || shortQuery.current);
  const lowered = $derived(docked && panel.height < PANEL_LOWERED);

  const allThreads = $derived(buildThreads(comments, task));
  const count = $derived(
    allThreads.reduce((n, t) => n + 1 + t.replies.length, 0),
  );
  // A thread is resolved with its root comment.
  const resolvedCount = $derived(
    allThreads.filter((t) => t.root.resolved === "true").length,
  );
  const threads = $derived(
    hideResolved
      ? allThreads.filter((t) => t.root.resolved !== "true")
      : allThreads,
  );

  // The comment a reply targets, shared by the thread list and the composer;
  // cleared when the panel changes task.
  let replyTo = $state<CommentRow | null>(null);
  $effect.pre(() => {
    void task;
    replyTo = null;
  });

  function raise() {
    panel.height = defaultPanelHeight(window.innerHeight);
    writeSidePanel({ ...panel });
  }
</script>

<div
  class="spwrap"
  class:docked
  class:cramped
  class:lowered
  style={docked
    ? lowered
      ? ""
      : `height: ${panel.height}px`
    : `width: ${panel.width}px`}
>
  <PanelResizeHandle label="Resize the side panel" bind:panel {docked} />
  <aside
    class="sp"
    style={zone ? `--zone: var(--zone-${zone})` : ""}
    aria-label={task ? "Task" : "Campaign"}
  >
    {@render banner?.()}
    <div class="sphead">
      {#if ondeselect}
        <button
          type="button"
          class="btn deselect"
          title="Deselect the task and show the campaign comments"
          onclick={ondeselect}><Icon name="arrow-left" /> Campaign</button
        >
        <span class="sep" aria-hidden="true">/</span>
      {/if}
      {#if zone}<span class="dot"></span>{/if}
      <h2 class="sptitle">{task ? "Task" : "Campaign"}</h2>
      {#if subtitle}<span class="spsub">· {subtitle}</span>{/if}
    </div>
    {#if taskBox}
      <div class="pinhead">{@render taskBox()}</div>
    {:else if emptyLine}
      <p class="empty">{emptyLine}</p>
    {/if}
    {#if lowered}
      <button type="button" class="btn showcomments" onclick={raise}
        >Show comments · {count}</button
      >
    {:else}
      <div class="clist">
        <div class="sechead" class:review>
          <span class="secdot"></span>
          {task ? "Comments" : "Campaign comments"}
          <span class="seccount">{count}</span>
          {#if resolvedCount > 0}
            <button
              type="button"
              class="chip-switch"
              class:on={hideResolved}
              onclick={() => (hideResolved = !hideResolved)}
              title="Hide the resolved threads"
              ><span class="sw"></span>Hide resolved · {resolvedCount}</button
            >
          {/if}
        </div>
        {#each threads as t (t.root.comment_id)}
          <CommentCard
            comment={t.root}
            {logins}
            {viewer}
            {canPush}
            {runner}
            {review}
            {inScore}
            {onanchor}
            onreply={(c) => (replyTo = c)}
            {onresolve}
          />
          {#each t.replies as reply (reply.comment_id)}
            <CommentCard
              comment={reply}
              {logins}
              {viewer}
              {canPush}
              {runner}
              {review}
              reply
              {inScore}
              {onanchor}
              {onresolve}
            />
          {/each}
        {/each}
        {#if threads.length === 0}
          <span class="cnone"
            >{allThreads.length === 0
              ? "No comments yet."
              : `${resolvedCount} resolved ${resolvedCount === 1 ? "thread" : "threads"} hidden.`}</span
          >
        {/if}
      </div>
      <CommentComposer
        {task}
        {logins}
        {runner}
        bind:replyTo
        placeholder={composerHint ||
          (task ? "Comment on this task…" : "Comment on the campaign…")}
        {oncomment}
      />
    {/if}
  </aside>
</div>

<style>
  /* Beside the content the panel runs the full row height; the task box
     stays pinned on top, the comments scroll and the composer stays pinned
     at the bottom. */
  .spwrap {
    flex: none;
    display: flex;
    min-height: 0;
    min-width: 0;
    align-self: stretch;
    /* The stored width is an inline style; a narrow window caps it. */
    max-width: 50vw;
  }
  /* Docked below the content: full width, the grip on the top edge. */
  .spwrap.docked {
    flex-direction: column;
    max-width: none;
    /* A height stored on a taller screen leaves room for the content. */
    max-height: calc(100vh - 160px);
    width: 100%;
    border-top: 1px solid var(--line-strong);
    box-shadow: 0 -2px 8px var(--shade);
    background: var(--bg-inset);
  }
  .sp {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-inset);
    box-shadow: var(--shadow-inset);
    border-radius: 12px;
    padding: 12px;
  }
  .docked .sp {
    border-radius: 0;
    box-shadow: none;
    padding: 0 12px 10px;
  }
  .sp :global(.banner) {
    margin: 0;
  }
  .sphead {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .deselect {
    flex: none;
  }
  .sep {
    color: var(--ink-faint);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone);
    flex: none;
  }
  .sptitle {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
  }
  .spsub {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The pinned task box keeps its controls in reach while the list scrolls;
     past its share of the panel it scrolls on its own. */
  .pinhead {
    flex: none;
    max-height: 55%;
    overflow-y: auto;
  }
  /* Docked or in a short window, the task box keeps its full height so its
     controls never scroll away inside it; the panel scrolls as a whole when
     it runs out of room. */
  .cramped .pinhead {
    max-height: none;
  }
  .cramped .sp {
    overflow-y: auto;
  }
  .cramped .clist {
    flex: 1 0 96px;
  }
  .empty {
    flex: none;
    margin: 0;
    font-size: 12.5px;
    color: var(--ink-soft);
    padding: 2px 2px;
  }
  .showcomments {
    flex: none;
  }
  .clist {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sechead {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-soft);
    padding: 4px 2px 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sechead.review {
    color: var(--warn);
  }
  .secdot {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    background: currentColor;
    flex: none;
  }
  .seccount {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    border-radius: 999px;
    line-height: 1;
    padding: 3px 7px;
    color: var(--ink-soft);
    background: var(--card);
    border: 1px solid var(--line);
  }
  .sechead .chip-switch {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }
  .cnone {
    font-size: 11.5px;
    color: var(--ink-soft);
    padding: 4px 2px;
  }
</style>
