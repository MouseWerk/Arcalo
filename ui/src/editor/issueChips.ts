// Issue keys in notes: `PROJ-123` of a project with synced issues becomes a live chip (type
// icon, key, status pill and title) by decorations only; the Markdown keeps the plain key, so
// search, backlinks and exports see it as written. A click opens the issue's note,
// Ctrl/Cmd+click the issue in the browser; hovering shows the card of IssuePreview.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { blockDecorations, RELABEL, updateBlockDecorations } from "./incremental";
import { findKeys, useIssueIndex, startIssueIndex, type ChipIssue } from "../lib/jira";
import { openIssue } from "../lib/jiraActions";

export const issueChipsKey = new PluginKey("issueChips");

const svg = (body: string) =>
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** A small glyph per issue type (Jira's own colors in CSS). */
export function typeOf(issueType: string): "bug" | "story" | "epic" | "task" | "subtask" | "other" {
  const t = issueType.toLowerCase();
  if (/bug|fehler|defect/.test(t)) return "bug";
  if (/story|anforderung/.test(t)) return "story";
  if (/epic/.test(t)) return "epic";
  if (/sub|unteraufgabe/.test(t)) return "subtask";
  if (/task|aufgabe/.test(t)) return "task";
  return "other";
}

export const TYPE_SVG: Record<ReturnType<typeof typeOf>, string> = {
  bug: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  story: svg('<path d="M6 3h12v18l-6-4.5L6 21z"/>'),
  epic: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  task: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>'),
  subtask: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 8v5h6"/>'),
  other: svg('<circle cx="12" cy="12" r="8"/>'),
};

function head(key: string, issue: ChipIssue | undefined) {
  const el = document.createElement("span");
  const kind = typeOf(issue?.issue_type ?? "");
  el.className = `issue-chip-head issue-type-${kind}`;
  el.dataset.issue = key;
  el.contentEditable = "false";
  el.innerHTML = TYPE_SVG[kind];
  return el;
}

function tail(key: string, issue: ChipIssue | undefined) {
  const el = document.createElement("span");
  el.className = "issue-chip-tail";
  el.dataset.issue = key;
  el.contentEditable = "false";
  if (issue) {
    const pill = document.createElement("span");
    pill.className = `issue-status cat-${issue.status_category}`;
    pill.textContent = issue.status;
    const title = document.createElement("span");
    title.className = "issue-chip-title";
    title.textContent = issue.summary;
    el.append(pill, title);
  } else {
    const pill = document.createElement("span");
    pill.className = "issue-status cat-unknown";
    pill.textContent = "?";
    el.append(pill);
  }
  return el;
}

/** The chip decorations of one top-level block. */
function build(block: PMNode, at: number): Decoration[] {
  const { projects, byKey } = useIssueIndex.getState();
  if (!projects.size) return [];
  const decos: Decoration[] = [];
  block.descendants((node, offset, parent) => {
    if (!node.isText || parent?.type.spec.code || node.marks.some((m) => m.type.name === "code" || m.type.name === "link")) return;
    const pos = at + 1 + offset;
    for (const k of findKeys(node.text ?? "", projects)) {
      const issue = byKey.get(k.key);
      const sig = `${k.key}|${issue?.status ?? ""}|${issue?.summary ?? ""}|${issue?.issue_type ?? ""}`;
      decos.push(Decoration.widget(pos + k.from, () => head(k.key, issue), { side: -1, key: `h:${sig}`, ignoreSelection: true }));
      decos.push(Decoration.inline(pos + k.from, pos + k.to, { class: `issue-chip ${issue ? `cat-${issue.status_category}` : "unknown"}`, "data-issue": k.key, nodeName: "span" }));
      decos.push(Decoration.widget(pos + k.to, () => tail(k.key, issue), { side: 1, key: `t:${sig}`, ignoreSelection: true }));
    }
  });
  return decos;
}

export const IssueChips = Extension.create({
  name: "issueChips",
  addProseMirrorPlugins() {
    startIssueIndex();
    return [
      new Plugin({
        key: issueChipsKey,
        state: {
          init: (_, { doc }) => blockDecorations(doc, build),
          apply: (tr, old) => (tr.getMeta(issueChipsKey) ? blockDecorations(tr.doc, build) : updateBlockDecorations(old, tr, build)),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest<HTMLElement>("[data-issue]");
            if (!el || !el.closest(".ProseMirror")) return false;
            void openIssue(el.dataset.issue!, { browser: event.ctrlKey || event.metaKey });
            return true;
          },
        },
        view(view) {
          // A sync changed the index: every chip is built again.
          const unsub = useIssueIndex.subscribe((st, prev) => {
            if (st.version !== prev.version && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(issueChipsKey, true).setMeta(RELABEL, true).setMeta("addToHistory", false));
          });
          return { destroy: unsub };
        },
      }),
    ];
  },
});
