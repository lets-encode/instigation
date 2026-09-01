<!--
  A task's discussion threads: questions and notes with their replies. The
  reply target is bound so the host's composer (CommentComposer) can pick it
  up — the two sit apart so the composer can stay pinned below a scrolling
  rail.
-->
<script lang="ts">
  import { auth } from "$lib/auth.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import { buildThreads, elapsed, initialOf } from "$lib/campaign-board.ts";

  let {
    taskId,
    comments,
    viewer,
    logins,
    canPush,
    runner,
    replyTo = $bindable(),
    onresolve,
  }: {
    taskId: string;
    comments: CommentRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    /** The comment a reply is being written to, shared with the composer. */
    replyTo: CommentRow | null;
    onresolve: (comment_id: string) => Promise<void>;
  } = $props();

  const threads = $derived(buildThreads(comments, taskId));

  const canResolve = (c: CommentRow) =>
    viewer !== "" && (canPush || c.author_id === viewer);

  let resolving = $state<string | null>(null);
  // Pending from the click until the resolution PR's verdict lands: first the
  // foreground command, then its background entry in the verdict store.
  const resolvePending = (comment_id: string) =>
    resolving === comment_id ||
    pendingVerdicts.isProcessing(`resolve:${comment_id}`);

  async function resolve(comment_id: string) {
    resolving = comment_id;
    try {
      await onresolve(comment_id);
    } finally {
      resolving = null;
    }
  }

  const commentLogin = (c: CommentRow) => handle(logins, c.author_id);
</script>

<div class="rsec discussion">
  <div class="rlabel">
    Discussion · {threads.reduce((n, t) => n + 1 + t.replies.length, 0)}
  </div>
  {#each threads as t (t.root.comment_id)}
    <div class="crow" class:resolved={t.root.resolved === "true"}>
      <div class="chead">
        <span class="avatar small">{initialOf(commentLogin(t.root))}</span>
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
          {#if resolvePending(t.root.comment_id)}
            <span class="resolving">
              <span class="spinner" aria-hidden="true"></span>
              Resolving…
            </span>
          {:else}
            <button
              type="button"
              class="linkish"
              onclick={() => resolve(t.root.comment_id)}
              disabled={runner.busy || resolving !== null}>Resolve</button
            >
          {/if}
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

<style>
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
    font-weight: 600;
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
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
  .rlabel {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    padding-bottom: 4px;
  }
  .small-note {
    font-size: 11.5px;
    white-space: nowrap;
  }
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
    align-items: center;
    gap: 12px;
    margin-top: 6px;
  }
  .resolving {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .spinner {
    flex: none;
    width: 10px;
    height: 10px;
    border: 2px solid var(--line);
    border-top-color: var(--accent);
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
  .creply {
    padding: 10px 0 0 18px;
  }
  .cnone {
    padding: 8px 0;
  }
</style>
