<!--
  Wizard step 3: metadata describing the source as a whole — the physical
  manifestation the pieces were read from. Each piece copies this into its own
  header at the end, so it is collected once here rather than per piece.

  Nothing is committed by this step: the values stay in the browser until the
  final step writes them with the configuration and the piece MEIs.
-->
<script lang="ts">
  import { wizard, nextStep, previousStep } from "$lib/wizard.svelte.ts";
  import WizardCard from "./WizardCard.svelte";
  import MetadataForm from "./MetadataForm.svelte";
  import FacsimileStrip from "./FacsimileStrip.svelte";
</script>

<!-- Two panes over the full height: the form scrolls in the top one, the page
     strip holds the bottom one and carries the divider between them. -->
<div class="pane-split">
  <div class="pane-scroll">
    <WizardCard
      step="source"
      heading="Describe the source"
      intro="What the pages were taken from. Every piece inherits this, and can add its own details next."
      onBack={previousStep}
      onNext={nextStep}
    >
      <MetadataForm bind:meta={wizard.source} />
    </WizardCard>
  </div>

  <FacsimileStrip pages={wizard.images} />
</div>
