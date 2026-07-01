<script lang="ts">
  import { onMount } from 'svelte';
  import { auth, initAuth, logout } from '$lib/auth.svelte.ts';

  let { children } = $props();

  // Resolve any token already in sessionStorage once the app mounts (client-only).
  onMount(() => {
    initAuth();
  });
</script>

<header>
  <a class="brand" href="/">
    <img src="/lets-encode.png" alt="Let's Encode" />
  </a>
  {#if auth.user}
    <div class="user">
      {#if auth.user.avatar_url}
        <img class="avatar" src={auth.user.avatar_url} alt="" />
      {/if}
      <span>{auth.user.login}</span>
      <button type="button" onclick={() => logout()}>Log out</button>
    </div>
  {/if}
</header>

<main>
  {@render children()}
</main>

<style>
  :global(body) {
    margin: 0;
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      sans-serif;
    color: #1a1a1a;
    background: #fafafa;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.5rem;
    border-bottom: 1px solid #e5e5e5;
    background: #fff;
  }
  .brand img {
    height: 36px;
    display: block;
  }
  .user {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.9rem;
  }
  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
  }
  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem;
  }
  button {
    cursor: pointer;
    font: inherit;
    padding: 0.4rem 0.8rem;
    border: 1px solid #d0d0d0;
    border-radius: 6px;
    background: #f5f5f5;
  }
  button:hover {
    background: #ececec;
  }
</style>
