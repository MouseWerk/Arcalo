import { describe, expect, it } from "vitest";
import {
  START,
  captureMarkdown,
  current,
  dueOf,
  durationToken,
  navigate,
  pageHtml,
  progress,
  syncDue,
  syncState,
  taskSections,
  treeRows,
  weekEntries,
  zeitLine,
} from "./model";
import type { PageNode, Task, TimeEntryRow } from "../lib/types";

describe("navigation", () => {
  it("opens screens above the tab, once each, and closes them with back or a tab", () => {
    let r = navigate(START, { type: "tab", tab: "tasks" });
    expect(current(r)).toBe("tasks");
    r = navigate(r, { type: "push", screen: { kind: "page", id: 4 } });
    r = navigate(r, { type: "push", screen: { kind: "page", id: 4 } });
    expect(r.stack).toHaveLength(1);
    r = navigate(r, { type: "push", screen: { kind: "page", id: 9 } });
    expect(current(r)).toEqual({ kind: "page", id: 9 });
    r = navigate(r, { type: "pop" });
    expect(current(r)).toEqual({ kind: "page", id: 4 });
    r = navigate(r, { type: "tab", tab: "time" });
    expect(r).toEqual({ tab: "time", stack: [] });
    expect(navigate(r, { type: "pop" })).toBe(r);
  });

  it("replaces a capture by another kind instead of stacking it", () => {
    let r = navigate(START, { type: "push", screen: { kind: "capture", mode: "note" } });
    r = navigate(r, { type: "push", screen: { kind: "capture", mode: "task" } });
    expect(r.stack).toEqual([{ kind: "capture", mode: "task" }]);
  });
});

describe("capture", () => {
  const now = new Date(2026, 9, 8, 10, 0); // Thursday

  it("stores a note as written and tasks as checkboxes with their due date", () => {
    expect(captureMarkdown("note", "  Idee für den Workshop\n", null)).toBe("Idee für den Workshop");
    expect(captureMarkdown("note", "   ", null)).toBe("");
    expect(captureMarkdown("task", "Angebot senden\n\nRechnung prüfen", "2026-10-09")).toBe(
      "- [ ] Angebot senden due:2026-10-09\n- [ ] Rechnung prüfen due:2026-10-09",
    );
    // A task line stays one; a date written in the text wins.
    expect(captureMarkdown("task", "- [ ] Bericht due:2026-10-20", "2026-10-09")).toBe("- [ ] Bericht due:2026-10-20");
    expect(captureMarkdown("task", "todo Anruf", null)).toBe("- [ ] Anruf");
  });

  it("turns the quick due choices into dates", () => {
    expect(dueOf("none", now)).toBeNull();
    expect(dueOf("today", now)).toBe("2026-10-08");
    expect(dueOf("tomorrow", now)).toBe("2026-10-09");
    expect(dueOf("nextWeek", now)).toBe("2026-10-12");
  });
});

describe("booking line", () => {
  it("writes the desktop's /zeit syntax", () => {
    const d = { reference: "NP-8801/1020", duration: "1,5", la: "dev", text: "Abstimmung", date: "2026-10-08" };
    expect(zeitLine(d, "2026-10-08")).toBe("/zeit NP-8801/1020 1h30m #DEV Abstimmung");
    expect(zeitLine({ ...d, duration: "90m", la: "", text: "" }, "2026-10-08")).toBe("/zeit NP-8801/1020 1h30m");
    expect(zeitLine({ ...d, duration: "2h", date: "2026-10-07" }, "2026-10-08")).toBe("/zeit NP-8801/1020 2h #DEV Abstimmung @2026-10-07");
    // Words the parser reads as options are quoted.
    expect(zeitLine({ ...d, text: "Review #42 @Kunde" }, "2026-10-08")).toBe('/zeit NP-8801/1020 1h30m #DEV "Review #42 @Kunde"');
  });

  it("needs a reference and a valid duration", () => {
    const d = { reference: "NP-8801", duration: "45", la: "", text: "", date: "" };
    expect(zeitLine({ ...d, reference: " " })).toBeNull();
    expect(zeitLine({ ...d, duration: "" })).toBeNull();
    expect(zeitLine({ ...d, duration: "zwei" })).toBeNull();
    expect(zeitLine({ ...d, duration: "0:45" })).toBe("/zeit NP-8801 45m");
    expect(durationToken(120)).toBe("2h");
    expect(durationToken(5)).toBe("5m");
  });

  it("shows the share of the day's target", () => {
    expect(progress(240, 480)).toBe(0.5);
    expect(progress(600, 480)).toBe(1);
    expect(progress(0, 0)).toBe(0);
    expect(progress(30, 0)).toBe(1);
  });

  const row = (id: number, start: string, minutes: number, status: TimeEntryRow["status_flag"] = "draft"): TimeEntryRow => ({
    id,
    netzplan_id: 1,
    vorgang_nr: "1020",
    leistungsart: null,
    start_time: new Date(start).toISOString(),
    end_time: null,
    duration_minutes: minutes,
    description: "",
    status_flag: status,
    source: "slash",
    project_code: "P",
    netzplan_nr: "NP-8801",
    wbs_element: "",
  });

  it("lists this week's bookings per day, newest first, without the running timer", () => {
    const now = new Date(2026, 9, 8, 18, 0);
    const days = weekEntries(
      [row(1, "2026-10-05T09:00", 60), row(2, "2026-10-08T08:00", 30), row(3, "2026-10-08T13:00", 90), row(4, "2026-10-08T15:00", 0, "running"), row(5, "2026-10-02T09:00", 60)],
      now,
    );
    expect(days.map((d) => [d.day, d.minutes, d.rows.map((r) => r.id)])).toEqual([
      ["2026-10-08", 120, [3, 2]],
      ["2026-10-05", 60, [1]],
    ]);
  });
});

describe("tasks", () => {
  const task = (text: string, due: string | null, priority = 0): Task => ({ page_id: 1, page_title: "Seite", page_icon: null, ordinal: 0, line: 0, text, done: false, due, priority, tags: [] });
  const now = new Date(2026, 9, 8, 10, 0);

  it("groups open tasks by due date like the desktop", () => {
    const s = taskSections([task("später", "2026-11-30"), task("alt", "2026-10-01"), task("heute", "2026-10-08"), task("ohne", null), task("wichtig", "2026-10-01", 2)], "open", now);
    expect(s.map((x) => [x.group, x.tasks.map((t) => t.text)])).toEqual([
      ["overdue", ["wichtig", "alt"]],
      ["today", ["heute"]],
      ["later", ["später"]],
      ["none", ["ohne"]],
    ]);
    expect(taskSections([task("später", "2026-11-30"), task("heute", "2026-10-08")], "due", now).map((x) => x.group)).toEqual(["today"]);
  });
});

describe("notes", () => {
  const node = (id: number, children: PageNode[] = [], deleted = false): PageNode => ({
    id,
    parent_id: null,
    title: `Seite ${id}`,
    icon: null,
    position: 0,
    updated_at: "",
    favorite: false,
    daily_date: null,
    deleted_at: deleted ? "x" : null,
    children,
  });

  it("shows the children of open pages", () => {
    const tree = [node(1, [node(2, [node(3)]), node(4, [], true)]), node(5)];
    expect(treeRows(tree, new Set()).map((r) => [r.node.id, r.depth, r.hasChildren])).toEqual([
      [1, 0, true],
      [5, 0, false],
    ]);
    expect(treeRows(tree, new Set([1, 2])).map((r) => r.node.id)).toEqual([1, 2, 3, 5]);
  });

  it("renders a page with chips and embeds as labels", () => {
    const html = pageHtml('# Tag\n\nGebucht <time-entry id="3" hours="1,50" target="NP-8801/1020" la="DEV">Review</time-entry>\n\n![[Skizze.excalidraw]]\n\n[[Projekt]]');
    expect(html).toContain('<span class="m-chip">1,50 h · NP-8801/1020 · Review</span>');
    expect(html).toContain('class="m-embed"');
    expect(html).toContain("Skizze.excalidraw");
    expect(html).toContain('data-target="Projekt"');
    expect(pageHtml("---\nstatus: offen\n---\nText")).not.toContain("status");
  });
});

describe("sync", () => {
  it("tells off, never, ok and failed apart", () => {
    expect(syncState(false, "https://x", null)).toBe("off");
    expect(syncState(true, "", null)).toBe("off");
    expect(syncState(true, "https://x", null)).toBe("never");
    const status = { enabled: true, repo_path: "", last_at: "2026-10-08T10:00:00Z", last_commit: "abc", last_branch: "main", last_error: null, pending_changes: 0, token_set: true };
    expect(syncState(true, "https://x", status)).toBe("ok");
    expect(syncState(true, "https://x", { ...status, last_error: "nope" })).toBe("error");
  });

  it("syncs again in front after two minutes at the earliest", () => {
    expect(syncDue(null, 1000)).toBe(true);
    expect(syncDue(0, 60_000)).toBe(false);
    expect(syncDue(0, 120_000)).toBe(true);
  });
});
