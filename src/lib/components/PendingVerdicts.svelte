<!--
  Background rejections. The quiet states of a background run (opening,
  processing, accepted, timeout) render task-anchored (TaskRunState.svelte);
  a REJECTION takes the viewport over with a modal card — the submitted work
  did not land, which must not be missable.
-->
<script lang="ts">
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";

  // The verdict comments open with their own ✅/❌; the card carries a state
  // mark, so the duplicate symbol is dropped from the text.
  const text = (message: string) => message.replace(/^[✅❌]\s*/, "");

  const rejected = $derived(
    pendingVerdicts.entries.filter((e) => e.state === "rejected"),
  );
</script>

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
            {#if entry.prNumber}
              <a href={entry.prUrl} target="_blank" rel="noreferrer">PR #{entry.prNumber}</a>
            {/if}
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
