<!--
  Metadata editor with three views over one value: a short form (the fields a
  campaign needs at minimum), a detailed form (the rest of what the source
  header models), and the generated <meiHead> itself.

  The form is the source of truth. Switching to the XML view generates the
  header from the fields; edits there are parsed back into the fields when the
  view is left, and anything the form does not model is preserved (see
  source-metadata.ts). That avoids promising a loss-free round trip for
  arbitrary XML while still letting an expert add markup the form lacks.

  With `externalEditor`, the XML view does not render an editor here: the
  parent binds `view` and `xml` and shows the editor in the material pane,
  while this component keeps a live read-back of what the form understands.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    buildSourceHead,
    parseSourceHead,
    type SourceMetadata,
  } from "$lib/source-metadata.ts";
  import XmlEditor from "./XmlEditor.svelte";

  type View = "short" | "long" | "xml";

  let {
    meta = $bindable(),
    view = $bindable("short"),
    xml = $bindable(""),
    externalEditor = false,
    heading,
    subhead,
    variant = "source",
  }: {
    meta: SourceMetadata;
    view?: View;
    xml?: string;
    /** The parent shows the XML editor elsewhere and binds `view` and `xml`. */
    externalEditor?: boolean;
    /** Rendered on the switcher's row, left of the pills. */
    heading?: Snippet;
    /** Rendered on its own row directly below the switcher's row. */
    subhead?: Snippet;
    /**
     * What the form describes. A piece owns its people and note; publication
     * and physical details describe the source, so its variant leaves them out.
     */
    variant?: "source" | "piece";
  } = $props();

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

  // The read-back panel next to an external editor: what the form understands
  // of the XML as it is written, on a debounce so parsing is not per keystroke.
  let readBack = $state<SourceMetadata | null>(null);
  $effect(() => {
    if (!externalEditor || view !== "xml") {
      readBack = null;
      return;
    }
    const current = xml;
    const timer = setTimeout(() => (readBack = parseSourceHead(current)), 300);
    return () => clearTimeout(timer);
  });

  /** What the parsed header keeps as written: element names and comments. */
  const keptAsWritten = $derived.by(() => {
    const extra = readBack?.extraHeadXml ?? "";
    if (!extra.trim()) return "";
    const comments = (extra.match(/<!--/g) ?? []).length;
    const names = [
      ...new Set([...extra.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<([a-zA-Z][\w:.-]*)/g)].map(
        (m) => m[1],
      )),
    ];
    const parts = [];
    if (names.length) parts.push(names.slice(0, 3).join(", "));
    if (comments) parts.push(`${comments} comment${comments === 1 ? "" : "s"}`);
    return parts.join(" · ");
  });
</script>

<div class="metaform">
<div class="views-row">
  {#if heading}{@render heading()}{/if}
  <div class="views" role="tablist" aria-label="Metadata detail">
    {#each [["short", "Short"], ["long", "Detailed"], ["xml", "XML"]] as const as [id, label] (id)}
      <button
        type="button"
        role="tab"
        aria-selected={view === id}
        class="pill"
        class:pill-sm={heading !== undefined}
        class:on={view === id}
        onclick={() => show(id)}
      >
        {label}
      </button>
    {/each}
  </div>
</div>
{#if subhead}{@render subhead()}{/if}

{#if view === "xml"}
  {#if externalEditor}
    <p class="hint xml-note">
      The editor is using the material pane while you write. Fields the form
      knows are read back when you switch views; markup it doesn't model is
      kept as written.
    </p>
    {#if readBack}
      <div class="read-back">
        <div class="read-back-head">Read from the XML</div>
        <div class="read-back-rows">
          <div class="row"><span class="key">Title</span><span class="val">{readBack.title}</span></div>
          <div class="row"><span class="key">Composer</span><span class="val">{readBack.composer}</span></div>
          <div class="row">
            <span class="key">Publisher</span>
            <span class="val">{[readBack.publisher, readBack.pubPlace].filter(Boolean).join(", ")}</span>
          </div>
          <div class="row"><span class="key">Year</span><span class="val">{readBack.date}</span></div>
          {#if keptAsWritten}
            <div class="row"><span class="key">Kept as written</span><span class="val">{keptAsWritten}</span></div>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <p class="hint xml-note">
      The header generated from the form. Fields the form knows are read back
      when you switch away; other markup inside <code>&lt;meiHead&gt;</code> is
      kept as you wrote it.
    </p>
    <XmlEditor bind:value={xml} />
  {/if}
{:else}
  <div class="fields">
    <label class="field">
      Title
      <input class="input" bind:value={meta.title} placeholder="Title as printed on the source" />
    </label>
    {#if view === "short"}
      <label class="field">
        Composer
        <input class="input" bind:value={meta.composer} placeholder="e.g. L. van Beethoven" />
      </label>
      <label class="field">
        Lyricist
        <input class="input" bind:value={meta.lyricist} placeholder="e.g. J. W. von Goethe" />
      </label>
      <label class="field">
        Editor
        <input class="input" bind:value={meta.editor} placeholder="e.g. C. Czerny" />
      </label>
      {#if variant === "source"}
        <div class="pair">
          <label class="field grow">
            Publisher
            <input class="input" bind:value={meta.publisher} placeholder="e.g. Breitkopf &amp; Härtel" />
          </label>
          <label class="field grow">
            Place of publication
            <input class="input" bind:value={meta.pubPlace} placeholder="e.g. Leipzig" />
          </label>
          <label class="field year">
            Year
            <input class="input" bind:value={meta.date} placeholder="e.g. 1802" />
          </label>
        </div>
      {/if}
    {:else}
      <div class="row">
        <label class="field grow">
          Composer
          <input class="input" bind:value={meta.composer} placeholder="e.g. L. van Beethoven" />
        </label>
        <label class="field grow">
          Lyricist
          <input class="input" bind:value={meta.lyricist} placeholder="e.g. J. W. von Goethe" />
        </label>
        <label class="field grow">
          Editor
          <input class="input" bind:value={meta.editor} placeholder="e.g. C. Czerny" />
        </label>
      </div>
      {#if variant === "source"}
        <div class="row">
          <label class="field grow">
            Publisher
            <input class="input" bind:value={meta.publisher} placeholder="e.g. Breitkopf &amp; Härtel" />
          </label>
          <label class="field grow">
            Place of publication
            <input class="input" bind:value={meta.pubPlace} placeholder="e.g. Leipzig" />
          </label>
          <label class="field year">
            Year
            <input class="input" bind:value={meta.date} placeholder="e.g. 1802" />
          </label>
        </div>
        <div class="row">
          <label class="field grow">
            Edition
            <input class="input" bind:value={meta.edition} placeholder="e.g. 2nd revised edition" />
          </label>
          <label class="field year">
            Year of edition
            <input class="input" bind:value={meta.editionDate} placeholder="e.g. 1854" />
          </label>
          <label class="field grow">
            Extent
            <input class="input" bind:value={meta.extent} placeholder="e.g. 48 pages" />
          </label>
        </div>
        <div class="row">
          <label class="field grow">
            Holding institution
            <input class="input" bind:value={meta.repository} placeholder="e.g. Austrian National Library" />
          </label>
          <label class="field grow">
            Shelfmark
            <input class="input" bind:value={meta.shelfmark} placeholder="e.g. Mus.Hs.16481" />
          </label>
        </div>
      {/if}
      <div class="row">
        <label class="field grow">
          {variant === "piece" ? "Note about the piece" : "Note about the source"}
          <textarea class="input" bind:value={meta.note} rows="3"></textarea>
        </label>
      </div>

      <fieldset>
        <legend>Other contributors</legend>
        {#each meta.contributors as contributor, i (i)}
          <div class="contributor">
            <input class="input" bind:value={contributor.name} placeholder="Name" aria-label="Contributor name" />
            <input class="input" bind:value={contributor.role} placeholder="Role, e.g. editor" aria-label="Contributor role" />
            <button type="button" class="pill pill-sm" onclick={() => removeContributor(i)}>
              Remove
            </button>
          </div>
        {/each}
        <button type="button" class="pill pill-sm" onclick={addContributor}>Add contributor</button>
      </fieldset>
    {/if}
  </div>
{/if}
</div>

<style>
  /* Sizing container for the field rows below: the detailed view pairs fields
     per row once the form is wide enough. */
  .metaform {
    container-type: inline-size;
  }
  .views-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
  }
  .views {
    display: flex;
    gap: 6px;
  }
  /* With a heading on the row, the pills sit to its right edge. */
  .views-row > :global(:first-child:not(.views)) {
    flex: 1;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr;
  }
  .field {
    margin-top: 14px;
  }
  .pair {
    display: flex;
    gap: 12px;
  }
  .pair .grow {
    flex: 1;
    min-width: 0;
  }
  .pair .year {
    flex: none;
    width: 110px;
  }
  /* Detailed-view rows: stacked by default, side by side once the form is wide
     enough for pairs (a work card of roughly 560px and up). */
  .row {
    display: flex;
    flex-direction: column;
  }
  @container (min-width: 500px) {
    .row {
      flex-direction: row;
      gap: 12px;
    }
    .row .grow {
      flex: 1;
      min-width: 0;
    }
    .row .year {
      flex: none;
      width: 110px;
    }
  }
  .xml-note {
    margin: 14px 0 0;
    font-size: 12px;
    line-height: 1.5;
  }
  .read-back {
    margin-top: 16px;
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
  }
  .read-back-head {
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ink-faint);
    background: var(--bg-alt);
    border-bottom: 1px solid var(--line);
  }
  .read-back-rows {
    display: grid;
    font-size: 12.5px;
  }
  .read-back .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
  }
  .read-back .row:not(:last-child) {
    border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent);
  }
  .key {
    color: var(--ink-faint);
    white-space: nowrap;
  }
  .val {
    text-align: right;
    overflow-wrap: anywhere;
  }
  fieldset {
    margin: 14px 0 0;
    padding: 12px 14px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  legend {
    padding: 0 6px;
    font-size: 12px;
    font-weight: 600;
  }
  .contributor {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .contributor input {
    margin-top: 0;
  }
  .contributor button {
    flex: none;
  }
</style>
