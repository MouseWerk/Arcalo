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
import { TYPE_SVG, typeOf } from "../lib/issueTypes";

export const issueChipsKey = new PluginKey("issueChips");

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
