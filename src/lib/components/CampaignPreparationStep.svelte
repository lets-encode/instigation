<!--
  Wizard step 7: how the facsimile pieces get their measures before encoding
  starts, and the button that finishes the setup. Measure detection contacts
  the edirom detector for every page when Finish is pressed; optical music
  recognition leaves the pages as they are — their staves and measures are
  found in each piece's layout task, and every page is transcribed when its
  encoding task is claimed.

  Finishing builds the scores, the configuration and the tables and commits
  them (campaign-finish.svelte.ts). The step is skipped when the campaign has
  no page images; the pieces step finishes the setup then.
-->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { wizard, previousStep } from "$lib/wizard.svelte.ts";
  import { CampaignFinisher } from "$lib/campaign-finish.svelte.ts";
  import type { Preparation } from "$lib/campaign-init.ts";
  import WizardCard from "./WizardCard.svelte";
  import FacsimilePages from "./FacsimilePages.svelte";
  import ProgressSteps from "./ProgressSteps.svelte";

  const OPTIONS: { id: Preparation; name: string; info: string }[] = [
    {
      id: "measure-detection",
      name: "Measure detection",
      info:
        "Measure boxes are detected on every page when you finish and corrected by volunteers " +
        "in a measure-correction task. Encoding starts from empty measures.",
    },
    {
      id: "omr",
      name: "Optical music recognition",
      info:
        "Staves and measures are detected and corrected in a layout task. The staves are then " +
        "transcribed in the score setup, and each page's encoding starts from that draft. " +
        "Page images are sent to the Musibot service (Charles University) for recognition.",
    },
  ];

  const finisher = new CampaignFinisher();
  onDestroy(() => finisher.cancel());
</script>

{#snippet material()}
  <FacsimilePages pages={wizard.images} />
{/snippet}

<WizardCard
  step="preparation"
  heading="Prepare the scores"
  intro="How the pieces get their measures before encoding starts."
  status="choosing the preparation"
  {material}
  onBack={previousStep}
  backDisabled={finisher.busy}
  onNext={() => finisher.run()}
  nextDisabled={finisher.busy}
  nextLabel={finisher.busy ? "Working…" : finisher.error ? "Retry" : "Finish"}
  nextIcon={finisher.busy ? null : finisher.error ? "arrow-right" : "check"}
  finish
>
  <div class="options" role="radiogroup" aria-label="Preparation">
    {#each OPTIONS as option (option.id)}
      <label class="option" class:on={wizard.preparation === option.id}>
        <input
          type="radio"
          name="preparation"
          value={option.id}
          bind:group={wizard.preparation}
          onchange={() => finisher.reset()}
          disabled={finisher.busy}
        />
        <span class="option-text">
          <span class="option-name">{option.name}</span>
          <span class="option-info">{option.info}</span>
        </span>
      </label>
    {/each}
  </div>

  {#if finisher.error}
    <p class="msg-error" role="alert">{finisher.error}</p>
  {/if}
  <ProgressSteps log={finisher.log} />
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
</style>
