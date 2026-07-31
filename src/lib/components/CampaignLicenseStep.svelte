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
  status={selected.name.split(" — ")[0]}
  materialHint="The licence comes first — it governs what volunteers agree to when they contribute."
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
  .field {
    margin-top: 22px;
  }
  .info {
    margin: 14px 0 0;
    padding: 12px 14px;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--ink-soft);
    background: var(--bg-alt);
    border-radius: 8px;
  }
  .more {
    margin: 9px 0 0;
    font-size: 12.5px;
  }
  .more a {
    color: var(--link);
  }
</style>
