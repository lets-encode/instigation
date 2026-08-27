<!--
  A modal card over the whole viewport, shown while an action that runs on
  the forge is in flight: a spinner plus the action's timed step log, so what
  is happening (and how long each stage takes) is visible while it runs. Once
  the action has finished the card stays up, with the step times and their
  total readable, until its Continue button is pressed. An action that ended
  in an error shows that error on the card itself, in place of the finished
  title. The palette is fixed rather than themed, matching the console
  surfaces it covers.
-->
<script lang="ts">
  import ProgressSteps from "./ProgressSteps.svelte";
  import type { ProgressLog } from "$lib/progress-log.svelte.ts";

  let {
    log,
    finished = false,
    error,
    onContinue,
  }: {
    log: ProgressLog;
    finished?: boolean;
    /** The finished action's error, when it ended in one. */
    error?: string;
    onContinue?: () => void;
  } = $props();
</script>

<div class="overlay" role={finished && error ? "alert" : "status"} aria-live="polite">
  <div class="overlay-card">
    {#if finished && error}
      <div class="fail-mark" aria-hidden="true">✕</div>
      <p class="overlay-title failed">Failed</p>
      <p class="overlay-error">{error}</p>
    {:else if finished}
      <p class="overlay-title">Finished</p>
    {:else}
      <div class="spinner" aria-hidden="true"></div>
      <p class="overlay-title">Working…</p>
      <p class="overlay-sub">
        The campaign automation runs on GitHub — this can take a few seconds.
      </p>
    {/if}
    <ProgressSteps {log} />
    {#if finished}
      <button type="button" class="btn btn-lg btn-primary" onclick={onContinue}>
        Continue
      </button>
    {/if}
  </div>
</div>

<style>
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
  /* The step log fills the card's width and keeps its list left-aligned. */
  .overlay-card > :global(.log) {
    align-self: stretch;
    margin-top: 0;
    text-align: left;
  }
  .spinner {
    width: 34px;
    height: 34px;
    border: 3px solid var(--line);
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
  .overlay-title {
    margin: 0;
    font-weight: 600;
    font-size: 14px;
  }
  .overlay-title.failed {
    color: var(--danger);
  }
  /* Sits where the spinner was: a ring of the same size around a cross. */
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
  .overlay-error {
    margin: 0;
    color: var(--danger);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .overlay-sub {
    margin: 0;
    color: var(--ink-faint);
    font-size: 0.85rem;
  }
</style>
