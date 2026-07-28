<!--
  The campaign onboarding wizard, and the entry point to the app.

  One flow across several screens, driven by the step index in the wizard store
  rather than by the URL, so state survives moving between steps. The slug
  registry hands a chosen name off to /c?slug=, which hooks.ts reroutes here;
  the name step reads that query.
-->
<script lang="ts">
  import { auth, login } from "$lib/auth.svelte.ts";
  import { draftEntries, saveDraft, wizard } from "$lib/wizard.svelte.ts";
  import CampaignNameStep from "$lib/components/CampaignNameStep.svelte";
  import CampaignLicenseStep from "$lib/components/CampaignLicenseStep.svelte";
  import CampaignUploadStep from "$lib/components/CampaignUploadStep.svelte";
  import CampaignSourceStep from "$lib/components/CampaignSourceStep.svelte";
  import CampaignPiecesStep from "$lib/components/CampaignPiecesStep.svelte";
  import CampaignDrafts from "$lib/components/CampaignDrafts.svelte";
  import CampaignList from "$lib/components/CampaignList.svelte";
  import WizardCard from "$lib/components/WizardCard.svelte";

  // The listing is context for someone arriving at the app; once they are part
  // way through creating a campaign it is just noise below the form.
  const atStart = $derived(!auth.user || wizard.step === "name");

  // Mirror the wizard's entries into the browser as they change, so a setup
  // interrupted here can be continued from the listing above. The entries are
  // collected on every change but written on a debounce, since one write
  // serialises the whole draft.
  $effect(() => {
    const owner = auth.user?.login;
    const handle = wizard.handle;
    const entries = draftEntries();
    if (!owner) return;
    const timer = setTimeout(() => saveDraft(owner, handle, entries), 500);
    return () => clearTimeout(timer);
  });
</script>

<!--
  Steps that pin a page strip to the bottom manage their own layout; the rest
  are centred in a scroller, since the route is a full-height surface.
-->
{#if auth.user && wizard.step === "source"}
  <CampaignSourceStep />
{:else if auth.user && wizard.step === "pieces"}
  <CampaignPiecesStep />
{:else}
  <div class="pane-scroll">
    {#if auth.status === "loading"}
      <p class="note">Checking your session…</p>
    {:else if !auth.user}
      <WizardCard step="name" heading="Start a new encoding campaign">
        <p class="note">
          Log in with GitHub to create a campaign. Its score, configuration and
          progress live in a repository on your account.
        </p>
        {#snippet footer()}
          <button type="button" class="btn btn-primary" onclick={() => login()}>
            Log in with GitHub
          </button>
        {/snippet}
      </WizardCard>
    {:else if wizard.step === "name"}
      <CampaignNameStep />
    {:else if wizard.step === "license"}
      <CampaignLicenseStep />
    {:else}
      <CampaignUploadStep />
    {/if}

    {#if atStart}
      <CampaignDrafts />
      <CampaignList />
    {/if}
  </div>
{/if}

<style>
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
</style>
