<!--
  Wizard step 5: metadata describing the source as a whole — the physical
  manifestation the pieces were read from. Each piece copies this into its own
  header at the end, so it is collected once here rather than per piece.

  The committed pages stay in the material pane for reference — publisher and
  year sit on the title page. Switching the form to its XML view hands the
  material pane to the editor at full width; "Show the pages" swaps back
  without leaving the XML view.

  Nothing is committed by this step: the values stay in the browser until the
  final step writes them with the configuration and the piece MEIs.
-->
<script lang="ts">
  import { parseSourceHead } from "$lib/source-metadata.ts";
  import { wizard, nextStep, previousStep } from "$lib/wizard.svelte.ts";
  import WizardCard from "./WizardCard.svelte";
  import MetadataForm from "./MetadataForm.svelte";
  import FacsimilePages from "./FacsimilePages.svelte";
  import XmlEditor from "./XmlEditor.svelte";

  let view = $state<"short" | "long" | "xml">("short");
  let xml = $state("");
  // In the XML view, the pages can be brought back without leaving it.
  let showPages = $state(false);
  let wrap = $state(true);

  const editing = $derived(view === "xml" && !showPages);

  // Pre-fill the extent from the upload's page count — the full upload when it
  // is known, otherwise the committed pages. Editable like any other field.
  const knownPages = wizard.candidates.length || wizard.images.length;
  if (!wizard.source.extent.trim() && knownPages > 0) {
    wizard.source.extent = `${knownPages} page${knownPages === 1 ? "" : "s"}`;
  }

  // Whether what is in the editor parses as XML, reported in its toolbar. On a
  // debounce, so it is not checked per keystroke.
  let wellFormed = $state<boolean | null>(null);
  $effect(() => {
    if (view !== "xml") {
      wellFormed = null;
      return;
    }
    const current = xml;
    const timer = setTimeout(() => {
      const parsed = new DOMParser().parseFromString(current, "application/xml");
      wellFormed = parsed.querySelector("parsererror") === null;
    }, 300);
    return () => clearTimeout(timer);
  });

  // Leaving the step from the XML view: adopt what was written, as switching
  // views would have.
  function leave(go: () => void) {
    if (view === "xml") wizard.source = parseSourceHead(xml);
    go();
  }
</script>

{#snippet material()}
  {#if editing}
    <div class="material-card">
      <div class="material-toolbar">
        <span class="toolbar-name head-name">meiHead — source header</span>
        {#if wellFormed !== null}
          <span class="chip" class:chip-err={!wellFormed}>
            <span class="chip-dot"></span>
            {wellFormed ? "Well-formed" : "Not well-formed"}
          </span>
        {/if}
        <div class="toolbar-gap"></div>
        <button type="button" class="tbtn" class:on={wrap} onclick={() => (wrap = !wrap)}>
          Wrap lines
        </button>
        {#if wizard.images.length}
          <button type="button" class="tbtn" onclick={() => (showPages = true)}>
            Show the pages
          </button>
        {/if}
      </div>
      <XmlEditor bind:value={xml} {wrap} fill />
    </div>
  {:else if view === "xml"}
    <div class="pages-over-editor">
      <FacsimilePages pages={wizard.images} />
      <button type="button" class="tbtn back-to-editor" onclick={() => (showPages = false)}>
        Show the editor
      </button>
    </div>
  {:else}
    <FacsimilePages pages={wizard.images} />
  {/if}
{/snippet}

<WizardCard
  step="source"
  heading="Describe the source"
  intro="What the pages were taken from. Every piece inherits this, and can add its own details next."
  status={view === "xml" ? "editing the XML" : "describing the source"}
  material={wizard.images.length || view === "xml" ? material : undefined}
  onBack={() => leave(previousStep)}
  onNext={() => leave(nextStep)}
>
  <MetadataForm bind:meta={wizard.source} bind:view bind:xml externalEditor />
</WizardCard>

<style>
  .head-name {
    color: var(--ink);
  }
  /* The pages shown from inside the XML view, with the way back floating over
     them. */
  .pages-over-editor {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .back-to-editor {
    position: absolute;
    right: 16px;
    bottom: 16px;
    box-shadow: var(--shadow-md);
  }
</style>
