<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { auth, initAuth, login, logout } from '$lib/auth.svelte.ts';
  import './theme.css';
  import './ui.css';

  let { children } = $props();

  // The pre-paint script in app.html has already set data-theme before mount;
  // mirror it here so the bulb reflects the active theme, and flip + persist on
  // click. Only an explicit choice is stored — a functional preference.
  let theme = $state<'light' | 'dark'>('light');
  onMount(() => {
    theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  });
  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem('theme', theme);
    } catch (e) {
      /* storage unavailable — theme still applies for this visit */
    }
  }

  // The main screen, the campaign view, the wizard and the measure corrector
  // are full-bleed, full-height surfaces (the wizard splits into a form pane
  // and a page-preview pane); every other route keeps the narrow reading
  // column.
  const corrector = $derived(page.route.id === '/[campaign]/zones/[task]');
  const full = $derived(
    page.route.id === '/campaigns' || page.route.id === '/[campaign]' || page.route.id === '/new'
  );
  const onHome = $derived(page.route.id === '/campaigns');
  const inCampaign = $derived(page.route.id === '/[campaign]');

  // Resolve any existing broker session once the app mounts (client-only).
  onMount(() => {
    initAuth();
  });
</script>

<header>
  <a class="brand" href="/campaigns">
    <img class="brand-light" src="/logo.svg" alt="Let's Encode" width="1391" height="400" />
    <img class="brand-dark" src="/logo-dark.svg" alt="" aria-hidden="true" width="1391" height="400" />
  </a>
  <!-- Closing a screen lands one level up: the campaign view returns to the
       listing, the corrector to the campaign it belongs to. -->
  {#if inCampaign}
    <a class="nav-link back" href="/campaigns">← All campaigns</a>
  {:else if corrector}
    <a class="nav-link back" href={`/${page.params.campaign}`}
      >← {page.params.campaign}</a
    >
  {/if}
  <div class="topbar-right">
    {#if onHome}
      <a class="newbtn" href="/new">+ New campaign</a>
    {/if}
    {#if auth.user}
      <div class="user">
        {#if auth.user.avatar_url}
          <img class="avatar" src={auth.user.avatar_url} alt="" />
        {/if}
        <span>{auth.user.login}</span>
        <button type="button" class="btn btn-soft" onclick={() => logout()}>Log out</button>
      </div>
    {:else if auth.status === 'anonymous'}
      <button type="button" class="btn btn-soft" onclick={() => login()}>Log in with GitHub</button>
    {/if}
    <button
      class="theme-toggle"
      type="button"
      onclick={toggleTheme}
      aria-pressed={theme === 'dark'}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      title="Toggle light / dark theme"
    >
      <svg class="bulb" viewBox="-2 -2 28 28" width="22" height="22" aria-hidden="true" focusable="false">
        <g class="bulb-rays" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <line x1="12" y1="-1.8" x2="12" y2="2" />
          <line x1="21.8" y1="2.2" x2="18.9" y2="5.1" />
          <line x1="2.2" y1="2.2" x2="5.1" y2="5.1" />
          <line x1="24.6" y1="11" x2="20.8" y2="11" />
          <line x1="-0.6" y1="11" x2="3.2" y2="11" />
        </g>
        <path class="bulb-glass" d="M12 2.6a6.2 6.2 0 0 0-3.8 11.1c.75.58 1.25 1.4 1.35 2.35h4.9c.1-.95.6-1.77 1.35-2.35A6.2 6.2 0 0 0 12 2.6Z" />
        <path class="bulb-filament" d="M10 12.7 12 10l2 2.7" />
        <g class="bulb-base" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none">
          <path d="M9.6 16.2v1.6h4.8v-1.6" />
          <line x1="10.4" y1="20" x2="13.6" y2="20" />
        </g>
      </svg>
    </button>
  </div>
</header>

{#snippet body()}
  {#if auth.error}
    <p class="auth-error" role="alert">
      Sign-in failed: {auth.error}
      <button type="button" class="btn btn-soft" onclick={() => (auth.error = null)}>Dismiss</button>
    </p>
  {/if}
  {@render children()}
{/snippet}

<main class:full={full || corrector}>
  {#if corrector || full}
    {@render body()}
  {:else}
    <div class="column">
      {@render body()}
    </div>
  {/if}
</main>

<footer>
  <span>© 2026 Let's Encode! • mdw - University of Music and Performing Arts Vienna</span>
  <span class="fsep">·</span>
  <span>app last updated {__BUILD_DATE__}</span>
</footer>

<style>
  :global(body) {
    margin: 0;
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    font-family: var(--font);
    color: var(--ink);
    background: var(--bg-alt);
  }
  header {
    flex: none;
    box-sizing: border-box;
    height: 56px;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 20px;
    border-bottom: 1px solid var(--line);
    background: var(--topbar-bg);
  }
  .topbar-right {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    margin-left: auto;
  }
  .brand img {
    height: 30px;
    width: auto;
    display: block;
  }
  /* The two logo variants differ only in the wordmark colour: black text for
     light backgrounds, cream for dark. Show the one matching the theme. */
  .brand img.brand-dark {
    display: none;
  }
  :global([data-theme='dark']) .brand img.brand-light {
    display: none;
  }
  :global([data-theme='dark']) .brand img.brand-dark {
    display: block;
  }
  .nav-link {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--ink-soft);
    text-decoration: none;
  }
  .nav-link:hover {
    color: var(--accent);
  }
  .nav-link.back {
    font-size: 13px;
    color: var(--link);
    margin-left: 4px;
  }
  .newbtn {
    font: 600 13px var(--font);
    padding: 7px 14px;
    background: var(--card);
    border: 1px solid var(--line-input);
    border-radius: 999px;
    color: var(--accent);
    text-decoration: none;
  }
  .newbtn:hover {
    border-color: var(--info-line);
    background: var(--accent-tint);
  }
  .user {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13.5px;
  }
  .user :global(.btn) {
    font-size: 14px;
    padding: 6px 13px;
    background: var(--bg-alt);
  }
  .avatar {
    width: 26px;
    height: 26px;
    border-radius: 50%;
  }
  .auth-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid #e0b4b4;
    border-radius: 6px;
    background: #fdf2f2;
    color: #9f3a38;
  }
  main {
    flex: 1;
    min-height: 0;
    overflow: auto;
    width: 100%;
    box-sizing: border-box;
  }
  /* Default reading pages scroll on <main> (full width) so the scrollbar sits
     at the window edge, while the content stays in a centred, readable column. */
  .column {
    max-width: 760px;
    margin: 0 auto;
    padding: 2.5rem 1.5rem;
    box-sizing: border-box;
  }
  main.full {
    max-width: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  footer {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 7px 24px;
    background: var(--topbar-bg);
    border-top: 1px solid var(--line);
    font-size: 11.5px;
    color: var(--ink-faint);
  }
  .fsep {
    color: var(--line);
  }
  /* ---- Theme (light/dark) bulb toggle --------------------------------- */
  .theme-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    padding: 0;
    cursor: pointer;
    color: var(--ink-soft);
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 999px;
    transition:
      color 0.15s ease,
      border-color 0.15s ease,
      background 0.15s ease,
      transform 0.15s ease;
  }
  .theme-toggle:hover {
    color: var(--accent);
    border-color: var(--accent);
    background: transparent;
    transform: translateY(-1px);
  }
  .theme-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .bulb {
    display: block;
  }
  .bulb-glass {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linejoin: round;
    transition: fill 0.2s ease;
  }
  .bulb-filament {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.55;
    transition: opacity 0.2s ease;
  }
  .bulb-rays {
    opacity: 0;
    transform-origin: 12px 11px;
    transition:
      opacity 0.2s ease,
      transform 0.2s ease;
  }
  /* Lit bulb in dark mode: a warm glowing shine so it reads as "on". */
  :global([data-theme='dark']) .theme-toggle {
    color: #ffdf85;
    border-color: rgba(255, 223, 133, 0.55);
  }
  :global([data-theme='dark']) .theme-toggle:hover {
    color: #ffe9a6;
    border-color: #ffdf85;
    background: rgba(255, 223, 133, 0.14);
  }
  :global([data-theme='dark']) .bulb {
    filter: drop-shadow(0 0 3px rgba(255, 210, 110, 0.8));
  }
  :global([data-theme='dark']) .bulb-glass {
    fill: rgba(255, 223, 133, 0.45);
  }
  :global([data-theme='dark']) .bulb-filament {
    opacity: 1;
  }
  :global([data-theme='dark']) .bulb-rays {
    opacity: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    .theme-toggle,
    .bulb-glass,
    .bulb-filament,
    .bulb-rays {
      transition: none;
    }
  }
</style>
