<!--
  The wizard's shared frame. Step rail on the left throughout; what fills the
  rest depends on whether the step has material. A step with material (pages,
  XML) gets the three-zone workbench: material pane in the centre, work card
  fixed on the right, so the primary action always sits bottom-right. A step
  without material gets its card centered in the freed area instead, with a
  "Step N of 6" kicker — the upload step widens that to a bare hero column for
  its dropzone.

  The rail is derived from the wizard store: completed steps show a one-line
  summary of what they collected and navigate back on click; upcoming steps are
  disabled.

  The footer is built here from the handlers a step passes, so the buttons are
  written once. A step whose controls do not fit that shape — the name step,
  whose Continue submits a form — passes its own `footer` snippet instead and
  styles the buttons with the shared .btn classes.
-->
<script module lang="ts">
  // The work card's width once dragged, module-level so the drag survives
  // moving between steps: each step mounts its own instance of this frame.
  // Until then the card takes its fluid default width.
  let workWidth = $state<number | null>(null);
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import { licenseById } from "$lib/licenses.ts";
  import { releaseClaim } from "$lib/campaign-resolve.ts";
  import { discardDraft } from "$lib/wizard-draft.ts";
  import {
    WIZARD_STEPS,
    draftStatus,
    resetWizard,
    stepIndex,
    wizard,
    type WizardStepId,
  } from "$lib/wizard.svelte.ts";

  let {
    step,
    heading,
    intro,
    children,
    material,
    status,
    onBack,
    onNext,
    nextLabel = "Continue →",
    nextDisabled = false,
    backDisabled = false,
    finish = false,
    footer,
  }: {
    step: WizardStepId;
    heading: string;
    /** Optional one-line explanation shown under the heading. */
    intro?: string;
    children: Snippet;
    /** The step's content for the material pane, filling it. */
    material?: Snippet;
    /** What the step is doing right now, shown under its rail entry. */
    status?: string;
    /** Omitted on the first step, which has nothing to go back to. */
    onBack?: () => void;
    onNext?: () => void;
    nextLabel?: string;
    nextDisabled?: boolean;
    backDisabled?: boolean;
    /** Styles the primary button green, for the step that completes the flow. */
    finish?: boolean;
    /** Controls the Back/Next pair cannot express, in place of it. */
    footer?: Snippet;
  } = $props();

  const current = $derived(stepIndex(step));

  // One-line summaries for the rail's completed steps, read from the store.
  const uploadSummary = $derived.by(() => {
    const parts: string[] = [];
    const pdfs = wizard.files.filter((f) => /\.pdf$/i.test(f.name)).length;
    const others = wizard.files.length - pdfs;
    if (pdfs) parts.push(`${pdfs} PDF${pdfs === 1 ? "" : "s"}`);
    if (others) parts.push(`${others} file${others === 1 ? "" : "s"}`);
    if (wizard.iiifManifestUrl.trim()) parts.push("IIIF manifest");
    if (wizard.candidates.length) parts.push(`${wizard.candidates.length} pages`);
    else if (!parts.length && wizard.encodings.length)
      parts.push(`${wizard.encodings.length} encoding${wizard.encodings.length === 1 ? "" : "s"}`);
    return parts.join(" · ") || "no material";
  });

  const sourceSummary = $derived.by(() => {
    const imprint = [wizard.source.publisher, wizard.source.date].filter(Boolean).join(", ");
    return [wizard.source.title, imprint].filter(Boolean).join(" · ");
  });

  const summaries = $derived<Record<WizardStepId, string>>({
    name: [wizard.handle, wizard.title].filter((s) => s.trim()).join(" · "),
    license: licenseById(wizard.license).name.split(" — ")[0],
    upload: uploadSummary,
    pages: wizard.images.length
      ? `${wizard.images.length} kept`
      : wizard.repo
        ? "no pages"
        : "",
    source: sourceSummary,
    pieces: "",
  });

  // "Draft saved · just now": a clock that only needs to be roughly right, so
  // it ticks well below the minute it reports in.
  let now = $state(Date.now());
  $effect(() => {
    if (draftStatus.savedAt === null) return;
    const clock = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(clock);
  });
  const savedAgo = $derived.by(() => {
    if (draftStatus.savedAt === null) return null;
    const minutes = Math.floor((now - draftStatus.savedAt) / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ago`;
  });

  // Dragging the divider left of the work card resizes it; the material pane
  // takes whatever is left. Sized in pixels so the choice survives a window
  // resize, and clamped so both panes stay usable.
  let resizing = false;
  function startResize(e: PointerEvent) {
    resizing = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onResize(e: PointerEvent) {
    if (!resizing) return;
    // The card is anchored to the right, so it grows as the pointer moves left.
    workWidth = Math.min(
      Math.max(window.innerWidth - e.clientX, 380),
      Math.min(860, window.innerWidth * 0.65),
    );
  }
  function endResize(e: PointerEvent) {
    resizing = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  // Discarding asks once before it lets go of everything collected.
  let confirmingDiscard = $state(false);
  function discardSetup() {
    const handle = wizard.handle.trim();
    const claim = wizard.claim;
    confirmingDiscard = false;
    if (handle) discardDraft(handle);
    resetWizard();
    // Give the name back so it is free again straight away. Best-effort: an
    // unreleased hold runs out on its own.
    if (claim) void releaseClaim(claim.name, claim.token);
  }
</script>

<div class="workbench">
  <nav class="rail" aria-label="Campaign setup steps">
    <div class="rail-kicker">Campaign setup</div>
    <div class="rail-name">
      {#if wizard.handle.trim()}
        {wizard.handle}
        {#if auth.user}
          <span class="rail-slug">· {auth.user.login}/{wizard.handle}</span>
        {/if}
      {:else}
        <span class="rail-unnamed">Unnamed campaign</span>
      {/if}
    </div>

    <ol class="steps">
      {#each WIZARD_STEPS as s, i (s.id)}
        {@const done = i < current}
        {@const active = i === current}
        <li>
          <button
            type="button"
            class="step"
            disabled={!done || backDisabled}
            onclick={() => (wizard.step = s.id)}
            aria-current={active ? "step" : undefined}
          >
            <span class="rail-chain">
              <span class="bubble" class:done class:active>
                {done ? "✓" : i + 1}
              </span>
              {#if i < WIZARD_STEPS.length - 1}
                <span class="connector"></span>
              {/if}
            </span>
            <span class="step-text">
              <span class="step-label" class:active class:upcoming={!done && !active}>
                {s.label}
              </span>
              {#if active && status}
                <span class="step-status">{status}</span>
              {:else if done && summaries[s.id]}
                <span class="step-summary">{summaries[s.id]}</span>
              {/if}
            </span>
          </button>
        </li>
      {/each}
    </ol>

    <div class="rail-foot">
      {#if savedAgo}
        <div class="saved"><span class="saved-dot"></span>Draft saved · {savedAgo}</div>
      {/if}
      {#if confirmingDiscard}
        <div class="discard-confirm">
          <span>Discard everything entered so far?</span>
          <span class="discard-row">
            <button type="button" class="discard danger" onclick={discardSetup}>
              Discard for good
            </button>
            <button type="button" class="discard" onclick={() => (confirmingDiscard = false)}>
              Keep it
            </button>
          </span>
        </div>
      {:else}
        <button type="button" class="discard" onclick={() => (confirmingDiscard = true)}>
          Discard this setup
        </button>
      {/if}
    </div>
  </nav>

  {#if material}
    <div class="material">
      {@render material()}
    </div>

    <div
      class="grip"
      role="separator"
      aria-label="Resize the work card"
      aria-orientation="vertical"
      onpointerdown={startResize}
      onpointermove={onResize}
      onpointerup={endResize}
      onpointercancel={endResize}
    ></div>

    <div
      class="work"
      style={workWidth === null ? undefined : `--work-width: ${workWidth}px`}
    >
      {@render workCard(false)}
    </div>
  {:else}
    <!-- No material: the card takes the stage alone, centered. The upload
         step's card is a step wider, to give the dropzone room. -->
    <div class="stage">
      {@render workCard(true)}
    </div>
  {/if}
</div>

{#snippet workCard(solo: boolean)}
  <section class="card" class:solo class:wide={solo && step === "upload"} aria-label={heading}>
    {#if solo}
      <div class="kicker">Step {current + 1} of {WIZARD_STEPS.length}</div>
    {/if}
    <h1>{heading}</h1>
    {#if intro}<p class="intro">{intro}</p>{/if}

    <div class="card-body">
      {@render children()}
    </div>

    <!-- Every step draws the frame, so the one place to report that this setup
         is no longer being kept for later — or why it opened where it did — is
         here. -->
    {#if draftStatus.resumeNotice}
      <p class="msg-warn" role="status">{draftStatus.resumeNotice}</p>
    {/if}
    {#if draftStatus.saveError}
      <p class="msg-warn" role="status">
        This setup can't be saved in your browser, so it won't be offered for
        continuing if you leave: {draftStatus.saveError}
      </p>
    {/if}

    <div class="footer">
      {#if footer}
        {@render footer()}
      {:else}
        {#if onBack}
          <button
            type="button"
            class="btn btn-secondary"
            onclick={onBack}
            disabled={backDisabled}
          >
            Back
          </button>
        {/if}
        {#if onNext}
          <button
            type="button"
            class="btn btn-primary"
            class:btn-finish={finish}
            onclick={onNext}
            disabled={nextDisabled}
          >
            {nextLabel}
          </button>
        {/if}
      {/if}
    </div>
  </section>
{/snippet}

<style>
  .workbench {
    flex: 1;
    min-height: 0;
    display: flex;
    background:
      radial-gradient(60% 90% at 15% 0%, rgba(109, 195, 255, 0.12), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, rgba(118, 222, 118, 0.12), transparent 60%),
      radial-gradient(50% 80% at 50% 100%, rgba(255, 167, 109, 0.1), transparent 60%),
      var(--bg-alt);
  }

  /* ---- Step rail -------------------------------------------------------- */
  .rail {
    flex: none;
    width: 248px;
    box-sizing: border-box;
    padding: 24px 20px 18px;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
  .rail-kicker {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-faint);
    margin-bottom: 4px;
  }
  .rail-name {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    margin: 2px 0 18px;
    overflow-wrap: anywhere;
  }
  .rail-slug {
    font: 400 12px ui-monospace, Menlo, monospace;
    color: var(--ink-faint);
  }
  .rail-unnamed {
    color: var(--ink-faint);
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .step {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    width: 100%;
    padding: 0;
    text-align: left;
    font: inherit;
    color: inherit;
    background: none;
    border: none;
    cursor: pointer;
  }
  .step:disabled {
    cursor: default;
  }
  .rail-chain {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: none;
  }
  .bubble {
    box-sizing: border-box;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12.5px;
    background: var(--card);
    border: 1px solid var(--line-strong);
    color: var(--ink-faint);
  }
  .bubble.done {
    font-size: 13px;
    background: var(--ok-bg);
    border-color: var(--ok-line);
    color: var(--ok);
  }
  .bubble.active {
    font-weight: 600;
    background: var(--accent-btn);
    border: none;
    color: #fff;
    box-shadow: 0 0 0 4px rgba(37, 99, 201, 0.15);
  }
  .connector {
    width: 1px;
    height: 18px;
    background: var(--line);
  }
  .step-text {
    display: block;
    padding-top: 3px;
    min-width: 0;
  }
  .step-label {
    display: block;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--ink-soft);
  }
  .step-label.active {
    font-weight: 700;
    color: var(--ink);
  }
  .step-label.upcoming {
    color: var(--ink-faint);
  }
  .step-summary,
  .step-status {
    display: block;
    font-size: 11.5px;
    color: var(--ink-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 170px;
  }
  .step-status {
    color: var(--accent);
    font-weight: 600;
  }
  .rail-foot {
    margin-top: auto;
    padding-top: 18px;
  }
  .saved {
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .saved-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
  }
  .discard {
    cursor: pointer;
    margin-top: 8px;
    align-self: flex-start;
    font: 12px var(--font);
    padding: 0;
    color: var(--ink-faint);
    background: none;
    border: none;
    text-decoration: underline;
  }
  .discard:hover {
    color: var(--danger);
  }
  .discard.danger {
    color: var(--danger);
  }
  .discard-confirm {
    margin-top: 8px;
    font-size: 12px;
    color: var(--ink-soft);
  }
  .discard-row {
    display: flex;
    gap: 12px;
  }

  /* ---- Material pane ----------------------------------------------------- */
  .material {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    margin: 24px 0 24px 12px;
  }

  /* ---- Work card ---------------------------------------------------------- */
  /* The divider between the material pane and the work card: a grab bar with a
     centred handle. */
  .grip {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    cursor: ew-resize;
    touch-action: none;
  }
  .grip::before {
    content: "";
    width: 3px;
    height: 2.5rem;
    border-radius: 999px;
    background: var(--line);
  }
  .grip:hover::before {
    background: var(--accent);
  }
  .work {
    flex: none;
    width: var(--work-width, clamp(472px, 30vw, 680px));
    box-sizing: border-box;
    padding: 24px 24px 24px 3px;
    display: flex;
  }
  .card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    padding: 26px 28px;
    box-sizing: border-box;
  }
  h1 {
    margin: 0;
    font-size: 21px;
    line-height: 1.25;
    font-weight: 600;
  }
  .intro {
    margin: 8px 0 0;
    font-size: 13.5px;
    color: var(--ink-soft);
  }

  /* ---- Centered stage (steps without material) --------------------------- */
  /* The area right of the rail; the card centres in it, sitting a little above
     the vertical middle. Auto margins on the card keep its top reachable when
     it is taller than the stage. */
  .stage {
    flex: 1;
    min-width: 0;
    display: flex;
    overflow: auto;
    box-sizing: border-box;
    padding: 24px 24px 60px;
  }
  .card.solo {
    flex: none;
    margin: auto;
    width: 680px;
    max-width: 100%;
    padding: 36px 42px;
  }
  /* The upload step's card, sized for the dropzone. */
  .card.wide {
    width: 920px;
  }
  .kicker {
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .card.solo h1 {
    margin-top: 8px;
    font-size: 26px;
    line-height: 1.2;
  }
  .card.solo .intro {
    margin-top: 9px;
    font-size: 14px;
  }
  /* A content-height card scrolls with the stage, not within itself. */
  .card.solo .card-body {
    flex: none;
    overflow: visible;
    margin: 0;
    padding: 0;
  }
  .card.solo .footer {
    margin-top: 26px;
    padding-top: 16px;
  }
  .card.solo .card-body :global(.input) {
    font-size: 15px;
    padding: 11px 14px;
  }
  /* The body takes what the heading and footer leave, and scrolls within it,
     so the step's primary action stays in view however much it has to show.
     The scrollbar gets a gutter of its own, out past the fields, so it never
     sits on top of them. */
  .card-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
    display: flex;
    flex-direction: column;
    margin: 0 -20px 0 -8px;
    padding: 0 12px 0 8px;
  }
  .footer {
    flex: none;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--line);
  }
  .msg-warn {
    flex: none;
  }

  /* Too narrow for three zones: they stack, the rail's chain running on as a
     column, and the page scrolls as one. */
  @media (max-width: 64rem) {
    .workbench {
      flex-direction: column;
      overflow: auto;
    }
    .rail {
      width: auto;
      overflow: visible;
    }
    .rail-foot {
      padding-top: 12px;
    }
    .material {
      margin: 0 16px;
      min-height: 320px;
    }
    .grip {
      display: none;
    }
    .work {
      width: auto;
      padding: 16px;
    }
    .card-body {
      overflow: visible;
    }
    .stage {
      overflow: visible;
      padding: 16px;
    }
    .card.solo {
      padding: 24px 20px;
    }
  }
</style>
