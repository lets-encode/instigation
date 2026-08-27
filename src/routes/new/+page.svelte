<!--
  The campaign onboarding wizard. One flow across several screens, driven by
  the step index in the wizard store rather than by the URL, so state survives
  moving between steps. Arriving with ?slug=<name> (from the landing's start
  card) prefills the name step, which reads that query itself. The name "new"
  is reserved in the slug registry, so no campaign can shadow this route.
-->
<script lang="ts">
  import { auth, login } from "$lib/auth.svelte.ts";
  import { draftSnapshot, saveDraft, wizard } from "$lib/wizard.svelte.ts";
  import CampaignNameStep from "$lib/components/CampaignNameStep.svelte";
  import CampaignLicenseStep from "$lib/components/CampaignLicenseStep.svelte";
  import CampaignUploadStep from "$lib/components/CampaignUploadStep.svelte";
  import CampaignPagesStep from "$lib/components/CampaignPagesStep.svelte";
  import CampaignSourceStep from "$lib/components/CampaignSourceStep.svelte";
  import CampaignPiecesStep from "$lib/components/CampaignPiecesStep.svelte";
  import WizardCard from "$lib/components/WizardCard.svelte";

  // Mirror the wizard's entries into the browser as they change, so a setup
  // interrupted here can be continued from the landing's draft list. The draft
  // is collected on every change but written on a debounce, since one write
  // serialises all of it; a page about to go away — a Back press, a closed tab —
  // writes what is pending first, so the last edits before it are kept.
  $effect(() => {
    const owner = auth.user?.login;
    const snapshot = draftSnapshot();
    if (!owner) return;
    const timer = setTimeout(() => saveDraft(owner, snapshot), 500);
    const flush = () => saveDraft(owner, snapshot);
    addEventListener("pagehide", flush);
    return () => {
      clearTimeout(timer);
      removeEventListener("pagehide", flush);
    };
  });
</script>

<!--
  Every step renders the full workbench shell itself; this route only decides
  which step is on screen.
-->
{#if auth.status === "loading"}
  <p class="note checking">Checking your session…</p>
{:else if !auth.user}
  <WizardCard step="name" heading="Start a new encoding campaign">
    <p class="note login-note">
      Log in with GitHub to create a campaign. Its score, configuration and
      progress live in a repository on your account.
    </p>
    {#snippet footer()}
      <button type="button" class="btn btn-lg btn-primary" onclick={() => login()}>
        Log in with GitHub
      </button>
    {/snippet}
  </WizardCard>
{:else if wizard.step === "name"}
  <CampaignNameStep />
{:else if wizard.step === "license"}
  <CampaignLicenseStep />
{:else if wizard.step === "upload"}
  <CampaignUploadStep />
{:else if wizard.step === "pages"}
  <CampaignPagesStep />
{:else if wizard.step === "source"}
  <CampaignSourceStep />
{:else}
  <CampaignPiecesStep />
{/if}

<style>
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
  .checking {
    padding: 2rem 1.5rem;
  }
  .login-note {
    margin-top: 16px;
    font-size: 13.5px;
  }
</style>
