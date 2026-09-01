<!--
  One discussion comment as a card: avatar, author, elapsed/measure meta, the
  kind pill, body, measure anchor and the reply/resolve actions. Replies
  render indented without pill or actions. Shared by the comments panel and
  the task panel's discussion.
-->
<script lang="ts">
  import { auth } from "$lib/auth.svelte.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { handle } from "$lib/campaign-graph.ts";
  import { elapsed, initialOf } from "$lib/campaign-board.ts";

  let {
    comment,
    logins,
    viewer,
    canPush,
    runner,
    review = false,
    reply = false,
    inScore = false,
    onanchor,
    onreply,
    onresolve,
  }: {
    comment: CommentRow;
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    /** Tint the card's edge in the review colour instead of encoding blue. */
    review?: boolean;
    /** Render as an indented reply: no pill, no actions. */
    reply?: boolean;
    /** Anchor links read as in-view highlights instead of score links. */
    inScore?: boolean;
    /** Show the comment's measure range in the score. */
    onanchor: (comment: CommentRow) => void;
    /** Start a reply to this comment; absent hides the Reply action. */
    onreply?: (comment: CommentRow) => void;
    onresolve: (comment_id: string) => Promise<void>;
  } = $props();

  const login = $derived(handle(logins, comment.author_id));
  const resolved = $derived(comment.resolved === "true");
  const canResolve = $derived(
    viewer !== "" && (canPush || comment.author_id === viewer),
  );

  let resolving = $state(false);
  // Pending from the click until the resolution PR's verdict lands: first the
  // foreground command, then its background entry in the verdict store.
  const resolvePending = $derived(
    resolving || pendingVerdicts.isProcessing(`resolve:${comment.comment_id}`),
  );

  async function resolve() {
    resolving = true;
    try {
      await onresolve(comment.comment_id);
    } finally {
      resolving = false;
    }
  }

  const measureLabel = $derived(
    comment.measure_start
      ? `m. ${comment.measure_start}${comment.measure_end && comment.measure_end !== comment.measure_start ? `–${comment.measure_end}` : ""}`
      : comment.page
        ? `page ${comment.page}`
        : "",
  );
  const anchorLabel = $derived(
    inScore
      ? `◉ ${measureLabel}${comment.page ? ` — highlighted on page ${comment.page}` : ""}`
      : `${measureLabel} — show in score →`,
  );
</script>

<div class="ccard" class:review class:reply class:resolved>
  <div class="chead">
    <span class="avatar">{initialOf(login)}</span>
    <span class="cwho">{login}</span>
    <span class="cmeta">
      {#if reply}
        · {elapsed(comment.timestamp)} · ↳ reply
      {:else}
        · {elapsed(comment.timestamp)}{measureLabel
          ? ` · ${measureLabel}`
          : ""}{resolved ? " · resolved" : ""}
      {/if}
    </span>
    {#if !reply}
      {#if comment.kind === "question"}
        <span class="kindpill question">question</span>
      {:else}
        <span class="kindpill note">note</span>
      {/if}
    {/if}
  </div>
  <span class="cbody">{comment.body}</span>
  {#if !reply && measureLabel}
    <button type="button" class="anchor" onclick={() => onanchor(comment)}>
      {anchorLabel}
    </button>
  {/if}
  {#if !reply && ((onreply && auth.user) || (!resolved && canResolve))}
    <div class="cacts">
      {#if onreply && auth.user}
        <button type="button" class="linkish" onclick={() => onreply(comment)}>
          Reply
        </button>
      {/if}
      {#if !resolved && canResolve}
        {#if resolvePending}
          <span class="resolving">
            <span class="spinner" aria-hidden="true"></span>
            Resolving…
          </span>
        {:else}
          <button
            type="button"
            class="linkish"
            onclick={resolve}
            disabled={runner.busy}
          >
            Resolve
          </button>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .ccard {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--card);
    border: 1px solid var(--line);
    border-left: 3px solid var(--info);
    border-radius: 10px;
    padding: 10px 12px;
  }
  .ccard.review {
    border-left-color: var(--warn);
  }
  .ccard.reply {
    margin-left: 14px;
  }
  .ccard.resolved {
    opacity: 0.55;
  }
  .chead {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
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
  .cwho {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--ink);
  }
  .cmeta {
    font-size: 11px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kindpill {
    margin-left: auto;
    font-size: 10.5px;
    font-weight: 600;
    border-radius: 999px;
    padding: 1px 7px;
    flex: none;
  }
  .kindpill.question {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .kindpill.note {
    color: var(--warn);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
  }
  .cbody {
    font-size: 12px;
    color: var(--ink);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .anchor {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--info);
    cursor: pointer;
    background: none;
    border: none;
    padding: 0;
    text-align: left;
    font-family: inherit;
  }
  .cacts {
    display: flex;
    align-items: center;
    gap: 12px;
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
  .linkish {
    font: inherit;
    font-size: 11px;
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
</style>
