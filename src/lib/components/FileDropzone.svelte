<!--
  Drag-and-drop / picker for the files a campaign is built from: page images,
  PDFs, and existing encodings. Unsupported files are rejected with a note
  rather than silently dropped. The list is additive, so several drops (or a
  drop plus a pick) build one sequence, in the order the pages should read.
-->
<script lang="ts">
  import { classifyUpload } from "$lib/prepare-images.ts";

  let { files = $bindable() }: { files: File[] } = $props();

  let dragActive = $state(false);
  let note = $state<string | null>(null);

  const ACCEPT =
    "image/png,image/jpeg,application/pdf,.mei,.musicxml,.xml,.mxl";

  function add(incoming: File[]) {
    const accepted = incoming.filter((f) => classifyUpload(f) !== null);
    const rejected = incoming.length - accepted.length;
    // A repeated drop of the same file is a slip, not a second page.
    const fresh = accepted.filter(
      (f) => !files.some((e) => e.name === f.name && e.size === f.size),
    );
    files = [...files, ...fresh];
    const skippedDuplicates = accepted.length - fresh.length;
    note =
      rejected || skippedDuplicates
        ? [
            rejected && `${rejected} file(s) skipped — unsupported type.`,
            skippedDuplicates && `${skippedDuplicates} already added.`,
          ]
            .filter(Boolean)
            .join(" ")
        : null;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragActive = false;
    add(Array.from(e.dataTransfer?.files ?? []));
  }

  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    add(Array.from(input.files ?? []));
    // Clear the input so picking the same file again still fires a change.
    input.value = "";
  }

  function remove(index: number) {
    files = files.filter((_, i) => i !== index);
  }
</script>

<div
  class="dropzone"
  class:drag={dragActive}
  role="group"
  aria-label="File upload"
  ondragover={(e) => {
    e.preventDefault();
    dragActive = true;
  }}
  ondragleave={() => (dragActive = false)}
  ondrop={onDrop}
>
  <p class="prompt">Drag page images, a PDF or an encoding here</p>
  <label class="btn picker">
    <input type="file" accept={ACCEPT} multiple onchange={onPick} />
    Choose files…
  </label>
  <p class="types">JPG, PNG, PDF, MEI, MusicXML or MXL</p>
</div>

{#if note}
  <p class="note">{note}</p>
{/if}

{#if files.length}
  <ol class="files">
    {#each files as file, i (`${file.name}:${file.size}`)}
      <li>
        <span class="name">{file.name}</span>
        <button
          type="button"
          class="btn btn-quiet btn-danger"
          onclick={() => remove(i)}
          aria-label="Remove {file.name}"
        >
          Remove
        </button>
      </li>
    {/each}
  </ol>
{/if}

<style>
  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    padding: 1.75rem 1rem;
    text-align: center;
    border: 1px dashed var(--line);
    border-radius: var(--radius);
    background: var(--bg-alt);
  }
  .dropzone.drag {
    border-color: var(--accent);
    background: var(--bg-tint);
  }
  .prompt {
    margin: 0;
    color: var(--ink-soft);
  }
  .types {
    margin: 0;
    font-size: 0.8rem;
    color: var(--ink-faint);
  }
  .picker {
    font-weight: 600;
    font-size: 0.9rem;
    padding: 0.45rem 1rem;
    background: var(--card);
    border-radius: 999px;
  }
  .picker:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .picker input {
    display: none;
  }
  .note {
    margin: 0.6rem 0 0;
    font-size: 0.85rem;
    color: var(--warn);
  }
  .files {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.4rem;
    counter-reset: page;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.7rem;
    font-size: 0.9rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg);
  }
  .files li::before {
    counter-increment: page;
    content: counter(page);
    flex: none;
    min-width: 1.4rem;
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  .name {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .files button {
    flex: none;
    padding: 0.2rem 0.6rem;
  }
</style>
