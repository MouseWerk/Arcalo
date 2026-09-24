// Decorations carried over edits must equal those built from scratch.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { EditorState, TextSelection, type Plugin } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";
import { buildExtensions } from "./schema";
import { changedRanges } from "./incremental";

const NOTE = [
  "# Titel mit #tag",
  "Absatz mit #projekt und due:2026-09-30 und `#kein` Tag.",
  "> [!note] Hinweis\n> Text mit #innen",
  "> [!warning]- Eingeklappt\n> versteckt",
  "> Normales Zitat",
  "- Liste #eins\n- [ ] Aufgabe due:2026-10-01\n  - tiefer #zwei",
  "```\n#kein-tag im Code\n```",
  "Fußnote[^1] und[^2] im Text.",
  "[^1]: Erste #fn\n[^2]: Zweite",
  "| A | B |\n| --- | --- |\n| #zelle | 2 |",
].join("\n\n");

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** Comparable form of a set of decorations. */
function norm(set: DecorationSet | undefined) {
  return (set?.find() ?? [])
    .map((d: Decoration) => {
      const x = d as unknown as { type: { attrs?: Record<string, string>; spec?: { key?: string } } };
      return `${d.from}-${d.to}:${JSON.stringify(x.type.attrs ?? null)}:${x.type.spec?.key ?? ""}`;
    })
    .sort();
}

const KEYS = ["tagHighlight$", "callouts$", "footnotes$"];

function check(editor: Editor) {
  const state = editor.state;
  const fresh = EditorState.create({ doc: state.doc, plugins: state.plugins });
  for (const k of KEYS) {
    const plugin = state.plugins.find((p: Plugin) => (p as unknown as { key: string }).key.startsWith(k.slice(0, -1)));
    if (!plugin) continue;
    expect(norm(plugin.getState(state) as DecorationSet), k).toEqual(norm(plugin.getState(fresh) as DecorationSet));
  }
}

describe("incremental decorations", () => {
  it("equal a full rebuild after random edits", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: NOTE, contentType: "markdown" });
    expect(editor.state.plugins.some((p) => (p as unknown as { key: string }).key.startsWith("footnote"))).toBe(true);
    check(editor);
    const rand = rng(99);
    const texts = ["#neu", " ", "x", "[!tip] ", "due:2026-01-02", "#a/b-c", "\n", "[^1]"];
    let ops = 0;
    for (let n = 0; n < 300; n++) {
      const size = editor.state.doc.content.size;
      const pos = 1 + Math.floor(rand() * (size - 1));
      const $pos = editor.state.doc.resolve(pos);
      const op = Math.floor(rand() * 8);
      try {
        if (!$pos.parent.isTextblock) continue;
        if (op < 3) editor.chain().setTextSelection(pos).insertContent(texts[Math.floor(rand() * texts.length)]).run();
        else if (op === 3) editor.chain().setTextSelection({ from: pos, to: Math.min($pos.end(), pos + 1 + Math.floor(rand() * 6)) }).deleteSelection().run();
        else if (op === 4) editor.chain().setTextSelection({ from: pos, to: Math.min($pos.end(), pos + 5) }).toggleCode().run();
        else if (op === 5) editor.chain().setTextSelection(pos).splitBlock().run();
        else if (op === 6) editor.chain().setTextSelection(pos).toggleBlockquote().run();
        else editor.chain().setTextSelection(pos).insertContent({ type: "footnoteRef", attrs: { label: String(1 + Math.floor(rand() * 3)) } }).run();
      } catch {
        continue;
      }
      ops++;
      check(editor);
    }
    expect(ops).toBeGreaterThan(150);
    // Undo everything back.
    for (let n = 0; n < 50; n++) {
      editor.commands.undo();
      check(editor);
    }
    editor.destroy();
  });

  it("reports mark changes as changed ranges", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: "a #tag b", contentType: "markdown" });
    const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3, 7));
    tr.addMark(3, 7, editor.schema.marks.code.create());
    expect(changedRanges(tr)).toEqual([{ from: 3, to: 7 }]);
    editor.destroy();
  });
});
