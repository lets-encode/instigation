<!--
  A pre-task editor's review sections below its toolbar: the fail comments,
  and for a submitted task its review — status, verdicts, the claim and
  pass/fail controls, the fail comment box and the send-back action.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { handle } from "$lib/campaign-graph.ts";
  import { elapsed } from "$lib/campaign-board.ts";
  import type { PreTaskSession } from "$lib/pre-task-session.svelte.ts";

  let {
    session,
    stage,
  }: {
    session: PreTaskSession;
    /** The work stage a send-back returns the task to. */
    stage: string;
  } = $props();
  const validation = $derived(session.validation);
</script>

{#if session.failComments.length > 0}
  <div class="tbsection">
    <span class="sb-label">Fail comments</span>
    {#each session.failComments as c (c.comment_id)}
      <div class="failnote" class:resolved={c.resolved === "true"}>
        <span class="failwho"
          >@{handle(session.logins, c.author_id)} · {elapsed(
            c.timestamp,
          )}{c.resolved === "true" ? " · resolved" : ""}</span
        >
        <div class="failtext">“{c.body}”</div>
      </div>
    {/each}
  </div>
{/if}

{#if validation && session.submitted}
  <div class="tbsection sb-validation">
    <span class="sb-label">Review</span>
    <span class="vstatus">
      {#if validation.status === "completed"}
        Review done
      {:else if session.verdictPending}
        Your verdict is being processed…
      {:else if validation.lockUser}
        {session.holdsValidation
          ? "You are reviewing"
          : `@${session.lockUserLogin} reviewing`}
      {:else if session.failedVerdicts.length > 0 && validation.openSlots === 0}
        Failed — send it back to redo the {stage}
      {:else if session.selfValidation}
        Your own submission
      {:else if session.alreadyValidated}
        You reviewed this — another volunteer is needed
      {:else}
        Awaiting review
      {/if}
    </span>
    {#each validation.verdicts as v, i (i)}
      <span class="vrow {v.verdict}"
        >{#if v.verdict === "pass"}<img
            class="hand-pass"
            src="/green-hand.svg"
            alt=""
          /> pass{:else}<Icon name="close" size={11} /> fail{/if} · @{handle(
          session.logins,
          v.user,
        )} · {elapsed(v.ts)}</span
      >
    {/each}
    {#if session.canClaimValidation}
      <div class="sb-row one">
        <button
          type="button"
          class="btn btn-review"
          onclick={() => session.claimValidation()}
          disabled={session.runner.busy}
          title="Reserve this review slot.">Claim to review</button
        >
      </div>
    {:else if session.holdsValidation && !session.verdictPending}
      <div class="sb-row two">
        <button
          type="button"
          class="btn btn-primary btn-finish"
          onclick={() => session.validate("pass")}
          disabled={session.runner.busy}
          title="Record a passing verdict.">Pass</button
        >
        <button
          type="button"
          class="btn btn-danger vfail"
          class:on={session.failOpen}
          onclick={() => (session.failOpen = !session.failOpen)}
          disabled={session.runner.busy}
          title="Record a failing verdict — a fail carries a comment saying why."
          >Fail</button
        >
      </div>
    {/if}
    {#if session.failOpen && session.holdsValidation}
      <input
        class="fail-note"
        bind:value={session.failText}
        placeholder="Why does this fail?"
        onkeydown={(e) => {
          if (e.key === "Enter" && session.failText.trim())
            session.validate("fail");
        }}
      />
      <div class="sb-row one">
        <button
          type="button"
          class="btn btn-danger"
          onclick={() => session.validate("fail")}
          disabled={session.runner.busy ||
            !session.failText.trim() ||
            session.verdictPending}
          title="Submit the failing verdict with this comment."
          >Submit fail</button
        >
      </div>
    {/if}
    {#if session.canSendBack}
      <button
        type="button"
        class="btn btn-danger sendbackbtn"
        onclick={() => session.sendBack()}
        disabled={session.runner.busy || session.sendBackPending}
        title="Return the task to {stage}: attribution and reviews reset."
        >Send back to {stage}</button
      >
    {/if}
  </div>
{/if}

<style>
  /* Always below the editor's toolbar section, so always ruled off from it. */
  .tbsection {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-top: 1px solid var(--line);
  }
  .sb-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  /* A control row filling the sidebar's width; .one/.two divide it into
     that many equal cells. */
  .sb-row {
    align-self: stretch;
    display: grid;
    grid-template-columns: repeat(var(--cells), 1fr);
    align-items: center;
    gap: 6px;
  }
  .sb-row.one {
    --cells: 1;
  }
  .sb-row.two {
    --cells: 2;
  }
  .failnote {
    align-self: stretch;
    border: 1px solid var(--danger-line);
    border-radius: 8px;
    background: var(--danger-wash);
    padding: 8px 10px;
  }
  .failnote.resolved {
    opacity: 0.55;
  }
  .failwho {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--danger);
  }
  .failtext {
    font-size: 12.5px;
    color: var(--ink);
    margin-top: 4px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .vstatus {
    font-size: 12.5px;
    color: var(--ink-soft);
  }
  /* The armed Fail button: still an outline, tinted while its comment box
     is open. */
  .vfail.on {
    background: var(--danger-bg);
  }
  .vrow {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  /* The green thumbs-up hand marks a passed verdict. */
  .hand-pass {
    height: 14px;
    flex: none;
  }
  .vrow.pass {
    color: var(--ok);
  }
  .vrow.fail {
    color: var(--danger);
  }
  .fail-note {
    font: inherit;
    font-size: 12.5px;
    width: 100%;
    box-sizing: border-box;
    padding: 5px 10px;
    border: 1px solid var(--danger-line);
    border-radius: 999px;
    background: var(--card);
    color: var(--ink);
  }
  .sendbackbtn {
    align-self: stretch;
  }
</style>
