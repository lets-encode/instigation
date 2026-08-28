<!--
  The task-anchored view of a background GitHub run: while a PR opened for
  this task is being processed, the task's kanban card, its panel and the
  editor views show a compact live state that settles in place when the
  verdict lands. Rejections additionally take the viewport over
  (PendingVerdicts.svelte).
-->
<script lang="ts">
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  let {
    task,
    bar = false,
  }: {
    /** The task id whose run state renders, e.g. "T0002". */
    task: string;
    /** Render as a full-width strip (task panel) instead of a card badge. */
    bar?: boolean;
  } = $props();

  const entry = $derived(pendingVerdicts.forTask(task));
</script>

{#if entry}
  <div class="runstate {entry.state}" class:bar aria-live="polite">
    {#if entry.state === "opening"}
      <span class="spinner" aria-hidden="true"></span>
      <span>opening the PR…</span>
    {:else if entry.state === "processing"}
      <span class="spinner" aria-hidden="true"></span>
      <span
        >processing
        <a
          href={entry.prUrl}
          target="_blank"
          rel="noreferrer"
          onclick={(e) => e.stopPropagation()}>PR #{entry.prNumber}</a
        >…</span
      >
    {:else if entry.state === "accepted"}
      <span class="mark" aria-hidden="true">✓</span>
      <span>PR #{entry.prNumber} accepted</span>
    {:else if entry.state === "timeout"}
      <span class="mark" aria-hidden="true">…</span>
      <span
        ><a
          href={entry.prUrl}
          target="_blank"
          rel="noreferrer"
          onclick={(e) => e.stopPropagation()}>PR #{entry.prNumber}</a
        > is still being processed</span
      >
    {:else}
      <span class="mark" aria-hidden="true">✕</span>
      <span>{entry.prNumber ? `PR #${entry.prNumber} rejected` : "submission failed"}</span>
    {/if}
  </div>
{/if}

<style>
  .runstate {
    display: flex;
    align-items: center;
    margin-top: 6px;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-faint);
  }
  .runstate.bar {
    flex: none;
    margin-top: 0;
    padding: 6px 20px;
    font-size: 12px;
    border-bottom: 1px solid var(--line);
    background: var(--card);
  }
  .runstate a {
    color: var(--link);
  }
  .runstate.accepted {
    color: var(--ok);
  }
  .runstate.accepted.bar {
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }
  .runstate.timeout {
    color: var(--warn);
  }
  .runstate.timeout.bar {
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .runstate.rejected {
    color: var(--danger);
  }
  .runstate.rejected.bar {
    background: var(--danger-bg);
    border-color: var(--danger-line);
  }
  .mark {
    flex: none;
  }
  .spinner {
    flex: none;
    width: 12px;
    height: 12px;
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
</style>
