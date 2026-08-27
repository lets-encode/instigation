<!--
  Background verdicts. Processing, accepted and timed-out entries are quiet
  cards in the corner; a REJECTION takes the viewport over with a modal card —
  the submitted work did not land, which must not be missable.
-->
<script lang="ts">
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  // The verdict comments open with their own ✅/❌; the cards carry a state
  // mark, so the duplicate symbol is dropped from the text.
  const text = (message: string) => message.replace(/^[✅❌]\s*/, "");

  const corner = $derived(
    pendingVerdicts.entries.filter((e) => e.state !== "rejected"),
  );
  const rejected = $derived(
    pendingVerdicts.entries.filter((e) => e.state === "rejected"),
  );
</script>

{#if corner.length}
  <div class="stack" aria-live="polite">
    {#each corner as entry (entry.id)}
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
          <span class="mark warn-mark" aria-hidden="true">…</span>
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

{#if rejected.length}
  <div class="overlay" role="alert">
    <div class="overlay-card">
      <div class="fail-mark" aria-hidden="true">✕</div>
      <p class="overlay-title">Rejected</p>
      {#each rejected as entry (entry.id)}
        <div class="failure">
          <p class="failure-label">{entry.label}</p>
          <p class="failure-message">
            {text(entry.message)}
            <a href={entry.prUrl} target="_blank" rel="noreferrer">PR #{entry.prNumber}</a>
          </p>
        </div>
      {/each}
      <button
        type="button"
        class="btn btn-lg btn-primary"
        onclick={() => rejected.forEach((e) => pendingVerdicts.dismiss(e.id))}
      >
        Continue
      </button>
    </div>
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
    font-weight: 600;
  }
  .ok-mark {
    color: var(--ok);
  }
  .warn-mark {
    color: var(--warn);
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

  /* The rejection modal mirrors the busy overlay's failed state. */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
    backdrop-filter: blur(2px);
  }
  .overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: min(30rem, 92vw);
    padding: 26px 34px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 12px 44px var(--shade);
    text-align: center;
  }
  .fail-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 3px solid var(--danger);
    border-radius: 50%;
    color: var(--danger);
    font-weight: 600;
  }
  .overlay-title {
    margin: 0;
    color: var(--danger);
    font-weight: 600;
    font-size: 14px;
  }
  .failure {
    align-self: stretch;
    padding: 10px 12px;
    background: var(--danger-wash);
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    text-align: left;
  }
  .failure-label {
    margin: 0 0 2px;
    font-weight: 600;
    font-size: 0.85rem;
  }
  .failure-message {
    margin: 0;
    color: var(--danger);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
</style>
