<!--
  The discussion composer: a question or note on the task, or a reply to the
  bound comment (set by TaskDiscussion's Reply buttons). Renders nothing for
  a logged-out viewer.
-->
<script lang="ts">
  import { auth } from "$lib/auth.svelte.ts";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";
  import type { CommentRow } from "$lib/campaign-tables.ts";
  import { handle } from "$lib/campaign-graph.ts";

  let {
    logins,
    runner,
    replyTo = $bindable(),
    oncomment,
  }: {
    logins: Record<string, string>;
    runner: CommandRunner;
    /** The comment a reply is being written to, shared with the thread list. */
    replyTo: CommentRow | null;
    oncomment: (kind: string, body: string, parent_id: string) => Promise<void>;
  } = $props();

  let composerText = $state("");
  let composerKind = $state<"question" | "addition">("question");

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

  const commentLogin = (c: CommentRow) => handle(logins, c.author_id);
</script>

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

<style>
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
</style>
