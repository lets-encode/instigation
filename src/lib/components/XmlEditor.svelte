<!--
  CodeMirror 6 XML editor. The library is ~300 kB, so it is imported on first
  use rather than in the app bundle — the same treatment verovio gets.

  `value` is bindable but deliberately one-way into the editor: pushing every
  keystroke back through the parent would fight the user's cursor. The document
  is replaced only when the incoming value differs from what the editor already
  holds, which happens when the form (not the editor) is the origin of a change.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import type { EditorView } from "@codemirror/view";

  let {
    value = $bindable(),
    readonly = false,
  }: { value: string; readonly?: boolean } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;
  let loadError = $state<string | null>(null);
  // What the editor last reported or received, so an echo of our own change
  // is not written back into the document.
  let known = "";

  onMount(() => {
    let disposed = false;
    (async () => {
      try {
        const [{ EditorView, keymap, lineNumbers }, { EditorState }, { xml }, { defaultKeymap, history, historyKeymap }, { syntaxHighlighting, defaultHighlightStyle, bracketMatching }] =
          await Promise.all([
            import("@codemirror/view"),
            import("@codemirror/state"),
            import("@codemirror/lang-xml"),
            import("@codemirror/commands"),
            import("@codemirror/language"),
          ]);
        if (disposed || !host) return;
        known = value;
        view = new EditorView({
          parent: host,
          state: EditorState.create({
            doc: value,
            extensions: [
              lineNumbers(),
              history(),
              bracketMatching(),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              xml(),
              EditorView.lineWrapping,
              EditorState.readOnly.of(readonly),
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                known = update.state.doc.toString();
                value = known;
              }),
            ],
          }),
        });
      } catch (err) {
        loadError = (err as Error).message;
      }
    })();
    return () => {
      disposed = true;
      view?.destroy();
      view = null;
    };
  });

  // Adopt changes that came from the form side.
  $effect(() => {
    const incoming = value;
    if (!view || incoming === known) return;
    known = incoming;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: incoming },
    });
  });
</script>

{#if loadError}
  <p class="msg-error-inline" role="alert">Could not load the XML editor: {loadError}</p>
{/if}
<div class="editor" bind:this={host}></div>

<style>
  .editor {
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg);
  }
  /* CodeMirror renders into this subtree at runtime, so these are :global. */
  .editor :global(.cm-editor) {
    max-height: 22rem;
    font-size: 0.85rem;
    background: var(--bg);
    color: var(--ink);
  }
  .editor :global(.cm-scroller) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .editor :global(.cm-gutters) {
    background: var(--bg-alt);
    color: var(--ink-faint);
    border-right: 1px solid var(--line);
  }
  .editor :global(.cm-activeLine),
  .editor :global(.cm-activeLineGutter) {
    background: var(--bg-tint);
  }
  .editor :global(.cm-editor.cm-focused) {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
  }
  .editor :global(.cm-selectionBackground),
  .editor :global(.cm-editor .cm-selectionBackground) {
    background: var(--bg-tint);
  }
  .editor :global(.cm-cursor) {
    border-left-color: var(--ink);
  }
</style>
