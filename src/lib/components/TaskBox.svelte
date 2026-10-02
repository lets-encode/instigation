<!--
  A task's box in the side panel (SidePanel.svelte) of the campaign page and
  the score view: one continuous card — piece-tinted header, status line with
  the measure/page score link, submission, validation record and the action
  footer. Commands run through callbacks the campaign page passes in.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import { findRow } from "$lib/campaign-tables.ts";
  import type { CommentRow, LockRow, StateRow } from "$lib/campaign-tables.ts";
  import type { FailComment, Result } from "$lib/commands.ts";
  import {
    handle,
    pageOfLocator,
    preTaskHref,
    claimLabel,
    workPlace,
  } from "$lib/campaign-graph.ts";
  import { pendingVerdicts } from "$lib/pending-verdicts.svelte.ts";
  import {
    buildRecord,
    cardPill,
    elapsed,
    initialOf,
  } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";
  import GiveBackButton from "./GiveBackButton.svelte";
  import TaskRunState from "./TaskRunState.svelte";
  import ValidationRecord from "./ValidationRecord.svelte";

  let {
    card,
    pieceName,
    zone,
    campaign,
    comments,
    locks,
    rows,
    logins,
    viewer,
    canPush,
    runner,
    editorError = null,
    onopenscore,
    onshowanchor,
    onclaim,
    oneditor,
    ongiveback,
    onvalidate,
    onresolve,
    onsendback,
  }: {
    card: BoardCard;
    /** The display name of the task's piece. */
    pieceName: string;
    /** The piece's colour slot, 1-based (--zone-N). */
    zone: number;
    campaign: string;
    comments: CommentRow[];
    locks: LockRow[];
    rows: StateRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    /** An error from the return from mei-friend; `label` names mei-friend
        when the text is its own message. */
    editorError?: { label: string; text: string } | null;
    /** Open the score at the task's pages. */
    onopenscore: () => void;
    /** Highlight a comment's measure range in the score. */
    onshowanchor: (c: CommentRow) => void;
    onclaim: (task_id: string, subtask_id: string) => Promise<unknown>;
    oneditor: (task_id: string) => Promise<void>;
    /** Give back the viewer's claim: the task's encoding ('' subtask) or a review slot. */
    ongiveback: (task_id: string, subtask_id: string) => Promise<unknown>;
    onvalidate: (
      task_id: string,
      subtask_id: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<Result | null>;
    onresolve: (comment_id: string) => Promise<unknown>;
    onsendback: (task_id: string) => Promise<unknown>;
  } = $props();

  // A submission on this task still being processed: every action in the
  // footer holds until it lands.
  const processing = $derived(pendingVerdicts.taskProcessing(card.task));
  const mineEncoding = $derived(
    viewer !== "" &&
      locks.some(
        (l) =>
          l.task_id === card.task &&
          l.subtask_id === "" &&
          l.kind === "encoding" &&
          l.user_id === viewer,
      ),
  );
  const record = $derived(buildRecord(card, comments, viewer, logins));
  /** The validation slot the viewer may claim right now, if any. */
  const claimableSub = $derived(
    record.find((r) => r.key === "open" && r.claimable)?.sub,
  );
  /** The review slot the viewer holds a lock on, if any. */
  const myReviewSub = $derived(record.find((r) => r.mine)?.sub);
  const myReview = $derived(myReviewSub !== undefined);
  const editorRoute = $derived(preTaskHref(campaign, card.locator, card.task));
  const editorName = $derived(workPlace(card.locator));

  // The submitted encoding behind the card, for the Submission section.
  const taskState = $derived(findRow(rows, card.task, ""));
  const encoderLogin = $derived(
    taskState?.encoder ? handle(logins, taskState.encoder) : "",
  );

  // The task's page, linking the status line to the score and prefilling a
  // fail's anchor.
  const taskPage = $derived(String(pageOfLocator(card.locator) ?? ""));
  const scoreLink = $derived(taskPage ? `p. ${taskPage}` : "score");
</script>

<div class="taskcard" style="--zone: var(--zone-{zone})">
  <div class="tsphead">
    <span class="dot"></span>
    <h3 class="tsptitle">{card.title}</h3>
    <span class="tspid">{card.task}</span>
  </div>
  <TaskRunState task={card.task} bar />
  {#if editorError}
    <div class="banner err bar">
      <span
        >{#if editorError.label}<b>{editorError.label}:</b
          >{" "}{/if}{editorError.text}</span
      >
    </div>
  {/if}
  <div class="statusrow">
    <span
      class="pill c-{card.column}"
      title={card.column === "blocked"
        ? `Waits for ${card.waitsFor}.`
        : card.column === "done"
          ? card.doneLine
          : undefined}>{cardPill(card, viewer)}</span
    >
    <span class="pieceline"
      >{pieceName} ·
      <button
        type="button"
        class="scorelink"
        onclick={onopenscore}
        title="Open the score at this task's pages">{scoreLink}</button
      ></span
    >
  </div>
  {#if encoderLogin}
    <div class="section">
      <span class="seclbl">Submission</span>
      <div class="subline">
        <span class="avatar">{initialOf(encoderLogin)}</span>
        <span class="subtext"
          >encoded by <b>{encoderLogin}</b>{taskState?.encoded_at
            ? elapsed(taskState.encoded_at) === "now"
              ? " · just now"
              : ` · ${elapsed(taskState.encoded_at)} ago`
            : ""}</span
        >
      </div>
    </div>
  {/if}
  {#if card.slots.length > 0}
    <div class="section">
      <ValidationRecord
        {card}
        {comments}
        {viewer}
        {logins}
        {canPush}
        {runner}
        variant="side"
        prefill={() => ({ page: taskPage, m1: "", m2: "" })}
        {onshowanchor}
        {onclaim}
        {onvalidate}
        {onresolve}
        {onsendback}
      />
    </div>
  {/if}
  <!-- The one action the viewer can take on this task in its current
           state; a task the viewer cannot work on gets no footer. -->
  {#if card.column === "ready"}
    <div class="tspfoot">
      {#if card.pre}
        <a
          class="btn btn-primary btn-pre"
          href={processing ? undefined : editorRoute}
          aria-disabled={processing}
          title={`Claims the task for you and opens the ${editorName}.`}
          >{claimLabel(card.locator)}</a
        >
      {:else}
        <button
          type="button"
          class="btn btn-primary"
          onclick={() => oneditor(card.task)}
          disabled={runner.busy || !auth.user || processing}
          title={auth.user
            ? "Claims the task for you, then opens the score in mei-friend."
            : "Log in to claim a task."}
          >{claimLabel(card.locator)} <Icon name="external" /></button
        >
      {/if}
    </div>
  {:else if card.column === "encoding"}
    {#if card.pre && card.worker?.mine}
      <div class="tspfoot">
        <a
          class="btn btn-primary"
          href={processing ? undefined : editorRoute}
          aria-disabled={processing}
          title={`Continue your work in the ${editorName}.`}
          >Continue in {editorName}</a
        >
        <GiveBackButton
          disabled={runner.busy || processing}
          ongiveback={() => ongiveback(card.task, "")}
        />
      </div>
    {:else if mineEncoding}
      <div class="tspfoot">
        <button
          type="button"
          class="btn btn-primary"
          onclick={() => oneditor(card.task)}
          disabled={runner.busy || processing}
          title="Opens the score in mei-friend. Completing the task there submits it for review."
          >Open in mei-friend <Icon name="external" /></button
        >
        <GiveBackButton
          disabled={runner.busy || processing}
          ongiveback={() => ongiveback(card.task, "")}
        />
      </div>
    {/if}
  {:else if card.column === "validation"}
    {#if claimableSub !== undefined}
      <div class="tspfoot">
        <button
          type="button"
          class="btn btn-primary btn-review"
          onclick={() => onclaim(card.task, claimableSub)}
          disabled={runner.busy || processing}
          title="Reserve this review slot.">Claim to review</button
        >
        {#if !card.pre}
          <a
            class="btn btn-soft"
            href={`/${campaign}/review/${card.task}`}
            title="Open the full-screen review view: score and facsimile side by side, with the verdict controls."
            >Open review view</a
          >
        {/if}
      </div>
    {:else if myReview}
      <div class="tspfoot">
        {#if card.pre}
          <a
            class="btn btn-primary"
            href={processing ? undefined : editorRoute}
            aria-disabled={processing}
            title={`Review the submitted work in the ${editorName}.`}
            >Open {editorName}</a
          >
        {:else}
          <a
            class="btn btn-primary"
            href={processing ? undefined : `/${campaign}/review/${card.task}`}
            aria-disabled={processing}
            title="Open the full-screen review view: score and facsimile side by side, with the verdict controls."
            >Open review view</a
          >
        {/if}
        <GiveBackButton
          disabled={runner.busy || processing}
          ongiveback={() => ongiveback(card.task, myReviewSub ?? "")}
        />
      </div>
    {/if}
  {/if}
</div>

<style>
  .taskcard {
    background: var(--card);
    border: 1px solid color-mix(in srgb, var(--zone) 45%, var(--line));
    border-radius: 12px;
    overflow-x: hidden;
    box-shadow: var(--shadow-sm);
  }
  .tsphead {
    display: flex;
    align-items: center;
    gap: 8px;
    background: color-mix(in srgb, var(--zone) 10%, var(--card));
    border-bottom: 1px solid color-mix(in srgb, var(--zone) 25%, var(--line));
    padding: 9px 12px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--zone);
    flex: none;
  }
  .tsptitle {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tspid {
    font:
      400 10px ui-monospace,
      Menlo,
      monospace;
    color: var(--ink-faint);
    flex: none;
  }
  .statusrow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 10px 12px;
  }
  .pieceline {
    font-size: 11.5px;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .scorelink {
    font: 600 11.5px var(--font);
    color: var(--info);
    background: none;
    border: 0;
    padding: 6px 0;
    margin: -6px 0;
    cursor: pointer;
  }
  .section {
    padding: 10px 12px;
    border-top: 1px solid var(--hairline, var(--line));
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .seclbl {
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ink-soft);
  }
  .subline {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .avatar {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent-btn);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .subtext {
    font-size: 11.5px;
    color: var(--ink-soft);
  }
  .subtext b {
    color: var(--ink);
  }
  .tspfoot {
    padding: 10px 12px;
    border-top: 1px solid var(--hairline, var(--line));
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  /* At the panel's narrowest a long label wraps rather than widening it. */
  .tspfoot .btn {
    flex: 1;
    white-space: normal;
  }

  /* ---------------------------------------------------------------- pills */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    font-size: 11px;
    line-height: 1;
    padding: 4px 10px;
    border-radius: 999px;
    white-space: nowrap;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
  }
  .pill.c-encoding {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .pill.c-validation {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .pill.c-done {
    background: var(--ok-bg);
    border-color: var(--ok-line);
    color: var(--ok);
  }
</style>
