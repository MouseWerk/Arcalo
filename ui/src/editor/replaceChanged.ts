// Content from elsewhere (another pane, a reload) goes into an open editor as a change of
// only the part that differs, so the caret stays where the user is typing.

import type { Editor } from "@tiptap/core";

/**
 * Replaces the document by the one of the Markdown `body`, but only the part that differs:
 * the caret and the selection move with the text around them (and undo keeps working on the
 * own edits).
 */
export function replaceChanged(editor: Editor, body: string) {
  try {
    const manager = (editor as unknown as { markdown: { parse: (md: string) => { content?: unknown[] } } }).markdown;
    const json = manager.parse(body);
    const next = editor.schema.nodeFromJSON({ type: "doc", content: json.content?.length ? json.content : [{ type: "paragraph" }] });
    next.check();
    const cur = editor.state.doc;
    const start = cur.content.findDiffStart(next.content);
    if (start == null) return;
    let { a: endA, b: endB } = cur.content.findDiffEnd(next.content) ?? { a: cur.content.size, b: next.content.size };
    // Repeated text around the change: both ends must not cross the start.
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    const tr = editor.state.tr.replace(start, endA, next.slice(start, endB));
    tr.setMeta("addToHistory", false).setMeta("preventUpdate", true);
    editor.view.dispatch(tr);
  } catch {
    const { from, to } = editor.state.selection;
    editor.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
  }
}
