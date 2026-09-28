<!--
  "Give back" for a claim the viewer holds, confirmed in place: the first
  click turns the button into a question with the two answers beside it.
-->
<script lang="ts">
  let {
    disabled = false,
    ongiveback,
  }: {
    disabled?: boolean;
    ongiveback: () => void;
  } = $props();

  let asking = $state(false);
</script>

{#if asking}
  <span class="ask">
    <span class="q">Give back this task?</span>
    <button
      type="button"
      class="btn btn-soft"
      {disabled}
      onclick={() => {
        asking = false;
        ongiveback();
      }}>Give back</button
    >
    <button type="button" class="btn" onclick={() => (asking = false)}
      >Keep</button
    >
  </span>
{:else}
  <button
    type="button"
    class="btn btn-soft"
    {disabled}
    onclick={() => (asking = true)}
    title="Releases your claim so someone else can take the task. Work not yet submitted is not kept."
    >Give back</button
  >
{/if}

<style>
  .ask {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .q {
    font-size: 13px;
    color: var(--ink-soft);
  }
</style>
