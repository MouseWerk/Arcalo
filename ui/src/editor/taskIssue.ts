// „Jira-Issue anlegen“ on a task (slash command or the task's context menu): the dialog
// (components/CreateIssueDialog.tsx) asks for site, project and type; the summary is the task's
// text. Once Jira answers, the new key is appended to the task, where it shows as a chip.

import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useApp } from "../store/app";

export const CREATE_ISSUE_EVENT = "annalo:create-issue";

export interface CreateIssueRequest {
  summary: string;
  pageId: number | null;
  /** Appends the new key to the task. */
  apply: (key: string) => void;
}

/** Whether a Jira site is set up (the action is offered only then). */
export const jiraReady = () => (useApp.getState().settings?.settings.jira?.sites.some((s) => s.enabled) ?? false);

/** The task item around `pos`: its position and node. */
export function taskAt(editor: Editor, pos: number): { pos: number; node: PMNode } | null {
  const $p = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size));
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name === "taskItem") return { pos: $p.before(d), node: n };
  }
  return null;
}

/** The task's own text (its first paragraph, without nested items). */
export const taskText = (node: PMNode) => (node.firstChild?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Asks for a new issue for the task at `pos`; `false` when there is no task there. */
export function requestCreateIssue(editor: Editor, pos: number, pageId: number | null): boolean {
  const task = taskAt(editor, pos);
  if (!task) return false;
  const text = taskText(task.node);
  const apply = (key: string) => {
    if (editor.isDestroyed) return;
    // Find the task again: where it was, else by its text.
    let at: { pos: number; node: PMNode } | null = null;
    const here = editor.state.doc.nodeAt(task.pos);
    if (here?.type.name === "taskItem" && taskText(here) === text) at = { pos: task.pos, node: here };
    else
      editor.state.doc.descendants((n, p) => {
        if (at) return false;
        if (n.type.name === "taskItem" && taskText(n) === text) at = { pos: p, node: n };
        return true;
      });
    if (!at) return;
    const { pos: p, node } = at as { pos: number; node: PMNode };
    const para = node.firstChild;
    if (!para) return;
    const end = p + 1 + para.nodeSize - 1;
    const before = para.textContent;
    editor.chain().insertContentAt(end, { type: "text", text: `${before && !/\s$/.test(before) ? " " : ""}${key}` }).run();
  };
  window.dispatchEvent(new CustomEvent<CreateIssueRequest>(CREATE_ISSUE_EVENT, { detail: { summary: text, pageId, apply } }));
  return true;
}
