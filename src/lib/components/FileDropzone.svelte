<!--
  Drag-and-drop / picker for the files a campaign is built from: page images,
  PDFs, and existing encodings. Fills the material pane: a full-height drop
  target with the queued files listed under it. Unsupported files are rejected
  with a note rather than silently dropped. The list is additive, so several
  drops (or a drop plus a pick) build one sequence, in the order the pages
  should read.
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

  /** The file-type label on a row's chip, from the file's extension. */
  const kindOf = (name: string) =>
    (name.match(/\.([^.]+)$/)?.[1] ?? "file").toUpperCase().slice(0, 4);

  const sizeOf = (bytes: number) =>
    bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
</script>

<div
  class="upload"
  role="group"
  aria-label="File upload"
  ondragover={(e) => {
    e.preventDefault();
    dragActive = true;
  }}
  ondragleave={() => (dragActive = false)}
  ondrop={onDrop}
>
  {#each files as file, i (`${file.name}:${file.size}`)}
    <div class="file-row">
      <div class="kind">{kindOf(file.name)}</div>
      <div class="file-text">
        <div class="name">{file.name}</div>
        <div class="meta">{sizeOf(file.size)} · read on Continue</div>
      </div>
      <button
        type="button"
        class="remove"
        onclick={() => remove(i)}
        aria-label="Remove {file.name}"
      >
        ×
      </button>
    </div>
  {/each}

  {#if note}
    <p class="note">{note}</p>
  {/if}

  <div class="dropzone" class:drag={dragActive}>
    <div class="zone-inner">
      <div class="arrow" aria-hidden="true">⤓</div>
      <div class="prompt">Drop page images, PDFs or MEI encodings here</div>
      <div class="types">You can combine them — or continue without any.</div>
      <label class="picker">
        <input type="file" accept={ACCEPT} multiple onchange={onPick} />
        Browse files
      </label>
    </div>
  </div>
</div>

<style>
  .upload {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
  }
  .dropzone {
    flex: 1;
    min-height: 260px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px dashed var(--accent-line-strong);
    border-radius: 14px;
    background: color-mix(in srgb, var(--bg-tint) 55%, transparent);
  }
  .dropzone.drag {
    border-color: var(--accent);
    background: var(--bg-tint);
  }
  .zone-inner {
    text-align: center;
    max-width: 420px;
    padding: 24px;
  }
  .arrow {
    font-size: 36px;
    color: var(--accent);
  }
  .prompt {
    font-size: 15px;
    font-weight: 600;
    margin-top: 10px;
  }
  .types {
    font-size: 12.5px;
    color: var(--ink-faint);
    margin-top: 6px;
  }
  .picker {
    display: inline-block;
    cursor: pointer;
    margin-top: 14px;
    font: 600 13px var(--font);
    padding: 8px 20px;
    color: var(--accent);
    background: var(--card);
    border: 1px solid var(--accent-line);
    border-radius: 999px;
  }
  .picker:hover {
    background: var(--bg-tint);
  }
  .picker input {
    display: none;
  }
  .note {
    flex: none;
    margin: 0;
    font-size: 12px;
    color: var(--warn);
  }
  .file-row {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 12px 16px;
  }
  .kind {
    flex: none;
    width: 34px;
    height: 42px;
    box-sizing: border-box;
    background: var(--card);
    border: 1px solid var(--accent-line);
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font: 600 9px var(--font);
    color: var(--accent);
  }
  .file-text {
    min-width: 0;
  }
  .name {
    font: 12.5px ui-monospace, Menlo, monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    font-size: 11.5px;
    color: var(--ink-faint);
    margin-top: 2px;
  }
  .remove {
    flex: none;
    margin-left: auto;
    cursor: pointer;
    width: 28px;
    height: 28px;
    font-size: 14px;
    color: var(--ink-faint);
    background: none;
    border: 1px solid var(--line);
    border-radius: 999px;
  }
  .remove:hover {
    color: var(--danger);
    border-color: var(--danger);
  }
</style>
