<!--
  CodeMirror 6 XML editor. The library is ~300 kB, so it is imported on first
  use rather than in the app bundle — the same treatment verovio gets.

  `value` is bindable but deliberately one-way into the editor: pushing every
  keystroke back through the parent would fight the user's cursor. The document
  is replaced only when the incoming value differs from what the editor already
  holds, which happens when the form (not the editor) is the origin of a change.

  Syntax colours are applied as CSS classes and coloured with theme tokens, so
  the highlighting follows the light/dark theme.
-->
<script lang="ts">
  import { onMount } from "svelte";
  import type { EditorView } from "@codemirror/view";
  import type { Compartment } from "@codemirror/state";

  let {
    value = $bindable(),
    readonly = false,
    wrap = true,
    fill = false,
  }: {
    value: string;
    readonly?: boolean;
    /** Whether long lines wrap; reconfigurable while the editor is open. */
    wrap?: boolean;
    /** Take the height of the surface instead of capping at a form height. */
    fill?: boolean;
  } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;
  let wrapCompartment: Compartment | null = null;
  let loadError = $state<string | null>(null);
  // What the editor last reported or received, so an echo of our own change
  // is not written back into the document.
  let known = "";

  onMount(() => {
    let disposed = false;
    (async () => {
      try {
        const [
          { EditorView, keymap, lineNumbers },
          { EditorState, Compartment },
          { xml },
          { defaultKeymap, history, historyKeymap },
          { syntaxHighlighting, HighlightStyle, bracketMatching },
          { tags },
        ] = await Promise.all([
          import("@codemirror/view"),
          import("@codemirror/state"),
          import("@codemirror/lang-xml"),
          import("@codemirror/commands"),
          import("@codemirror/language"),
          import("@lezer/highlight"),
        ]);
        if (disposed || !host) return;
        // Classes rather than colours, so the theme's tokens decide.
        const highlight = HighlightStyle.define([
          { tag: [tags.angleBracket, tags.tagName], class: "tok-tag" },
          { tag: tags.attributeName, class: "tok-attr" },
          { tag: [tags.attributeValue, tags.string], class: "tok-value" },
          { tag: [tags.comment, tags.processingInstruction], class: "tok-comment" },
        ]);
        wrapCompartment = new Compartment();
        known = value;
        view = new EditorView({
          parent: host,
          state: EditorState.create({
            doc: value,
            extensions: [
              lineNumbers(),
              history(),
              bracketMatching(),
              syntaxHighlighting(highlight),
              keymap.of([...defaultKeymap, ...historyKeymap]),
              xml(),
              wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
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

  $effect(() => {
    const wrapping = wrap;
    if (!view || !wrapCompartment) return;
    // The import is already resolved once the view exists.
    void import("@codemirror/view").then(({ EditorView }) => {
      view?.dispatch({
        effects: wrapCompartment!.reconfigure(wrapping ? EditorView.lineWrapping : []),
      });
    });
  });
</script>

{#if loadError}
  <p class="msg-error-inline" role="alert">Could not load the XML editor: {loadError}</p>
{/if}
<div class="editor" class:fill bind:this={host}></div>

<style>
  .editor {
    border: 1px solid var(--line);
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-inset);
  }
  .editor.fill {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border: none;
    border-radius: 0;
  }
  /* CodeMirror renders into this subtree at runtime, so these are :global. */
  .editor :global(.cm-editor) {
    max-height: 22rem;
    font-size: 12.5px;
    line-height: 1.85;
    background: var(--bg-inset);
    color: var(--ink);
  }
  .editor.fill :global(.cm-editor) {
    flex: 1;
    min-height: 0;
    max-height: none;
  }
  .editor :global(.cm-scroller) {
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  .editor :global(.cm-gutters) {
    min-width: 44px;
    justify-content: flex-end;
    padding-right: 6px;
    background: var(--bg-inset);
    color: var(--line-input);
    border-right: none;
  }
  .editor :global(.cm-activeLine),
  .editor :global(.cm-activeLineGutter) {
    background: var(--accent-tint-strong);
  }
  .editor :global(.cm-activeLineGutter) {
    color: var(--ink-faint);
  }
  .editor :global(.cm-editor.cm-focused) {
    outline: none;
  }
  .editor:not(.fill) :global(.cm-editor.cm-focused) {
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
  .editor :global(.tok-tag) {
    color: var(--accent);
  }
  .editor :global(.tok-attr) {
    color: var(--orange-deep);
  }
  .editor :global(.tok-value) {
    color: var(--ok);
  }
  .editor :global(.tok-comment) {
    color: var(--ink-faint);
  }
</style>
