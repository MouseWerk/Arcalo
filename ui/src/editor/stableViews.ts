// Node views that stay as they were created.
//
// Tiptap's React binding gives the editor its node views again when the editor's content mounts
// (for React node views, which render through its portals; this app has none) and takes them all
// away when it unmounts. Each time ProseMirror draws the whole note anew: in a 200 KB note about
// 300 ms when it opens and as much again when its tab closes or it switches to the source view,
// right before the editor is destroyed anyway. The views given when the editor view is created
// stay; later replacements of them are ignored.

import { Extension } from "@tiptap/core";
import type { DirectEditorProps, EditorView } from "@tiptap/pm/view";

/** Makes `view` ignore new node and mark views (other props still change). */
export function keepNodeViews(view: EditorView) {
  const setProps = view.setProps.bind(view);
  view.setProps = (props: Partial<DirectEditorProps>) => {
    if (!("nodeViews" in props) && !("markViews" in props)) return setProps(props);
    const rest = { ...props };
    delete rest.nodeViews;
    delete rest.markViews;
    if (Object.keys(rest).length) setProps(rest);
  };
}

export const StableNodeViews = Extension.create({
  name: "stableNodeViews",
  onBeforeCreate() {
    this.editor.on("mount", ({ editor }) => keepNodeViews(editor.view));
  },
});
