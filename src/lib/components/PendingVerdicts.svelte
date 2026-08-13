<!--
  Corner stack of background verdicts: one card per PR the campaign automation
  is still processing (or has just settled). Processing and accepted cards are
  transient; a rejection or timeout stays until dismissed.
-->
<script lang="ts">
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  // The verdict comments open with their own ✅/❌; the card already carries a
  // state mark, so the duplicate symbol is dropped from the text.
  const text = (message: string) => message.replace(/^[✅❌]\s*/, "");
</script>

{#if pendingVerdicts.entries.length}
  <div class="stack" aria-live="polite">
    {#each pendingVerdicts.entries as entry (entry.id)}
      <div class="card {entry.state}">
        {#if entry.state === "processing"}
          <span class="spinner" aria-hidden="true"></span>
          <span class="text">
            {entry.label} — processing
            <a href={entry.prUrl} target="_blank" rel="noreferrer">PR #{entry.prNumber}</a>…
          </span>
        {:else if entry.state === "accepted"}
          <span class="mark ok-mark" aria-hidden="true">✓</span>
          <span class="text">{text(entry.message)}</span>
        {:else}
          <span class="mark bad-mark" aria-hidden="true">✕</span>
          <span class="text">
            {text(entry.message)}
            <a href={entry.prUrl} target="_blank" rel="noreferrer">PR #{entry.prNumber}</a>
          </span>
          <button
            type="button"
            class="close"
            aria-label="Dismiss"
            onclick={() => pendingVerdicts.dismiss(entry.id)}>×</button
          >
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .stack {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: min(26rem, 92vw);
  }
  .card {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: var(--shadow);
    font-size: 0.85rem;
  }
  .card.accepted {
    background: var(--ok-bg);
    border-color: var(--ok-line);
  }
  .card.rejected {
    background: var(--danger-wash);
    border-color: var(--danger-line);
  }
  .card.timeout {
    background: var(--warn-bg);
    border-color: var(--warn-line);
  }
  .text {
    overflow-wrap: anywhere;
  }
  .spinner {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 2px;
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
  .mark {
    flex: none;
    font-weight: 700;
  }
  .ok-mark {
    color: var(--ok);
  }
  .bad-mark {
    color: var(--danger);
  }
  .close {
    flex: none;
    margin-left: auto;
    padding: 0 4px;
    background: none;
    border: none;
    color: var(--ink-faint);
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
  }
</style>
