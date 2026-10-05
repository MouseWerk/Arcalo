// Repeating tasks in the editor (1.13): ticking off a task with a repeat rule (`every:weekly`)
// adds its next occurrence right after it, below its subtasks, like the task view does. The date
// comes from the core (`task_next_due`), so editor and task view agree on it; the new item joins
// the tick's undo step, so one Ctrl+Z takes both back. The Markdown source view is plain text:
// ticking `[x]` there adds nothing.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AttrStep, ReplaceAroundStep } from "@tiptap/pm/transform";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { EditorView } from "@tiptap/pm/view";

/** A due date in a task (`due:`, `fällig:` or the calendar marker of imported notes). */
const DUE_DATE_RE = /((?:due|fällig):|\u{1F4C5}\s?)(\d{4}-\d{2}-\d{2})/iu;
/** The done date Obsidian Tasks writes; not taken into the next occurrence. */
const DONE_MARK_RE = /\s*\u{2705}\s?\d{4}-\d{2}-\d{2}/gu;
const BLOCK_ID_RE = /\s+\^[A-Za-z0-9-]+\s*$/;
/** Only tasks that may have a rule ask the core. */
const RULE_HINT_RE = /(?:^|\s)(?:every|wdh):|\u{1F501}/iu;

/** Positions of the task items `tr` ticked off (open before, done after): a click on one box. */
export function tickedTasks(tr: Transaction, before: PMNode): number[] {
  if (!tr.docChanged || tr.steps.length !== 1) return [];
  const step = tr.steps[0];
  const pos = step instanceof ReplaceAroundStep ? step.from : step instanceof AttrStep && step.attr === "checked" ? step.pos : null;
  if (pos == null) return [];
  const old = before.nodeAt(pos);
  const now = tr.doc.nodeAt(pos);
  if (old?.type.name !== "taskItem" || now?.type.name !== "taskItem") return [];
  return !old.attrs.checked && now.attrs.checked ? [pos] : [];
}

/** The item's own text (its first paragraph; chips and other atoms as U+FFFC), as the core reads it. */
export const itemText = (item: PMNode) => {
  const p = item.firstChild;
  return p ? p.textBetween(0, p.content.size, " ", "￼") : "";
};

/**
 * The next occurrence of `item`: its first paragraph with the due date `due` (in place of the
 * old one, or added), open and without subtasks. Bookings (`/zeit` chips) stay with the done
 * task; its block id and an Obsidian done date are left out.
 */
export function nextItem(item: PMNode, due: string): PMNode | null {
  const para = item.firstChild;
  if (!para) return null;
  const schema = item.type.schema;
  const nodes: PMNode[] = [];
  let replaced = false;
  para.forEach((child) => {
    if (child.type.name === "timeEntry") return;
    if (child.isText) {
      let text = child.text ?? "";
      if (!replaced && DUE_DATE_RE.test(text)) {
        text = text.replace(DUE_DATE_RE, (_m, prefix: string) => `${prefix}${due}`);
        replaced = true;
      }
      text = text.replace(DONE_MARK_RE, "").replace(/ {2,}/g, " ");
      if (text) nodes.push(schema.text(text, child.marks));
      return;
    }
    nodes.push(child);
  });
  const last = nodes[nodes.length - 1];
  if (last?.isText) {
    const text = (last.text ?? "").replace(BLOCK_ID_RE, "").replace(/\s+$/, "");
    nodes.pop();
    if (text) nodes.push(schema.text(text, last.marks));
  }
  if (!replaced) nodes.push(schema.text(` due:${due}`));
  return item.type.create({ checked: false }, para.type.create(null, Fragment.from(nodes)));
}

/** Inserts the next occurrence after `item` (found again if the document changed meanwhile). */
function insertNext(view: EditorView, pos: number, item: PMNode, due: string, origin: Transaction) {
  if (view.isDestroyed) return;
  const doc = view.state.doc;
  let at = doc.nodeAt(pos) === item ? pos : -1;
  if (at < 0)
    doc.descendants((n, p) => {
      if (at >= 0) return false;
      if (n === item) at = p;
      return at < 0;
    });
  const next = at >= 0 ? nextItem(item, due) : null;
  if (!next) return;
  // Marked as appended to the tick: the history keeps both in one undo step.
  view.dispatch(view.state.tr.insert(at + item.nodeSize, next).setMeta("appendedTransaction", origin));
}

export const RecurringTasks = Extension.create<{ nextDue: ((text: string) => Promise<string | null>) | null }>({
  name: "recurringTasks",
  addOptions() {
    return { nextDue: null };
  },
  addProseMirrorPlugins() {
    const nextDue = this.options.nextDue;
    const editor = this.editor;
    if (!nextDue) return [];
    return [
      new Plugin({
        key: new PluginKey("recurringTasks"),
        appendTransaction: (trs, oldState) => {
          // Reloads, undo/redo and other programmatic changes never create occurrences.
          if (trs.length !== 1 || !editor.isEditable) return null;
          const tr = trs[0];
          if (tr.getMeta("addToHistory") === false || tr.getMeta("preventUpdate") || isHistoryTransaction(tr)) return null;
          for (const pos of tickedTasks(tr, oldState.doc)) {
            const item = tr.doc.nodeAt(pos);
            const text = item ? itemText(item) : "";
            if (!item || !RULE_HINT_RE.test(text)) continue;
            nextDue(text).then(
              (due) => due && insertNext(editor.view, pos, item, due, tr),
              () => {},
            );
          }
          return null;
        },
      }),
    ];
  },
});
