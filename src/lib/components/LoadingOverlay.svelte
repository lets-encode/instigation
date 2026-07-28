<!--
  A modal spinner over the whole viewport, shown while an action that runs on
  the forge is in flight. The palette is fixed rather than themed, matching the
  console surfaces it covers.
-->
<script lang="ts">
  let { message }: { message: string } = $props();
</script>

<div class="overlay" role="status" aria-live="polite">
  <div class="overlay-card">
    <div class="spinner" aria-hidden="true"></div>
    <p class="overlay-title">{message || "Working…"}</p>
    <p class="overlay-sub">
      The campaign automation runs on GitHub — this can take a few seconds.
    </p>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
    backdrop-filter: blur(2px);
  }
  .overlay-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 26px 34px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: 0 12px 44px var(--shade);
    text-align: center;
  }
  .spinner {
    width: 34px;
    height: 34px;
    border: 3px solid var(--line);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
  }
  .overlay-title {
    margin: 0;
    font-weight: 600;
    font-size: 14px;
  }
  .overlay-sub {
    margin: 0;
    color: var(--ink-faint);
    font-size: 0.85rem;
  }
</style>
