<!--
  Metadata editor with three views over one value: a short form (the fields a
  campaign needs at minimum), a long form (the rest of what the source header
  models), and the generated <meiHead> itself.

  The form is the source of truth. Switching to the XML view generates the
  header from the fields; edits there are parsed back into the fields when the
  view is left, and anything the form does not model is preserved (see
  source-metadata.ts). That avoids promising a loss-free round trip for
  arbitrary XML while still letting an expert add markup the form lacks.
-->
<script lang="ts">
  import {
    buildSourceHead,
    parseSourceHead,
    type SourceMetadata,
  } from "$lib/source-metadata.ts";
  import XmlEditor from "./XmlEditor.svelte";

  let { meta = $bindable() }: { meta: SourceMetadata } = $props();

  type View = "short" | "long" | "xml";
  let view = $state<View>("short");
  let xml = $state("");

  function show(next: View) {
    if (next === view) return;
    if (next === "xml") {
      xml = buildSourceHead(meta);
    } else if (view === "xml") {
      // Leaving the editor: adopt whatever the expert wrote.
      meta = parseSourceHead(xml);
    }
    view = next;
  }

  function addContributor() {
    meta.contributors = [...meta.contributors, { name: "", role: "" }];
  }

  function removeContributor(index: number) {
    meta.contributors = meta.contributors.filter((_, i) => i !== index);
  }
</script>

<div class="views" role="tablist" aria-label="Metadata detail">
  {#each [["short", "Short"], ["long", "Detailed"], ["xml", "XML"]] as const as [id, label] (id)}
    <button
      type="button"
      role="tab"
      aria-selected={view === id}
      class="btn btn-quiet"
      class:on={view === id}
      onclick={() => show(id)}
    >
      {label}
    </button>
  {/each}
</div>

{#if view === "xml"}
  <p class="hint">
    The header generated from the form. Fields the form knows are read back when
    you switch away; other markup inside <code>&lt;meiHead&gt;</code> is kept as
    you wrote it.
  </p>
  <XmlEditor bind:value={xml} />
{:else}
  <div class="fields">
    <label class="field">
      Title
      <input class="input" bind:value={meta.title} placeholder="Title as printed on the source" />
    </label>
    <label class="field">
      Composer
      <input class="input" bind:value={meta.composer} placeholder="e.g. L. van Beethoven" />
    </label>
    <label class="field">
      Publisher
      <input class="input" bind:value={meta.publisher} placeholder="e.g. Breitkopf &amp; Härtel" />
    </label>
    <label class="field">
      Year
      <input class="input" bind:value={meta.date} placeholder="e.g. 1802" />
    </label>

    {#if view === "long"}
      <label class="field">
        Place of publication
        <input class="input" bind:value={meta.pubPlace} placeholder="e.g. Leipzig" />
      </label>
      <label class="field">
        Extent
        <input class="input" bind:value={meta.extent} placeholder="e.g. 48 pages" />
      </label>
      <label class="field">
        Condition
        <input class="input" bind:value={meta.condition} placeholder="e.g. Foxing on the title page" />
      </label>
      <label class="field wide">
        Note about the source
        <textarea class="input" bind:value={meta.note} rows="3"></textarea>
      </label>

      <fieldset>
        <legend>Other contributors</legend>
        {#each meta.contributors as contributor, i (i)}
          <div class="contributor">
            <input class="input" bind:value={contributor.name} placeholder="Name" aria-label="Contributor name" />
            <input class="input" bind:value={contributor.role} placeholder="Role, e.g. editor" aria-label="Contributor role" />
            <button type="button" class="btn btn-quiet btn-danger" onclick={() => removeContributor(i)}>
              Remove
            </button>
          </div>
        {/each}
        <button type="button" class="btn btn-quiet" onclick={addContributor}>Add contributor</button>
      </fieldset>
    {/if}
  </div>
{/if}

<style>
  .views {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 1.25rem;
  }
  .views button {
    padding: 0.35rem 0.9rem;
    border-radius: 999px;
  }
  /* Fields pair up into columns wherever the container is wide enough for two. */
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    column-gap: 1rem;
  }
  .fields > .wide,
  fieldset {
    grid-column: 1 / -1;
  }
  label {
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }
  /* The XML view's note sits above the editor rather than under a field. */
  .hint {
    margin: 0 0 0.6rem;
  }
  fieldset {
    margin: 0 0 1rem;
    padding: 0.9rem 1rem 1rem;
    border: 1px solid var(--line);
    border-radius: 6px;
  }
  legend {
    padding: 0 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
  }
  .contributor {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .contributor input {
    margin-top: 0;
  }
  .contributor button {
    flex: none;
  }
</style>
