<!--
  The wizard's shared frame: a centred card with a step header, the step's own
  content, and a footer row for its Back/Next controls. Every wizard screen uses
  it so they read as one flow.

  The footer is built here from the handlers a step passes, so the buttons are
  written once. A step whose controls do not fit that shape — the name step,
  whose Continue submits a form — passes its own `footer` snippet instead and
  styles the buttons with the shared .btn classes.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    WIZARD_STEPS,
    draftStatus,
    stepIndex,
    type WizardStepId,
  } from "$lib/wizard.svelte.ts";

  let {
    step,
    heading,
    intro,
    children,
    fill = false,
    onBack,
    onNext,
    nextLabel = "Continue",
    nextDisabled = false,
    backDisabled = false,
    footer,
  }: {
    step: WizardStepId;
    heading: string;
    /** Optional one-line explanation shown under the heading. */
    intro?: string;
    children: Snippet;
    /**
     * For a step whose content is images: the card takes the width and the height
     * of the surface it is on, and its content scrolls inside it, so the footer's
     * controls stay in view however much the step has to show.
     */
    fill?: boolean;
    /** Omitted on the first step, which has nothing to go back to. */
    onBack?: () => void;
    onNext?: () => void;
    nextLabel?: string;
    nextDisabled?: boolean;
    backDisabled?: boolean;
    /** Controls the Back/Next pair cannot express, in place of it. */
    footer?: Snippet;
  } = $props();

  const current = $derived(stepIndex(step));
</script>

<div class="card" class:fill>
  <ol class="steps">
    {#each WIZARD_STEPS as s, i (s.id)}
      <li
        class:done={i < current}
        class:current={i === current}
        aria-current={i === current ? "step" : undefined}
      >
        <span class="dot">{i + 1}</span>
        <span class="label">{s.label}</span>
      </li>
    {/each}
  </ol>

  <h1>{heading}</h1>
  {#if intro}<p class="intro">{intro}</p>{/if}

  <div class="content">
    {@render children()}
  </div>

  <!-- Every step draws the frame, so the one place to report that this setup is
       no longer being kept for later — or why it opened where it did — is here. -->
  {#if draftStatus.resumeNotice}
    <p class="msg-warn" role="status">{draftStatus.resumeNotice}</p>
  {/if}
  {#if draftStatus.saveError}
    <p class="msg-warn" role="status">
      This setup can't be saved in your browser, so it won't be offered for
      continuing if you leave: {draftStatus.saveError}
    </p>
  {/if}

  {#if footer}
    <div class="footer">
      {@render footer()}
    </div>
  {:else if onBack || onNext}
    <div class="footer">
      {#if onBack}
        <button type="button" class="btn btn-secondary" onclick={onBack} disabled={backDisabled}>
          Back
        </button>
      {/if}
      {#if onNext}
        <button type="button" class="btn btn-primary" onclick={onNext} disabled={nextDisabled}>
          {nextLabel}
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .card {
    max-width: 760px;
    margin: 1.5rem auto;
    padding: 1.75rem 2rem;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
  }
  .card.fill {
    max-width: 1600px;
    /* Held to the surface's height, minus the card's own margins, so the footer
       sits at the bottom of the window rather than below it. */
    box-sizing: border-box;
    max-height: calc(100% - 3rem);
    display: flex;
    flex-direction: column;
  }
  /* The content is the part that gives way: it takes what the heading, the
     footer and anything the step reports leave, and scrolls within it. */
  .card.fill .content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .steps {
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
    list-style: none;
    margin: 0 0 1.25rem;
    padding: 0;
    font-size: 0.85rem;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--ink-faint);
  }
  .dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
  }
  .steps li.current {
    color: var(--ink);
    font-weight: 600;
  }
  .steps li.current .dot {
    border-color: var(--accent);
    color: var(--accent);
  }
  .steps li.done {
    color: var(--ink-soft);
  }
  .steps li.done .dot {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--card);
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
  }
  .intro {
    margin: 0.5rem 0 0;
    color: var(--ink-soft);
  }
  .content {
    margin-top: 1.25rem;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid var(--line);
  }
</style>
