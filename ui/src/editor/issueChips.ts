// Issue keys in notes: `PROJ-123` of a project with synced issues becomes a live chip (type
// icon, key, status dot and title) by decorations only; the Markdown keeps the plain key, so
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

// One pill out of three decorations: the head widget (type icon), the key's own text and the tail
// widget (status dot and title). A word joiner at the seams keeps the line from breaking between
// them, so the pill moves to the next line as a whole. Nothing in it is an atomic box (an image or
// inline-block is a break opportunity): the icon and the dot are backgrounds of empty inline boxes
// and the title is cut to a length here instead of by CSS. The head is drawn
// after a caret at the key's start and the tail before a caret at its end, so the caret sits
// outside the pill.
const WJ = "\u2060";
const TITLE_MAX = 36;
/** Type colors of the icon, mid tones that read on light and dark backgrounds alike. */
const TYPE_COLOR: Record<ReturnType<typeof typeOf>, string> = { bug: "#e5484d", story: "#2f9e5b", epic: "#8b5cf6", task: "#2f8fd8", subtask: "#2f8fd8", other: "#8a8f98" };

/** The title as the chip shows it: cut at a word near TITLE_MAX characters, with an ellipsis. */
export function chipTitle(summary: string): string {
  const chars = [...summary.trim()];
  if (chars.length <= TITLE_MAX) return chars.join("");
  const cut = chars.slice(0, TITLE_MAX - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–]+$/, "")}…`;
}

export function chipHead(key: string, issue: ChipIssue) {
  const el = document.createElement("span");
  const kind = typeOf(issue.issue_type);
  el.className = `issue-chip-head issue-type-${kind}`;
  el.dataset.issue = key;
  el.contentEditable = "false";
  // As an image the SVG needs its namespace.
  const icon = TYPE_SVG[kind].replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" `).replaceAll("currentColor", TYPE_COLOR[kind]);
  el.style.setProperty("--issue-icon", `url("data:image/svg+xml,${encodeURIComponent(icon)}")`);
  el.textContent = WJ;
  return el;
}

export function chipTail(key: string, issue: ChipIssue) {
  const el = document.createElement("span");
  el.className = "issue-chip-tail";
  el.dataset.issue = key;
  el.contentEditable = "false";
  const dot = document.createElement("span");
  dot.className = `issue-chip-dot cat-${issue.status_category}`;
  dot.setAttribute("aria-label", issue.status);
  const title = document.createElement("span");
  title.className = "issue-chip-title";
  title.textContent = chipTitle(issue.summary);
  el.append(WJ, dot, title);
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
      if (issue) decos.push(Decoration.widget(pos + k.from, () => chipHead(k.key, issue), { side: 1, key: `h:${sig}`, ignoreSelection: true }));
      decos.push(Decoration.inline(pos + k.from, pos + k.to, { class: `issue-chip ${issue ? `cat-${issue.status_category}` : "unknown"}`, "data-issue": k.key, nodeName: "span" }));
      if (issue) decos.push(Decoration.widget(pos + k.to, () => chipTail(k.key, issue), { side: -1, key: `t:${sig}`, ignoreSelection: true }));
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
