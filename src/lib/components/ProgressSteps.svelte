<!--
  The steps of a running action, each with the seconds it took, and once the
  action has stopped, the total underneath. The open step counts up while it
  runs; finished steps keep the time they took, and the step an action stopped
  in is marked. A step the log marks as untimed shows no seconds, but still
  counts towards the total.
-->
<script lang="ts">
  import type { ProgressLog, ProgressStep } from "$lib/progress-log.svelte.ts";

  let { log }: { log: ProgressLog } = $props();

  // Only the open step's time grows, so the clock runs while one is open.
  let now = $state(performance.now());
  $effect(() => {
    if (!log.running) return;
    const clock = setInterval(() => (now = performance.now()), 100);
    return () => clearInterval(clock);
  });

  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  // The shared clock ticks every 100ms, so a just-opened step can read a
  // `now` older than its own start; clamp so it never shows negative.
  const stepMs = (step: ProgressStep) =>
    step.tookMs ?? Math.max(0, (step.endedAt ?? now) - step.startedAt);
  const took = (step: ProgressStep) => seconds(stepMs(step));
  // The step times added up — for a step that reported its own duration,
  // that duration rather than how long it was open.
  const total = $derived(log.steps.reduce((sum, step) => sum + stepMs(step), 0));
</script>

{#if log.steps.length}
  <div class="log" role="status" aria-live="polite" aria-label="Progress">
    <ol>
      {#each log.steps as step, i (i)}
        <li class:failed={step.failed} class:running={step.endedAt === undefined}>
          <span class="mark" aria-hidden="true">
            {#if step.failed}
              ×
            {:else if step.endedAt === undefined}
              <span class="spinner"></span>
            {:else}
              ✓
            {/if}
          </span>
          <span class="what">
            {step.label}{#if step.detail}<span class="detail">{step.detail}</span>{/if}
          </span>
          <span class="time">{step.timed ? took(step) : ""}</span>
        </li>
      {/each}
    </ol>
    <!-- While a step is open the total only repeats that step's clock, so it is
         reported once the action has stopped. -->
    {#if !log.running}
      <p class="total">
        <span>Total</span>
        <span class="time">{seconds(total)}</span>
      </p>
    {/if}
  </div>
{/if}

<style>
  .log {
    margin-top: 14px;
    /* An item of a flex column that scrolls can be shrunk to nothing, which
       would leave the lines cut off. It keeps the height they need, and the
       content above it gives way instead. */
    flex: none;
    /* A long run scrolls rather than growing without bound, so it cannot push
       what sits below it out of view. */
    max-height: 45vh;
    overflow: auto;
    padding: 10px 12px;
    font-size: 12px;
    color: var(--ink-soft);
    background: var(--bg-alt);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li,
  .total {
    display: grid;
    grid-template-columns: 1rem 1fr auto;
    gap: 0.5rem;
    margin: 0;
    padding: 0.15rem 0;
  }
  .mark {
    text-align: center;
    color: var(--ok);
  }
  li.running .mark {
    color: var(--ink-faint);
  }
  /* The open step's marker: a small spinning ring. */
  .spinner {
    display: inline-block;
    box-sizing: border-box;
    width: 11px;
    height: 11px;
    border: 2px solid var(--line-strong);
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
      animation: none;
    }
  }
  li.failed {
    color: var(--danger);
  }
  li.failed .mark {
    color: var(--danger);
  }
  /* The separator is styled rather than written into the text, so the space
     around it survives the template's whitespace handling. */
  .detail::before {
    content: " — ";
  }
  .detail {
    color: var(--ink-faint);
  }
  .time {
    font-variant-numeric: tabular-nums;
    color: var(--ink-faint);
  }
  .total {
    grid-template-columns: 1fr auto;
    margin-top: 0.3rem;
    padding-top: 0.4rem;
    font-weight: 600;
    color: var(--ink);
    border-top: 1px solid var(--line);
  }
</style>
