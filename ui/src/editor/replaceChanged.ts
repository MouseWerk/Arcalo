// Content from elsewhere (another pane, a reload, the page's source view) goes into an open editor
// as a change of only the parts that differ, so the caret stays where the user is typing.

import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { rememberSource } from "./sourceStyle";

/** The blocks without their source attributes (`src`, `gap`), which say nothing about the content. */
const withoutSource = (doc: PMNode) => {
  const blocks: PMNode[] = [];
  doc.forEach((n) => blocks.push(n.attrs.src != null || n.attrs.gap != null ? n.type.create({ ...n.attrs, src: null, gap: null }, n.content, n.marks) : n));
  return blocks;
};

/** Above this many changed blocks the blocks between the first and the last change are replaced as one. */
const MAX_EDITS = 400;

/**
 * The changed runs of blocks, `[fromA, toA, fromB, toB]` in block indexes, first to last (a Myers diff
 * of the top-level blocks). Edits at several places of a long note stay apart, so a caret between them
 * keeps its place. `null` when there are more than `MAX_EDITS` changes.
 */
export function blockHunks(a: PMNode[], b: PMNode[]): [number, number, number, number][] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x].eq(b[y])) (x++, y++);
      next[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    v = next;
  }
  if (found < 0) return null;
  // Back through the trace: the single steps, last first, joined into runs.
  const hunks: [number, number, number, number][] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = pv[off + pk];
    const py = px - pk;
    // The blocks after the step up to (x, y) are equal; the step inserts b[py] or deletes a[px].
    const step: [number, number, number, number] = down ? [px, px, py, py + 1] : [px, px + 1, py, py];
    const last = hunks[hunks.length - 1];
    if (last && last[0] === step[1] && last[2] === step[3]) (last[0] = step[0], (last[2] = step[2]));
    else hunks.push(step);
    x = px;
    y = py;
  }
  return hunks.reverse();
}

/**
 * Replaces the document by the one of the Markdown `body`, but only the parts that differ:
 * the caret and the selection move with the text around them (and undo keeps working on the
 * own edits). `undoable`: the change is one step of its own in the undo history (edits made in
 * the source view of this editor's page), else it stays out of it (another pane's edits).
 */
export function replaceChanged(editor: Editor, body: string, undoable = false) {
  try {
    const manager = (editor as unknown as { markdown: { parse: (md: string) => { content?: unknown[] } } }).markdown;
    const json = manager.parse(body);
    const next = editor.schema.nodeFromJSON({ type: "doc", content: json.content?.length ? json.content : [{ type: "paragraph" }] });
    next.check();
    // The reloaded blocks are the file's source from now on (sourceStyle.ts).
    rememberSource(editor, next);
    const cur = editor.state.doc;
    const [a, b] = [withoutSource(cur), withoutSource(next)];
    const hunks = blockHunks(a, b) ?? [[0, a.length, 0, b.length]];
    if (!hunks.length) return;
    const at = (list: PMNode[]) => {
      const pos = [0];
      for (const node of list) pos.push(pos[pos.length - 1] + node.nodeSize);
      return pos;
    };
    const [posA, posB] = [at(a), at(b)];
    const tr = editor.state.tr;
    // Last run first: the positions of the runs before it stay as they are.
    for (const [fa, ta, fb, tb] of [...hunks].reverse()) {
      const [x, y] = [Fragment.from(a.slice(fa, ta)), Fragment.from(b.slice(fb, tb))];
      // Within the run, only what differs (the caret in a changed paragraph keeps its place).
      const start = x.findDiffStart(y) ?? Math.min(x.size, y.size);
      let { a: endA, b: endB } = x.findDiffEnd(y) ?? { a: x.size, b: y.size };
      // Repeated text around the change: both ends must not cross the start.
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      tr.replace(posA[fa] + start, posA[fa] + endA, next.slice(posB[fb] + start, posB[fb] + endB));
    }
    if (!tr.docChanged) return;
    tr.setMeta("preventUpdate", true);
    if (!undoable) return editor.view.dispatch(tr.setMeta("addToHistory", false));
    // A step of its own: not joined with the own typing before or after it.
    editor.view.dispatch(closeHistory(tr));
    editor.view.dispatch(closeHistory(editor.state.tr.setMeta("preventUpdate", true)));
  } catch {
    const { from, to } = editor.state.selection;
    editor.commands.setContent(body, { contentType: "markdown", emitUpdate: false });
    rememberSource(editor);
    const max = editor.state.doc.content.size;
    editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
  }
}
