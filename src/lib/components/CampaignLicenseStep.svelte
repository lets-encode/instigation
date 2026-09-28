<!--
  Wizard step 2: the licence the finished encoding is published under.

  It comes before anything is uploaded because it governs what volunteers are
  agreeing to when they contribute: every piece header and the campaign config
  record it, and changing it afterwards would mean asking everyone who has
  already encoded.

  Each licence is a radio card with what choosing it allows written on the
  card; the full licence text is linked below the chosen one.
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
  onBack={previousStep}
  onNext={nextStep}
>
  <div class="options" role="radiogroup" aria-label="Licence">
    {#each LICENSES as license (license.id)}
      <label class="option" class:on={wizard.license === license.id}>
        <input
          type="radio"
          name="license"
          value={license.id}
          bind:group={wizard.license}
        />
        <span class="option-text">
          <span class="option-name">{license.name}</span>
          <span class="option-info">{license.info}</span>
        </span>
      </label>
    {/each}
  </div>

  <p class="more">
    <a href={selected.url} target="_blank" rel="noreferrer">
      Read the full {selected.id} licence
    </a>
  </p>
</WizardCard>

<style>
  .more {
    margin: 12px 0 0;
    font-size: 12.5px;
  }
  .more a {
    color: var(--link);
  }
</style>
