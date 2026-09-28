<!--
  Background rejections. The quiet states of a background run (opening,
  processing, accepted, timeout) render task-anchored (TaskRunState.svelte);
  a REJECTION takes the viewport over with a modal card — the submitted work
  did not land, which must not be missable.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
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
      <div class="fail-mark" aria-hidden="true">
        <Icon name="close" size={22} />
      </div>
      <p class="overlay-title">
        {rejected.every((e) => e.runFailed)
          ? "Run failed"
          : rejected.some((e) => e.runFailed)
            ? "Failed"
            : "Rejected"}
      </p>
      {#each rejected as entry (entry.id)}
        <div class="failure">
          <p class="failure-label">{entry.label}</p>
          <p class="failure-message">
            {text(entry.message)}
            {#if entry.prNumber}
              <a href={entry.prUrl} target="_blank" rel="noreferrer"
                >submission #{entry.prNumber}</a
              >
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
