<!--
  A task's validation record: one row per validation slot (claim, pass/fail
  controls on the viewer's own slot, the fail form), the fail comments with
  their anchors, and the send-back action. Commands run through callbacks the
  host passes in; the host decides where the record renders (the task panel's
  rail or the review view's rail).
-->
<script lang="ts">
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import type { FailComment } from "$lib/commands.ts";
  import { handle, sendBackTarget } from "$lib/campaign-graph.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import { buildRecord, elapsed, orphanedFails } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";

  let {
    card,
    comments,
    viewer,
    logins,
    canPush,
    runner,
    prefill,
    onshowanchor,
    onclaim,
    onvalidate,
    onresolve,
    onsendback,
  }: {
    card: BoardCard;
    comments: CommentRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    /** The anchor a fresh fail form opens with (page and measure range). */
    prefill: () => { page: string; m1: string; m2: string };
    /** Highlight a comment's measure range in the preview. */
    onshowanchor: (c: CommentRow) => void;
    onclaim: (task_id: string, subtask_id: string) => Promise<void>;
    onvalidate: (
      task_id: string,
      subtask_id: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<void>;
    onresolve: (comment_id: string) => Promise<void>;
    onsendback: (task_id: string) => Promise<void>;
  } = $props();

  const record = $derived(buildRecord(card, comments, viewer, logins));
  // A verdict already submitted for a subtask and still being processed: its
  // controls hold until it lands — a repeat would only be rejected.
  const verdictPending = (sub: string) =>
    pendingVerdicts.isProcessing(`validate:${card.task}/${sub}`);
  const sendBackPending = $derived(
    pendingVerdicts.isProcessing(`sendback:${card.task}`),
  );
  const orphanFails = $derived(orphanedFails(card, comments));

  // The inline form a fail verdict fills in (its mandatory comment).
  let failForm = $state<{
    sub: string;
    body: string;
    page: string;
    m1: string;
    m2: string;
  } | null>(null);

  const anchorLabel = (c: CommentRow): string => {
    const parts: string[] = [];
    if (c.page) parts.push(`p. ${c.page}`);
    if (c.measure_start)
      parts.push(
        c.measure_end && c.measure_end !== c.measure_start
          ? `m. ${c.measure_start}–${c.measure_end}`
          : `m. ${c.measure_start}`,
      );
    return parts.join(" · ");
  };
  const hasAnchor = (c: CommentRow): boolean =>
    c.measure_start !== "" || c.page !== "";

  async function submitFail() {
    if (!failForm || !failForm.body.trim()) return;
    const form = failForm;
    await onvalidate(card.task, form.sub, "fail", {
      body: form.body,
      page: form.page.trim(),
      measure_start: form.m1.trim(),
      measure_end: form.m2.trim(),
    });
    if (runner.result?.ok) failForm = null;
  }

  const canResolve = (c: CommentRow) =>
    viewer !== "" && (canPush || c.author_id === viewer);

  const commentLogin = (c: CommentRow) => handle(logins, c.author_id);
</script>

{#snippet slotDot(key: string)}
  <span class="dot {key}" aria-label={key} title={key}></span>
{/snippet}

<div class="rsec">
  <div class="rlabel">Validation record</div>
  {#each record as r (r.sub + "/" + r.slot)}
    {#if r.key === "fail"}
      <div class="failbox">
        <div class="failhead">
          {@render slotDot("fail")}
          <span class="failtitle">Slot {r.slot + 1} · fail</span>
          <span class="rwho">{r.login} · {r.elapsed}</span>
        </div>
        {#if r.comment}
          <div class="failbody">“{r.comment.body}”</div>
          {#if hasAnchor(r.comment)}
            <div class="failchips">
              <button
                type="button"
                class="chip chip-question anchorchip"
                onclick={() => onshowanchor(r.comment!)}
                title="Highlight this measure range in the preview"
                >{anchorLabel(r.comment)} — show in the preview</button
              >
            </div>
          {/if}
        {:else}
          <div class="failbody muted">
            No comment was recorded with this fail.
          </div>
        {/if}
        <div class="failacts">
          {#if r.comment && r.comment.resolved !== "true" && canResolve(r.comment)}
            <button
              type="button"
              class="linkish"
              onclick={() => onresolve(r.comment!.comment_id)}
              disabled={runner.busy}
              title="Mark this fail's comment as handled — it leaves the attention counts."
              >Resolve</button
            >
          {:else if r.comment?.resolved === "true"}
            <span class="muted small-note">resolved</span>
          {/if}
          <span class="mspacer"></span>
          {#if viewer !== "" && (canPush || r.userId === viewer)}
            <button
              type="button"
              class="dangerbtn"
              onclick={() => onsendback(card.task)}
              disabled={runner.busy || sendBackPending}
              title={`Return the task to ${sendBackTarget(card.locator)}: attribution and validations reset.`}
              >{`Send back ${card.pre ? "to" : "for"} ${sendBackTarget(card.locator)}`}</button
            >
          {/if}
        </div>
      </div>
    {:else}
      <div class="rrow">
        {@render slotDot(r.key)}
        <span class="rslot"
          >Slot {r.slot + 1} · {r.key === "review"
            ? "in review"
            : r.key}</span
        >
        {#if r.login}
          <span class="rwho">{r.login} · {r.elapsed}</span>
        {/if}
        <span class="mspacer"></span>
        {#if r.key === "pass"}
          <span class="muted small-note">no remarks</span>
        {:else if r.key === "open" && r.claimable}
          <button
            type="button"
            class="claimbtn"
            onclick={() => onclaim(card.task, r.sub)}
            disabled={runner.busy || verdictPending(r.sub)}
            title="Reserve this validation slot for review."
            >Claim to review</button
          >
        {:else if r.key === "open"}
          <span class="muted small-note">{r.note}</span>
        {:else if r.mine}
          <button
            type="button"
            class="passbtn"
            onclick={() => onvalidate(card.task, r.sub, "pass")}
            disabled={runner.busy || verdictPending(r.sub)}
            title="Record a passing verdict.">Pass</button
          >
          <button
            type="button"
            class="failbtn"
            class:on={failForm?.sub === r.sub}
            onclick={() =>
              (failForm =
                failForm?.sub === r.sub
                  ? null
                  : { sub: r.sub, body: "", ...prefill() })}
            disabled={runner.busy || verdictPending(r.sub)}
            title="Record a failing verdict — a fail carries a comment saying why."
            >Fail</button
          >
        {/if}
      </div>
      {#if failForm && failForm.sub === r.sub && r.mine}
        <div class="failform">
          <textarea
            rows="3"
            bind:value={failForm.body}
            placeholder="Why does this fail? (required)"
          ></textarea>
          <div class="failform-anchor">
            <label
              >p. <input size="3" bind:value={failForm.page} /></label
            >
            <label
              >m. <input
                size="4"
                bind:value={failForm.m1}
                placeholder="from"
              /></label
            >
            <label
              >– <input
                size="4"
                bind:value={failForm.m2}
                placeholder="to"
              /></label
            >
            <span class="mspacer"></span>
            <button
              type="button"
              class="dangerbtn"
              onclick={submitFail}
              disabled={runner.busy ||
                !failForm.body.trim() ||
                verdictPending(failForm.sub)}
              >Submit fail</button
            >
          </div>
        </div>
      {/if}
    {/if}
  {/each}
  {#each orphanFails as c (c.comment_id)}
    <div class="failbox">
      <div class="failhead">
        {@render slotDot("fail")}
        <span
          class="failtitle"
          title="This fail was recorded before the task was sent back."
          >Fail · before send-back</span
        >
        <span class="rwho">{commentLogin(c)} · {elapsed(c.timestamp)}</span>
      </div>
      <div class="failbody">“{c.body}”</div>
      {#if hasAnchor(c)}
        <div class="failchips">
          <button
            type="button"
            class="chip chip-question anchorchip"
            onclick={() => onshowanchor(c)}
            title="Highlight this place in the preview"
            >{anchorLabel(c)} — show in the preview</button
          >
        </div>
      {/if}
      {#if canResolve(c)}
        <div class="failacts">
          <button
            type="button"
            class="linkish"
            onclick={() => onresolve(c.comment_id)}
            disabled={runner.busy}
            title="Mark this fail's comment as handled — it leaves the attention counts."
            >Resolve</button
          >
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .muted {
    color: var(--ink-faint);
  }
  .linkish {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    cursor: pointer;
  }
  .linkish:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .mspacer {
    flex: 1;
  }
  .chip {
    font-size: 11px;
    font-weight: 700;
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .chip-question {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--card);
    border: 1px solid var(--line-input);
    flex: none;
    display: inline-block;
  }
  .dot.pass {
    background: var(--green);
    border-color: var(--ok);
  }
  :global([data-theme="dark"]) .dot.pass {
    background: var(--ok);
    border-color: var(--ok-line);
  }
  .dot.fail {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
  }
  .dot.review {
    background: var(--info-bg);
    border-color: var(--info);
  }
  .rlabel {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    padding-bottom: 4px;
  }
  .rrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .rslot {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
  }
  .rwho {
    font-size: 12px;
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .small-note {
    font-size: 11.5px;
    white-space: nowrap;
  }
  .claimbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--info-line);
    background: var(--card);
    color: var(--info);
    cursor: pointer;
    flex: none;
  }
  .claimbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .passbtn,
  .failbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--ok-line);
    background: var(--card);
    color: var(--ok);
    cursor: pointer;
    flex: none;
  }
  .failbtn {
    border-color: var(--danger-line);
    color: var(--danger);
  }
  .failbtn.on {
    background: var(--danger-solid);
    border-color: var(--danger-solid);
    color: #fff;
  }
  .passbtn:disabled,
  .failbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .failbox {
    margin: 10px 0;
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    background: var(--danger-wash);
    padding: 12px 14px;
  }
  .failhead {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .failtitle {
    font-size: 12.5px;
    font-weight: 700;
    color: var(--danger);
  }
  .failbody {
    font-size: 12.5px;
    color: var(--ink);
    margin-top: 8px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .failchips {
    display: flex;
    gap: 6px;
    margin-top: 9px;
    flex-wrap: wrap;
  }
  .anchorchip {
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .failacts {
    display: flex;
    gap: 12px;
    margin-top: 10px;
    align-items: center;
  }
  .dangerbtn {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 5px 12px;
    border-radius: 999px;
    border: 0;
    background: var(--danger-solid);
    color: #fff;
    cursor: pointer;
    flex: none;
  }
  .dangerbtn:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .failform {
    border: 1px solid var(--danger-line);
    border-radius: 10px;
    padding: 10px 12px;
    margin: 8px 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--danger-wash);
  }
  .failform textarea {
    font: inherit;
    font-size: 12.5px;
    padding: 7px 10px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
    resize: vertical;
  }
  .failform-anchor {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--ink-soft);
    flex-wrap: wrap;
  }
  .failform-anchor input {
    font: inherit;
    font-size: 11.5px;
    padding: 3px 6px;
    border: 1px solid var(--line-input);
    border-radius: 6px;
    background: var(--card);
    color: var(--ink);
    width: 3.2em;
  }
</style>
