// The chip of an issue key: one pill out of head widget, key and tail widget, with the caret
// outside the pill and nothing of the chip but the key in the text.

import { describe, expect, it } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { Schema } from "@tiptap/pm/model";
import type { Decoration } from "@tiptap/pm/view";
import { IssueChips, chipHead, chipTail, chipTitle, issueChipsKey } from "./issueChips";
import { useIssueIndex, type ChipIssue } from "../lib/jira";

const issue: ChipIssue = {
  key: "PROJ-123",
  site: "acme",
  summary: "Login fails on SSO",
  status: "In Progress",
  status_category: "indeterminate",
  issue_type: "Bug",
  priority: "",
  assignee: "",
  due_date: null,
  url: "",
  description: "",
} as ChipIssue;

const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", group: "block" }, text: {} } });

function decos(text: string) {
  useIssueIndex.setState({ projects: new Set(["PROJ"]), byKey: new Map([["PROJ-123", issue]]), version: 1 });
  const plugin = IssueChips.config.addProseMirrorPlugins!.call({} as never)[0];
  const state = EditorState.create({ schema, doc: schema.node("doc", null, [schema.node("paragraph", null, schema.text(text))]), plugins: [plugin] });
  return (issueChipsKey.getState(state)?.find() ?? []) as Decoration[];
}

describe("issue chips", () => {
  it("draws the head after and the tail before a caret at the key's edges", () => {
    const [head, key, tail] = decos("Heute PROJ-123 besprechen").sort((a, b) => a.from - b.from || a.to - b.to);
    expect([head.from, head.to, (head as unknown as { spec: { side: number } }).spec.side]).toEqual([7, 7, 1]);
    expect([key.from, key.to]).toEqual([7, 15]);
    expect([tail.from, (tail as unknown as { spec: { side: number } }).spec.side]).toEqual([15, -1]);
  });

  it("shows a key without a synced issue as the key alone", () => {
    const all = decos("Siehe PROJ-999.");
    expect(all).toHaveLength(1);
    expect((all[0] as unknown as { type: { attrs: { class: string } } }).type.attrs.class).toBe("issue-chip unknown");
  });

  it("joins head, key and tail without a break and keeps the status out of the text", () => {
    const head = chipHead("PROJ-123", issue);
    const tail = chipTail("PROJ-123", issue);
    expect(head.className).toBe("issue-chip-head issue-type-bug");
    expect(head.textContent).toBe("\u2060");
    expect(head.style.getPropertyValue("--issue-icon")).toMatch(/^url\("data:image\/svg\+xml,%3Csvg%20xmlns%3D/);
    expect(tail.textContent).toBe("\u2060Login fails on SSO");
    expect(tail.querySelector(".issue-chip-dot.cat-indeterminate")?.getAttribute("aria-label")).toBe("In Progress");
    expect(tail.contentEditable).toBe("false");
  });

  it("cuts a long title at a word", () => {
    expect(chipTitle("Login fails on SSO")).toBe("Login fails on SSO");
    expect(chipTitle("Export of the audit log breaks for very large tenants")).toBe("Export of the audit log breaks for…");
    expect(chipTitle("A".repeat(50))).toBe(`${"A".repeat(35)}…`);
  });
});
