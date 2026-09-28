<!--
  The result banner of a page's last command: its error, or its message when
  it finished in the foreground, with the submission link and a Dismiss.
  A mei-friend hand-off also shows the link to open mei-friend by hand, for
  when the browser blocked the new tab.
-->
<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import type { CommandRunner } from "$lib/command-runner.svelte.ts";

  let {
    runner,
    bar = false,
    isPrivate = false,
  }: {
    runner: CommandRunner;
    /** A full-width strip flush against its container. */
    bar?: boolean;
    /** The campaign repo is private: the mei-friend link carries access. */
    isPrivate?: boolean;
  } = $props();
  const result = $derived(runner.result);

  const copy = (text: string) =>
    navigator.clipboard?.writeText(text).catch(() => {});
</script>

{#if result && (result.error || (result.ok && !result.background))}
  <div
    class="banner {result.error ? 'err' : result.warn ? 'warn' : 'ok'}"
    class:bar
  >
    <div class="banner-body">
      <span>
        {result.error ?? result.message}
        {#if result.prUrl}
          <a href={result.prUrl} target="_blank" rel="noreferrer"
            >View submission <Icon name="external" size={12} /></a
          >
        {/if}
      </span>
      {#if !result.error && result.meiFriendUrl}
        <div class="rawlink">
          <input
            readonly
            value={result.meiFriendUrl}
            onfocus={(e) => (e.target as HTMLInputElement).select()}
          />
          <button type="button" onclick={() => copy(result.meiFriendUrl!)}
            >Copy</button
          >
        </div>
        <span class="muted">
          <a href={result.meiFriendUrl}
            >Open in mei-friend <Icon name="external" size={12} /></a
          >
        </span>
        {#if isPrivate}
          <span class="muted">
            Opening mei-friend shares a short-lived, read-capable GitHub URL
            with that external service.
          </span>
        {/if}
      {/if}
    </div>
    <button type="button" class="dismiss" onclick={() => (runner.result = null)}
      >Dismiss</button
    >
  </div>
{/if}

<style>
  .muted {
    color: var(--ink-faint);
  }
  .rawlink {
    display: flex;
    gap: 0.4rem;
  }
  .rawlink input {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    font-family: ui-monospace, monospace;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
  }
  .rawlink button {
    font: inherit;
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--card);
    cursor: pointer;
  }
</style>
