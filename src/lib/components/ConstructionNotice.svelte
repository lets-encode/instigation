<!--
  The under-construction notice. On the campaign listing and the wizard a
  dialog opens until this browser has confirmed it, and the banner shows once
  it has; every other page shows the banner. The banner's Details link opens
  the same dialog. Only "I understand" marks
  the notice as seen; Escape or a click outside closes it for this visit.
-->
<script lang="ts">
  import { page } from "$app/state";
  import Icon from "./Icon.svelte";
  import { bugReportHref } from "$lib/bug-report.ts";

  const SEEN_KEY = "construction-notice-seen";

  let dialog = $state<HTMLDialogElement>();
  const withDialog = $derived(
    page.route.id === "/campaigns" || page.route.id === "/new",
  );

  const reportHref = $derived(bugReportHref(page.url.pathname));

  function seen(): boolean {
    try {
      return localStorage.getItem(SEEN_KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  let confirmed = $state(seen());

  function open() {
    if (dialog && !dialog.open) dialog.showModal();
  }

  function confirm() {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch (e) {
      /* storage unavailable — the dialog opens again on the next visit */
    }
    confirmed = true;
    dialog?.close();
  }

  $effect(() => {
    if (withDialog && !confirmed) open();
  });

  // Surfaces fixed below the top bar offset themselves by the banner's
  // current height, read as --notice-h.
  const withBanner = $derived(!withDialog || confirmed);
  let bannerHeight = $state(0);
  $effect(() => {
    document.documentElement.style.setProperty(
      "--notice-h",
      `${withBanner ? bannerHeight : 0}px`,
    );
  });
</script>

{#if withBanner}
  <div class="banner" role="note" bind:offsetHeight={bannerHeight}>
    <Icon name="warning" size={16} />
    <span class="banner-text"
      ><strong>Under construction.</strong> Data on this platform can be reset
      at any time. GitHub repositories created with the platform are kept, but
      the platform may no longer open them.
      <span class="banner-links">
        <button type="button" class="link" onclick={open}>Details</button>
        <a href={reportHref} target="_blank" rel="noopener">Report a bug</a>
      </span></span
    >
  </div>
{/if}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  aria-labelledby="construction-title"
  onclick={(e) => {
    if (e.target === dialog) dialog.close();
  }}
>
  <div class="sheet">
    <div class="stripe" aria-hidden="true">
      <span></span><span></span><span></span>
    </div>
    <div class="content">
      <div class="head">
        <span class="tag"><Icon name="warning" size={13} /> Test version</span>
        <h2 id="construction-title">This site is under construction</h2>
      </div>
      <p class="intro">
        Let's Encode! is a citizen-science project that helps anyone turn sheet
        music into machine-readable encodings in the MEI format. On this
        platform you can start an encoding campaign for a collection of scores
        or join an existing one: volunteers encode the pieces, other volunteers
        check them, and every campaign is stored in its own GitHub repository.
      </p>
      <ul class="points">
        <li>
          <span class="pi pi-blue"><Icon name="check-circle" size={20} /></span>
          <span
            >You can try out every feature. Report bugs and feedback with the <strong
              >Report a bug</strong
            > button.</span
          >
        </li>
        <li>
          <span class="pi pi-orange"><Icon name="reset" size={20} /></span>
          <span
            >Campaigns and all other data on this platform can be reset at any
            time. We do not guarantee that campaigns are kept.</span
          >
        </li>
        <li>
          <span class="pi pi-green"><Icon name="lock" size={20} /></span>
          <span
            >GitHub repositories created with the platform stay in your GitHub
            account and are not affected by a reset, but after a reset the
            platform may no longer show or open them.</span
          >
        </li>
      </ul>
      <div class="actions">
        <a class="about" href="/" target="_blank" rel="noopener"
          >About Let's Encode! <Icon
            name="external"
            size={13}
            label="opens in a new tab"
          /></a
        >
        <div class="buttons">
          <a class="btn btn-lg" href={reportHref} target="_blank" rel="noopener"
            >Report a bug</a
          >
          <button type="button" class="btn btn-lg btn-primary" onclick={confirm}
            >I understand</button
          >
        </div>
      </div>
    </div>
  </div>
</dialog>

<style>
  .banner {
    flex: none;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    gap: 8px;
    padding: 9px 20px;
    background: var(--warn-bg);
    border-bottom: 1px solid var(--warn-line);
    font-size: 13.5px;
    line-height: 1.4;
    color: var(--ink);
  }
  .banner > :global(.icon) {
    color: var(--warn);
    margin-top: 1px;
  }
  .banner strong {
    font-weight: 600;
  }
  .banner-links {
    display: inline-flex;
    gap: 16px;
    margin-left: 12px;
    white-space: nowrap;
  }
  .banner-links a,
  .link {
    font: inherit;
    font-weight: 600;
    color: var(--warn);
    text-decoration: underline;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  dialog {
    width: 600px;
    max-width: calc(100vw - 32px);
    max-height: calc(100dvh - 32px);
    padding: 0;
    border: none;
    border-radius: 16px;
    background: var(--card);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  dialog::backdrop {
    background: rgba(35, 40, 56, 0.48);
  }
  .stripe {
    display: flex;
    height: 6px;
  }
  .stripe span {
    flex: 1;
    background: var(--blue);
  }
  .stripe span:nth-child(2) {
    background: var(--green);
  }
  .stripe span:nth-child(3) {
    background: #ffa76d;
  }
  .content {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 36px 40px 32px;
  }
  .head {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-radius: 999px;
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    color: var(--warn);
    font-size: 13px;
    font-weight: 600;
  }
  h2 {
    margin: 0;
    font-size: 28px;
    line-height: 1.2;
    font-weight: 600;
  }
  .intro {
    margin: 0;
    font-size: 16px;
    line-height: 1.55;
    color: var(--ink-soft);
  }
  .points {
    list-style: none;
    margin: 0;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    border-radius: 12px;
    background: var(--bg-alt);
    font-size: 15px;
    line-height: 1.5;
  }
  .points li {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .points strong {
    font-weight: 600;
  }
  .pi {
    display: inline-flex;
    margin-top: 1px;
  }
  .pi-blue {
    color: var(--accent);
  }
  .pi-orange {
    color: var(--warn);
  }
  .pi-green {
    color: var(--ok);
  }
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    padding-top: 4px;
  }
  .about {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 15px;
    color: var(--link);
  }
  .buttons {
    display: flex;
    gap: 12px;
  }

  @media (max-width: 560px) {
    dialog {
      width: 100%;
      max-width: 100%;
      margin: auto 0 0;
      border-radius: 16px 16px 0 0;
    }
    .content {
      padding: 24px 20px 28px;
      gap: 16px;
    }
    h2 {
      font-size: 22px;
    }
    .intro {
      font-size: 15px;
    }
    .points {
      padding: 16px;
      font-size: 14px;
    }
    .buttons {
      width: 100%;
      flex-direction: column-reverse;
    }
  }
</style>
