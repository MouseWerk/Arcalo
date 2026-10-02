// Rich code blocks: a ```mermaid block shows its diagram, a ```query block its result, right
// under the code. The code (the Markdown, unchanged) is hidden while the caret is elsewhere and
// shows while it is inside the block; the preview's „Quelltext“ button puts the caret there.
// Previews are widgets keyed by their order, so typing in the source updates them in place.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { richKind, type RichKind } from "./embedSyntax";

/** What a preview gets from the editor. */
export interface RichControl {
  /** Puts the caret into the block's code. */
  edit: () => void;
  /** Leaves the code (the caret goes below the block). */
  done: () => void;
}

/** A mounted preview: told about new source and whether the source is shown. */
export interface RichPreview {
  update: (source: string, editing: boolean) => void;
  destroy: () => void;
}

export interface RichBlocksOptions {
  /** Mounts the preview of a block into `dom`; null (headless) shows the code only. */
  mount: ((kind: RichKind, dom: HTMLElement, source: string, ctl: RichControl) => RichPreview) | null;
}

interface Block {
  kind: RichKind;
  pos: number;
  node: PMNode;
  key: string;
}

/** The rich blocks of a document in order (also inside quotes, columns and lists). */
function richBlocksOf(doc: PMNode): Block[] {
  const out: Block[] = [];
  const counts: Record<RichKind, number> = { mermaid: 0, query: 0 };
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      const kind = node.type.name === "codeBlock" ? richKind(node.attrs.language) : null;
      if (kind) out.push({ kind, pos, node, key: `${kind}-${counts[kind]++}` });
      return false;
    }
    return !node.isAtom;
  });
  return out;
}

const editingOf = (state: EditorState, b: Block) => {
  const { from, to } = state.selection;
  return from > b.pos && to < b.pos + b.node.nodeSize;
};

const key = new PluginKey<DecorationSet>("richBlocks");

export const RichBlocks = Extension.create<RichBlocksOptions>({
  name: "richBlocks",
  addOptions() {
    return { mount: null };
  },
  addProseMirrorPlugins() {
    const mount = this.options.mount;
    if (!mount) return [];
    const previews = new Map<string, RichPreview>();
    let blocks: Block[] = [];

    const control = (view: EditorView, k: string): RichControl => ({
      edit: () => {
        const b = blocks.find((x) => x.key === k);
        if (!b) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, b.pos + 1 + b.node.content.size)).scrollIntoView());
        view.focus();
      },
      done: () => {
        const b = blocks.find((x) => x.key === k);
        if (!b) return;
        const after = b.pos + b.node.nodeSize;
        const doc = view.state.doc;
        // The caret goes into the next text block that is no code (another rich block would open),
        // else the previous one; only a page of nothing but code gets a new paragraph.
        let at = -1;
        doc.nodesBetween(after, doc.content.size, (n, pos) => {
          if (at < 0 && n.isTextblock && n.type.name !== "codeBlock") at = pos + 1;
          return at < 0;
        });
        if (at < 0)
          doc.nodesBetween(0, b.pos, (n, pos) => {
            if (n.isTextblock && n.type.name !== "codeBlock") at = pos + 1 + n.content.size;
          });
        let tr = view.state.tr;
        if (at < 0) {
          tr = tr.insert(after, view.state.schema.nodes.paragraph.create());
          at = after + 1;
        }
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, at)).scrollIntoView());
        view.focus();
      },
    });

    const build = (state: EditorState): DecorationSet => {
      blocks = richBlocksOf(state.doc);
      const decos: Decoration[] = [];
      for (const b of blocks) {
        const editing = editingOf(state, b);
        decos.push(Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: `rich-src rich-src-${b.kind}${editing ? " is-editing" : " is-hidden"}` }));
        decos.push(
          Decoration.widget(
            b.pos + b.node.nodeSize,
            (view) => {
              const dom = document.createElement("div");
              dom.className = `rich-preview rich-${b.kind}`;
              dom.contentEditable = "false";
              const current = blocks.find((x) => x.key === b.key) ?? b;
              const p = mount(b.kind, dom, current.node.textContent, control(view, b.key));
              p.update(current.node.textContent, editingOf(view.state, current));
              previews.set(b.key, p);
              return dom;
            },
            {
              key: `rich-${b.key}`,
              side: -1,
              ignoreSelection: true,
              stopEvent: () => true,
              destroy: () => {
                previews.get(b.key)?.destroy();
                previews.delete(b.key);
              },
            },
          ),
        );
      }
      return DecorationSet.create(state.doc, decos);
    };

    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => build(state),
          apply: (tr, old, prev, state) => {
            if (!tr.docChanged && prev.selection.eq(state.selection)) return old;
            // A selection move that neither enters nor leaves a block keeps the decorations.
            if (!tr.docChanged && blocks.every((b) => editingOf(prev, b) === editingOf(state, b))) return old;
            return build(state);
          },
        },
        props: { decorations: (state) => key.getState(state) },
        view: () => ({
          update: (view, prev) => {
            if (view.state.doc === prev.doc && view.state.selection.eq(prev.selection)) return;
            for (const b of blocks) previews.get(b.key)?.update(b.node.textContent, editingOf(view.state, b));
          },
        }),
      }),
    ];
  },
});
