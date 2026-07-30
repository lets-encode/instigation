<!--
  The entry point to the app: the landing screen — pick a campaign name and
  check it live, with the drafts and the campaign listing below — and the
  campaign onboarding wizard once a setup is underway.

  The wizard is one flow across several screens, driven by the step index in
  the wizard store rather than by the URL, so state survives moving between
  steps. Create on the landing hands the chosen name off to /c?slug=, which
  hooks.ts reroutes here; the name step reads that query and prefills.
-->
<script lang="ts">
  import { page } from "$app/state";
  import { auth, login } from "$lib/auth.svelte.ts";
  import { draftSnapshot, saveDraft, wizard } from "$lib/wizard.svelte.ts";
  import LandingStart from "$lib/components/LandingStart.svelte";
  import CampaignNameStep from "$lib/components/CampaignNameStep.svelte";
  import CampaignLicenseStep from "$lib/components/CampaignLicenseStep.svelte";
  import CampaignUploadStep from "$lib/components/CampaignUploadStep.svelte";
  import CampaignPagesStep from "$lib/components/CampaignPagesStep.svelte";
  import CampaignSourceStep from "$lib/components/CampaignSourceStep.svelte";
  import CampaignPiecesStep from "$lib/components/CampaignPiecesStep.svelte";
  import CampaignDrafts from "$lib/components/CampaignDrafts.svelte";
  import CampaignList from "$lib/components/CampaignList.svelte";
  import WizardCard from "$lib/components/WizardCard.svelte";

  // The landing shows until a setup is underway: a name arriving via /c?slug=
  // (the wizard opens to take it), a held name, or a step past the first. A
  // continued draft re-opens past the first step, so it lands in the wizard.
  const landing = $derived(
    !page.url.searchParams.get("slug") &&
      wizard.step === "name" &&
      !wizard.claim,
  );

  // Mirror the wizard's entries into the browser as they change, so a setup
  // interrupted here can be continued from the listing above. The draft is
  // collected on every change but written on a debounce, since one write
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
  Steps that hold a page pane beside the form manage their own layout; the rest
  are centred in a scroller, since the route is a full-height surface.
-->
{#if landing}
  <!-- The landing keeps the redirector's look: the card centred on the hero
       gradient, with the drafts and the campaign listing further down. -->
  <div class="landing">
    <div class="landing-hero">
      <LandingStart />
    </div>
    <div class="landing-below">
      <CampaignDrafts />
      <CampaignList />
    </div>
  </div>
{:else if auth.user && wizard.step === "source"}
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
    {:else if wizard.step === "upload"}
      <CampaignUploadStep />
    {:else}
      <CampaignPagesStep />
    {/if}
  </div>
{/if}

<style>
  .note {
    margin: 0;
    color: var(--ink-soft);
  }
  /* The scroll surface itself carries the hero gradient (ported from the
     redirector's landing), so it runs edge to edge behind card and listing. */
  .landing {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    background:
      radial-gradient(60% 90% at 15% 0%, rgba(109, 195, 255, 0.18), transparent 60%),
      radial-gradient(60% 90% at 85% 10%, rgba(118, 222, 118, 0.18), transparent 60%),
      radial-gradient(50% 80% at 50% 100%, rgba(255, 167, 109, 0.16), transparent 60%),
      var(--bg-alt);
  }
  /* The card sits high rather than viewport-centred, so the campaign listing
     is already in view below it. */
  .landing-hero {
    display: flex;
    justify-content: center;
    padding: clamp(1.5rem, 4vh, 3rem) 1.5rem 0;
  }
  .landing-hero > :global(*) {
    width: 100%;
  }
  .landing-below {
    padding: 2.5rem 1.5rem 3rem;
  }
</style>
