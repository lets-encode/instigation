<!--
  The task panel's body: the task's status and controls (claim, open in the
  editor, copy raw link, submit), the validation record and the discussion
  thread — the only place a discussion thread renders. Commands run through
  callbacks the campaign page passes in; the shared CommandRunner carries the
  busy state and result. The score itself renders in the separate score panel
  (PreviewDock), which turns to a page when a comment is anchored here.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { LockRow, CommentRow } from "$lib/campaign-tables.ts";
  import type { FailComment } from "$lib/commands.ts";
  import { handle, statusPill } from "$lib/campaign-graph.ts";
  import {
    buildRecord,
    buildThreads,
    elapsed,
    initialOf,
    orphanedFails,
  } from "$lib/campaign-board.ts";
  import type { BoardCard } from "$lib/campaign-board.ts";

  let {
    card,
    campaign,
    comments,
    locks,
    logins,
    viewer,
    canPush,
    runner,
    resultBanner,
    slotDot,
    currentPage,
    onshowanchor,
    onclaim,
    oneditor,
    onsubmitencoding,
    onvalidate,
    oncomment,
    onresolve,
    onsendback,
    onrawlink,
  }: {
    card: BoardCard;
    campaign: string;
    comments: CommentRow[];
    locks: LockRow[];
    logins: Record<string, string>;
    viewer: string;
    canPush: boolean;
    runner: CommandRunner;
    resultBanner: Snippet;
    slotDot: Snippet<[string]>;
    /** The first page the preview shows right now, 0-based. */
    currentPage: () => number;
    /** Highlight a comment's measure range in the preview. */
    onshowanchor: (c: CommentRow) => void;
    onclaim: (task_id: string, subtask_id: string) => Promise<void>;
    oneditor: (task_id: string) => Promise<void>;
    onsubmitencoding: (task_id: string) => Promise<void>;
    onvalidate: (
      task_id: string,
      subtask_id: string,
      verdict: string,
      comment?: FailComment,
    ) => Promise<void>;
    oncomment: (kind: string, body: string, parent_id: string) => Promise<void>;
    onresolve: (comment_id: string) => Promise<void>;
    onsendback: (task_id: string) => Promise<void>;
    onrawlink: (task_id: string) => Promise<void>;
  } = $props();

  const record = $derived(buildRecord(card, comments, viewer, logins));
  const orphanFails = $derived(orphanedFails(card, comments));
  const threads = $derived(buildThreads(comments, card.task));
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
  // Opening the editor claims the task first when it is open to claim — the
  // button says so.
  const editorLabel = $derived(
    mineEncoding || card.column !== "ready"
      ? "Open editor ↗"
      : "Claim & open editor ↗",
  );

  // The inline form a fail verdict fills in (its mandatory comment).
  let failForm = $state<{
    sub: string;
    body: string;
    page: string;
    m1: string;
    m2: string;
  } | null>(null);
  // Composer state for the discussion thread.
  let composerText = $state("");
  let composerKind = $state<"question" | "addition">("question");
  let replyTo = $state<CommentRow | null>(null);

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

  async function postComment() {
    if (!composerText.trim()) return;
    const kind = replyTo ? "reply" : composerKind;
    const parent_id = replyTo?.comment_id ?? "";
    await oncomment(kind, composerText, parent_id);
    if (runner.result?.ok) {
      composerText = "";
      replyTo = null;
    }
  }

  const canResolve = (c: CommentRow) =>
    viewer !== "" && (canPush || c.author_id === viewer);

  const commentLogin = (c: CommentRow) => handle(logins, c.author_id);
</script>

<aside class="taskpanel" aria-label={`Task ${card.title}`}>
  {@render resultBanner()}
  <div class="thead">
    <div class="tline">
      <span class="pill s-{card.statusKey}">
        {card.statusKey === "validation_required"
          ? `validation · ${card.passes} of ${card.threshold} passes`
          : statusPill(card.statusKey, card.pre)}
      </span>
      {#if card.counts.fails > 0}
        <span class="chip chip-fail"
          >{card.counts.fails} fail{card.counts.fails === 1 ? "" : "s"}</span
        >
      {/if}
    </div>
    <div class="tacts">
      <button
        type="button"
        class="mbtn"
        onclick={() => onrawlink(card.task)}
        disabled={runner.busy}
        title="Copy a direct link to the score file to paste into mei-friend manually."
        >Copy raw link</button
      >
      {#if card.pre}
        <a
          class="mbtn blue"
          href={`/${campaign}/zones/${card.task}`}
          title="Open the measure zones on the facsimile."
          >Open zone editor</a
        >
      {:else}
        <button
          type="button"
          class="mbtn blue"
          onclick={() => oneditor(card.task)}
          disabled={runner.busy || !auth.user || card.column === "blocked"}
          title={editorLabel === "Open editor ↗"
            ? "Opens the score in mei-friend."
            : "Claims the task for you, then opens the score in mei-friend."}
          >{editorLabel}</button
        >
      {/if}
      {#if mineEncoding}
        <button
          type="button"
          class="mbtn primary"
          onclick={() => onsubmitencoding(card.task)}
          disabled={runner.busy}
          title="After committing your encoding in mei-friend, submit it for validation."
          >Submit for validation</button
        >
      {/if}
    </div>
  </div>
  <div class="rail-scroll">
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
                  disabled={runner.busy}
                  title={`Return the task to ${card.pre ? "measure correction" : "encoding"}: attribution and validations reset.`}
                  >{card.pre
                    ? "Send back to measure correction"
                    : "Send back for encoding"}</button
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
                disabled={runner.busy}
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
                disabled={runner.busy}
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
                      : {
                          sub: r.sub,
                          body: "",
                          page: String(currentPage() + 1),
                          m1: "",
                          m2: "",
                        })}
                disabled={runner.busy}
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
                  disabled={runner.busy || !failForm.body.trim()}
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
      <div class="rfoot">
        A fail always carries a comment — the validator cannot submit one
        without saying why.
      </div>
    </div>
    <div class="rsec discussion">
      <div class="rlabel">
        Discussion · {threads.reduce((n, t) => n + 1 + t.replies.length, 0)}
      </div>
      {#each threads as t (t.root.comment_id)}
        <div class="crow" class:resolved={t.root.resolved === "true"}>
          <div class="chead">
            <span class="avatar small">{initialOf(commentLogin(t.root))}</span>
            <span class="cwho">{commentLogin(t.root)}</span>
            {#if t.root.kind === "question"}
              <span class="chip chip-question">? question</span>
            {:else}
              <span class="chip chip-note">note</span>
            {/if}
            {#if t.root.resolved === "true"}
              <span class="muted small-note">resolved</span>
            {/if}
            <span class="cwhen">{elapsed(t.root.timestamp)}</span>
          </div>
          <div class="cbody">“{t.root.body}”</div>
          <div class="cacts">
            {#if auth.user}
              <button
                type="button"
                class="linkish"
                onclick={() => (replyTo = t.root)}>Reply</button
              >
            {/if}
            {#if t.root.resolved !== "true" && canResolve(t.root)}
              <button
                type="button"
                class="linkish"
                onclick={() => onresolve(t.root.comment_id)}
                disabled={runner.busy}>Resolve</button
              >
            {/if}
          </div>
          {#each t.replies as reply (reply.comment_id)}
            <div class="creply">
              <div class="chead">
                <span class="avatar small"
                  >{initialOf(commentLogin(reply))}</span
                >
                <span class="cwho">{commentLogin(reply)}</span>
                <span class="cwhen">{elapsed(reply.timestamp)}</span>
              </div>
              <div class="cbody">“{reply.body}”</div>
            </div>
          {/each}
        </div>
      {/each}
      {#if threads.length === 0}
        <div class="muted small-note cnone">No discussion yet.</div>
      {/if}
    </div>
  </div>
  {#if auth.user}
    <div class="composer">
      {#if replyTo}
        <div class="replying">
          Replying to <strong>{commentLogin(replyTo)}</strong>
          <button
            type="button"
            class="linkish"
            onclick={() => (replyTo = null)}>Cancel</button
          >
        </div>
      {:else}
        <div class="kindpick">
          <button
            type="button"
            class="tchip"
            class:on={composerKind === "question"}
            onclick={() => (composerKind = "question")}
            title="Ask the campaign a question">question</button
          >
          <button
            type="button"
            class="tchip"
            class:on={composerKind === "addition"}
            onclick={() => (composerKind = "addition")}
            title="Leave a note">note</button
          >
        </div>
      {/if}
      <div class="composer-row">
        <input
          bind:value={composerText}
          placeholder="Reply or leave a note…"
          onkeydown={(e) => {
            if (e.key === "Enter" && composerText.trim()) postComment();
          }}
        />
        <button
          type="button"
          class="sendbtn"
          onclick={postComment}
          disabled={runner.busy || !composerText.trim()}>Send</button
        >
      </div>
    </div>
  {/if}
</aside>

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
  .avatar.small {
    width: 22px;
    height: 22px;
    font-size: 11px;
  }
  .chip {
    font-size: 11px;
    font-weight: 700;
    border-radius: 999px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .chip-fail {
    color: var(--danger);
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
  }
  .chip-note {
    color: var(--warn);
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
  }
  .chip-question {
    color: var(--info);
    background: var(--info-bg);
    border: 1px solid var(--info-line);
  }

  /* --------------------------------------------------------------- layout */
  .taskpanel {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .taskpanel :global(.banner) {
    border-radius: 0;
  }
  .thead {
    flex: none;
    padding: 12px 20px;
    border-bottom: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .tline {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-width: 0;
  }
  .tacts {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .mbtn {
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 7px 15px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    text-decoration: none;
    flex: none;
  }
  .mbtn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .mbtn.blue {
    border-color: var(--info-line);
    color: var(--info);
  }
  .mbtn.primary {
    border: 0;
    background: var(--accent-btn);
    color: #fff;
  }
  .mbtn.primary:hover:not(:disabled) {
    background: var(--accent-btn-hover);
    color: #fff;
  }
  .mbtn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .rail-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 6px;
    display: flex;
    flex-direction: column;
    gap: 14px;
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
  .rfoot {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 8px;
    line-height: 1.5;
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

  /* ---------------------------------------------------------- discussion */
  .discussion {
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
  .crow {
    padding: 10px 0;
    border-bottom: 1px solid var(--hairline);
  }
  .crow.resolved {
    opacity: 0.55;
  }
  .chead {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .cwho {
    font-size: 12.5px;
    font-weight: 600;
  }
  .cwhen {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-left: auto;
  }
  .cbody {
    font-size: 12.5px;
    color: var(--ink-soft);
    margin-top: 6px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .cacts {
    display: flex;
    gap: 12px;
    margin-top: 6px;
  }
  .creply {
    padding: 10px 0 0 18px;
  }
  .cnone {
    padding: 8px 0;
  }
  .composer {
    flex: none;
    padding: 10px 20px 16px;
    border-top: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .replying {
    font-size: 11.5px;
    color: var(--ink-faint);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .kindpick {
    display: flex;
    gap: 6px;
  }
  .tchip {
    font-size: 11.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 4px 11px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink-soft);
    cursor: pointer;
    flex: none;
    white-space: nowrap;
  }
  .tchip.on {
    border-color: var(--info-line);
    background: var(--info-bg);
    color: var(--info);
  }
  .composer-row {
    display: flex;
    gap: 8px;
  }
  .composer-row input {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-family: inherit;
    padding: 8px 12px;
    border: 1px solid var(--line-input);
    border-radius: 8px;
    background: var(--card);
    color: var(--ink);
  }
  .sendbtn {
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    padding: 8px 16px;
    border-radius: 999px;
    border: 0;
    background: var(--accent-btn);
    color: #fff;
    cursor: pointer;
    flex: none;
  }
  .sendbtn:hover:not(:disabled) {
    background: var(--accent-btn-hover);
  }
  .sendbtn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* ---------------------------------------------------------------- pills */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 999px;
    white-space: nowrap;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    color: var(--ink-faint);
  }
  .pill.s-completed,
  .pill.s-pass {
    background: var(--ok-bg);
    border-color: var(--ok-line);
    color: var(--ok);
  }
  .pill.s-encoding_required,
  .pill.s-encoding,
  .pill.s-claimed {
    background: var(--info-bg);
    border-color: var(--info-line);
    color: var(--info);
  }
  .pill.s-validation_required,
  .pill.s-review {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    color: var(--warn);
  }
  .pill.s-fail {
    background: var(--danger-bg);
    border-color: var(--danger-line);
    color: var(--danger);
  }
</style>
