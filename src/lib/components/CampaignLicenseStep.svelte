<!--
  Wizard step 2: the licence the finished encoding is published under.

  It comes before anything is uploaded because it governs what volunteers are
  agreeing to when they contribute: every piece header and the campaign config
  record it, and changing it afterwards would mean asking everyone who has
  already encoded.
-->
<script lang="ts">
  import { LICENSES, licenseById } from "$lib/licenses.ts";
  import { wizard, nextStep, previousStep } from "$lib/wizard.svelte.ts";
  import WizardCard from "./WizardCard.svelte";

  const selected = $derived(licenseById(wizard.license));
</script>

<WizardCard
  step="license"
  heading="Choose a licence"
  intro="How others may use the finished encoding. It applies to every contribution volunteers make."
  onBack={previousStep}
  onNext={nextStep}
>
  <label class="field">
    Licence
    <select class="input" bind:value={wizard.license}>
      {#each LICENSES as license (license.id)}
        <option value={license.id}>{license.name}</option>
      {/each}
    </select>
  </label>

  <p class="info">{selected.info}</p>
  <p class="more">
    <a href={selected.url} target="_blank" rel="noreferrer">
      Read the full {selected.id} licence
    </a>
  </p>
</WizardCard>

<style>
  .info {
    margin: 1rem 0 0;
    padding: 0.8rem 0.9rem;
    font-size: 0.9rem;
    color: var(--ink-soft);
    background: var(--bg-tint);
    border-radius: 6px;
  }
  .more {
    margin: 0.6rem 0 0;
    font-size: 0.85rem;
  }
  .more a {
    color: var(--link);
  }
</style>
