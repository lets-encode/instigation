<!--
  The landing card, visually carried over from the redirector's landing page:
  wordmark, heading, a pill-shaped name field with the host as its prefix, and
  a live availability notice. The check asks the registry, which is public, so
  it works logged out. Create forwards to /c?slug=<name> — the onboarding
  wizard, name prefilled and still editable (hooks.ts reroutes /c to the home
  route) — and a name that is already a campaign links to it instead.
-->
<script lang="ts">
  import { goto } from "$app/navigation";
  import { lookupSlug } from "$lib/campaign-resolve.ts";
  import { isValidHandle } from "$lib/campaign-handle.ts";

  /** Rail variant: no wordmark, tighter spacing (the dashboard's start card). */
  let { compact = false }: { compact?: boolean } = $props();

  const host = location.host;

  let name = $state("");

  // Live availability, debounced; a sequence number discards results of
  // superseded checks. "unknown" means the registry could not be reached.
  type CheckState =
    | "idle"
    | "invalid"
    | "checking"
    | "free"
    | "active"
    | "pending"
    | "reserved"
    | "tombstoned"
    | "unknown";
  let check = $state<CheckState>("idle");
  let checkSeq = 0;

  $effect(() => {
    const n = name.trim();
    const seq = ++checkSeq;
    if (!n) {
      check = "idle";
      return;
    }
    if (!isValidHandle(n)) {
      check = "invalid";
      return;
    }
    check = "checking";
    const timer = setTimeout(async () => {
      const info = await lookupSlug(n);
      if (seq !== checkSeq) return;
      check = info ? info.status : "unknown";
    }, 300);
    return () => clearTimeout(timer);
  });

  // "unknown" may proceed: the name step checks again, and the claim there
  // verifies it for good.
  const canCreate = $derived(check === "free" || check === "unknown");

  // The availability notice under the form: its box style and its wording.
  const notice = $derived.by(() => {
    const n = name.trim();
    switch (check) {
      case "checking":
        return { tone: "", text: "Checking availability…" };
      case "free":
        return { tone: "notice-ok", text: `“${n}” is available.` };
      case "active":
        return { tone: "notice-warn", text: `“${n}” is already a campaign.` };
      case "pending":
        return {
          tone: "notice-warn",
          text: `“${n}” is taken by a campaign being set up.`,
        };
      case "reserved":
        return { tone: "notice-error", text: `“${n}” is reserved and can't be used.` };
      case "tombstoned":
        return {
          tone: "notice-error",
          text: `“${n}” has been blocked and can't be used.`,
        };
      case "invalid":
        return {
          tone: "notice-error",
          text: "Use 3–40 characters: lowercase letters, digits, and single internal hyphens.",
        };
      case "unknown":
        return {
          tone: "",
          text: "Couldn't check availability — it will be verified when the name is reserved.",
        };
      default:
        return null;
    }
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!canCreate) return;
    goto(`/c?slug=${encodeURIComponent(name.trim())}`);
  }
</script>

<form class="panel" class:compact onsubmit={submit}>
  <img
    class="wordmark wordmark-light"
    src="/logo.svg"
    alt="Let's Encode!"
    width="1391"
    height="400"
  />
  <img
    class="wordmark wordmark-dark"
    src="/logo-dark.svg"
    alt=""
    aria-hidden="true"
    width="1391"
    height="400"
  />
  <h1>Start an encoding campaign</h1>
  <p class="lead">
    Pick a name for your campaign — it will live at<br />
    <span class="slug">{host}/&lt;your-campaign-name&gt;</span>
  </p>
  <div class="name-form">
    <span class="slug-field">
      <span class="slug-prefix">{host}/</span>
      <input
        type="text"
        bind:value={name}
        placeholder="my-campaign-name"
        minlength="3"
        maxlength="40"
        autocomplete="off"
        spellcheck="false"
        required
        aria-label="Campaign name"
        aria-describedby="probe-msg"
      />
    </span>
  </div>
  <div class="actions">
    <button type="submit" class="btn btn-primary" disabled={!canCreate}>
      Create campaign
    </button>
  </div>
  {#if notice}
    <p class="notice {notice.tone}" id="probe-msg" role="status" aria-live="polite">
      {notice.text}
    </p>
  {/if}
  {#if check === "active"}
    <p class="go">
      <a class="btn-ghost" href={`/${encodeURIComponent(name.trim())}`}>
        Go to this campaign →
      </a>
    </p>
  {/if}
  <p class="rules">
    3–40 characters: lowercase letters, digits, and single internal hyphens.
  </p>
</form>

<style>
  .panel {
    max-width: 34rem;
    margin: 0 auto;
    text-align: center;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: clamp(2.25rem, 5vw, 3.5rem) clamp(1.75rem, 4vw, 2.75rem);
  }
  /* Two wordmark files so the black-text light logo can swap for the cream-text
     dark logo — the hands stay coloured in both. */
  .wordmark {
    width: min(72vw, 320px);
    height: auto;
    margin: 0 auto 1.5rem;
    display: block;
  }
  .wordmark-dark {
    display: none;
  }
  /* The rail card: the wordmark is already in the app bar, the heading and
     spacing come down a step so the card reads as one panel among others. */
  .panel.compact {
    padding: 30px 30px 24px;
    box-shadow: 0 1px 2px rgba(31, 36, 51, 0.07);
  }
  .panel.compact .wordmark {
    display: none;
  }
  .panel.compact h1 {
    font-size: 21px;
    margin-bottom: 0.5rem;
  }
  .panel.compact .lead {
    font-size: 13.5px;
    margin-bottom: 0.75rem;
  }
  .panel.compact .name-form {
    margin: 1rem 0 0.9rem;
  }
  .panel.compact .actions {
    margin-bottom: 0.9rem;
  }
  .panel.compact .rules {
    font-size: 11.5px;
  }
  :global([data-theme="dark"]) .wordmark-light {
    display: none;
  }
  :global([data-theme="dark"]) .wordmark-dark {
    display: block;
  }
  h1 {
    font-size: clamp(1.4rem, 3.2vw, 1.95rem);
    margin: 0 0 1rem;
  }
  .lead {
    color: var(--ink-soft);
    max-width: 46ch;
    margin: 0 auto 1.25rem;
  }
  .slug {
    display: inline-block;
    margin-top: 0.5rem;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.92em;
    background: var(--bg-alt);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.08em 0.4em;
  }
  .name-form {
    display: flex;
    justify-content: center;
    margin: 1.75rem 0 1.25rem;
  }
  .slug-field {
    display: inline-flex;
    align-items: center;
    gap: 0.1rem;
    flex: 1;
    max-width: 26rem;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0 0.9rem;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
  }
  .slug-field:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .slug-prefix {
    color: var(--ink-faint);
    font-size: 0.98rem;
    white-space: nowrap;
    user-select: none;
  }
  input {
    font: inherit;
    font-size: 1rem;
    padding: 0.7rem 0.1rem;
    min-width: 0;
    flex: 1;
    color: var(--ink);
    background: transparent;
    border: 0;
    outline: none;
  }
  input::placeholder {
    color: var(--ink-faint);
  }
  .actions {
    display: flex;
    justify-content: center;
    margin: 0 0 1.5rem;
  }
  .actions .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  /* Notice tints carried over from the redirector (redirector.css): faint
     washes of the status colour rather than the console's filled banners. */
  .notice {
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin: 0 auto 1.25rem;
    max-width: 46ch;
    text-align: left;
  }
  .notice-ok {
    color: #1a7f37;
    background: rgba(26, 127, 55, 0.07);
    border-color: rgba(26, 127, 55, 0.28);
  }
  :global([data-theme="dark"]) .notice-ok {
    color: #6fd48b;
    background: rgba(80, 200, 120, 0.1);
    border-color: rgba(80, 200, 120, 0.32);
  }
  .notice-warn {
    color: #8a6d00;
    background: rgba(180, 140, 0, 0.08);
    border-color: rgba(180, 140, 0, 0.3);
  }
  :global([data-theme="dark"]) .notice-warn {
    color: #e8c66b;
    background: rgba(230, 190, 90, 0.1);
    border-color: rgba(230, 190, 90, 0.32);
  }
  .notice-error {
    color: #a51d2d;
    background: rgba(165, 29, 45, 0.07);
    border-color: rgba(165, 29, 45, 0.28);
  }
  :global([data-theme="dark"]) .notice-error {
    color: #ff9aa4;
    background: rgba(255, 120, 130, 0.1);
    border-color: rgba(255, 120, 130, 0.32);
  }
  .go {
    margin: 0 0 1.25rem;
  }
  .btn-ghost {
    display: inline-block;
    padding: 0.5rem 1.2rem;
    font-weight: 600;
    text-decoration: none;
    color: var(--ink);
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 999px;
  }
  .btn-ghost:hover {
    border-color: var(--line-strong);
  }
  .rules {
    color: var(--ink-faint);
    font-size: 0.9rem;
    margin: 0;
  }
</style>
