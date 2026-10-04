// A selection made right after the editor gets the focus must survive.
//
// ProseMirror re-applies its own selection 20 ms after a focus whenever the DOM selection differs
// from the last one it has read. WebKit (Linux, macOS) reports a new DOM selection with a late
// `selectionchange` event; with a busy main thread (a note that just opened and still renders)
// that event comes after those 20 ms, so the text the user had just selected collapsed to the old
// cursor (Ctrl+J then opened the assistant instead of the inline AI bar). Here the DOM selection
// is read first, at the same moment, so ProseMirror finds nothing to restore.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** ProseMirror's delay before it restores the selection after a focus (prosemirror-view `handlers.focus`). */
export const FOCUS_RESTORE_MS = 20;

/** Takes a DOM selection the view has not read yet into the editor state. */
export function readDomSelection(view: EditorView) {
  if (view.isDestroyed) return;
  // The view's DOM observer reads a changed selection like on `selectionchange` (no-op otherwise).
  (view as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
}

export const FocusSelection = Extension.create({
  name: "focusSelection",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("focusSelection"),
        props: {
          handleDOMEvents: {
            // Runs before ProseMirror's own focus handler: this timer fires before its restore.
            focus: (view) => {
              window.setTimeout(() => readDomSelection(view), FOCUS_RESTORE_MS);
              return false;
            },
          },
        },
      }),
    ];
  },
});
