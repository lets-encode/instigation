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
  .options {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 24px;
  }
  .option {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 14px 16px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    cursor: pointer;
  }
  .option:hover {
    border-color: var(--accent);
  }
  /* Selected: a 1.5px accent ring, the extra half pixel drawn inside so the
     card does not shift. */
  .option.on {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 0.5px var(--accent);
    background: var(--accent-tint);
  }
  .option input {
    margin-top: 3px;
    accent-color: var(--accent);
  }
  .option-name {
    display: block;
    font-size: 14px;
    font-weight: 600;
  }
  .option-info {
    display: block;
    margin-top: 3px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ink-soft);
  }
  .more {
    margin: 12px 0 0;
    font-size: 12.5px;
  }
  .more a {
    color: var(--link);
  }
</style>
