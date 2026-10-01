import { describe, expect, it } from "vitest";
import { burndownPaths, columnsOf, emptyIssueQuery, filterIssues, findKeys, groupIssues, isKey, overdue, priorityRank, valuesOf, type Issue } from "./jira";
import { guessKind } from "../views/settings/JiraSection";
import { typeOf } from "../editor/issueChips";
import { quickItems } from "./quicksearch";

const issue = (key: string, p: Partial<Issue> = {}): Issue => ({
  site: "acme",
  key,
  remote_id: "",
  summary: `Summary ${key}`,
  status: "To Do",
  status_category: "new",
  priority: "Medium",
  assignee: "Mia",
  reporter: "",
  issue_type: "Task",
  project_key: key.split("-")[0],
  project_name: "",
  sprint: "",
  sprint_state: "",
  due_date: null,
  updated: null,
  resolved: null,
  url: "",
  description: "",
  comments: [],
  matches: ["mine"],
  ...p,
});

describe("issue keys", () => {
  const projects = new Set(["PROJ", "OPS"]);
  it("finds keys of synced projects only, standing alone", () => {
    expect(findKeys("Fix PROJ-123 and OPS-7, not ISO-9001 or UTF-8.", projects).map((k) => k.key)).toEqual(["PROJ-123", "OPS-7"]);
    expect(findKeys("PROJ-12", projects)).toEqual([{ from: 0, to: 7, key: "PROJ-12" }]);
    for (const text of ["xPROJ-1", "PROJ-1x", "PROJ-0", "proj-1", "/PROJ-1", "https://j/browse/PROJ-1", "PROJ-1-2", "PROJ-1.5", "#PROJ-1"]) expect(findKeys(text, projects), text).toEqual([]);
    expect(findKeys("(PROJ-9) „OPS-1“ PROJ-2.", projects)).toHaveLength(3);
    expect(findKeys("PROJ-1", new Set())).toEqual([]);
    expect(isKey("AB_2-10")).toBe(true);
    expect(isKey("A-1")).toBe(false);
  });
  it("names the icon of a type", () => {
    expect(["Bug", "Story", "Epic", "Sub-task", "Aufgabe", "Idee"].map(typeOf)).toEqual(["bug", "story", "epic", "subtask", "task", "other"]);
  });
  it("guesses Cloud from the address", () => {
    expect(guessKind("acme.atlassian.net")).toBe("cloud");
    expect(guessKind("https://acme.atlassian.net/jira")).toBe("cloud");
    expect(guessKind("https://jira.firma.de")).toBe("server");
  });
});

describe("the Issues page", () => {
  const list = [
    issue("PROJ-1", { status: "In Progress", status_category: "indeterminate", priority: "High", sprint: "Sprint 4", sprint_state: "active" }),
    issue("PROJ-2", { summary: "Login fails", description: "SSO token expired" }),
    issue("OPS-3", { site: "corp", priority: "Lowest", status: "Done", status_category: "done", sprint: "Sprint 3", sprint_state: "closed" }),
    issue("OPS-4", { priority: "" }),
  ];
  it("filters by field and by every word of the text", () => {
    expect(filterIssues(list, { ...emptyIssueQuery(), project: "OPS" }).map((i) => i.key)).toEqual(["OPS-3", "OPS-4"]);
    expect(filterIssues(list, { ...emptyIssueQuery(), text: "sso login" }).map((i) => i.key)).toEqual(["PROJ-2"]);
    expect(filterIssues(list, { ...emptyIssueQuery(), site: "corp", status: "Done" }).map((i) => i.key)).toEqual(["OPS-3"]);
    expect(valuesOf(list, "priority")).toEqual(["High", "Medium", "Lowest"]);
  });
  it("groups in a sensible order", () => {
    const names = { site: (id: string) => id.toUpperCase(), empty: "None" };
    expect(groupIssues(list, "status", names).map((g) => g.label)).toEqual(["In Progress", "To Do", "Done"]);
    expect(groupIssues(list, "priority", names).map((g) => g.label)).toEqual(["High", "Medium", "Lowest", "None"]);
    expect(groupIssues(list, "sprint", names).map((g) => g.label)).toEqual(["Sprint 4", "Sprint 3", "None"]);
    expect(groupIssues(list, "site", names).map((g) => [g.label, g.issues.length])).toEqual([["ACME", 3], ["CORP", 1]]);
    expect(groupIssues(list, "none", names)).toHaveLength(1);
    expect(priorityRank("Blocker")).toBeLessThan(priorityRank("Minor"));
  });
  it("marks open issues past their due date", () => {
    expect(overdue({ due_date: "2026-09-30", status_category: "new" }, "2026-10-01")).toBe(true);
    expect(overdue({ due_date: "2026-09-30", status_category: "done" }, "2026-10-01")).toBe(false);
    expect(overdue({ due_date: null, status_category: "new" }, "2026-10-01")).toBe(false);
  });
});

describe("widgets", () => {
  it("keeps known columns only", () => {
    expect(columnsOf(["status", "nope", "due"])).toEqual(["status", "due"]);
    expect(columnsOf(undefined, ["assignee"])).toEqual(["assignee"]);
    expect(columnsOf(["status", "priority", "assignee", "due", "type"])).toHaveLength(4);
  });
  it("draws the burndown up to today", () => {
    const p = burndownPaths(
      [
        { date: "2026-09-01", remaining: 4, ideal: 4 },
        { date: "2026-09-02", remaining: 2, ideal: 2 },
        { date: "2026-09-03", remaining: null, ideal: 0 },
      ],
      100,
      40,
    );
    expect(p.ideal).toBe("M0,0 L50,20 L100,40");
    expect(p.actual).toBe("M0,0 L50,20");
    expect(p.today).toBe(50);
    expect(burndownPaths([], 10, 10).actual).toBe("");
  });
});

describe("quick search", () => {
  const ctx = { hits: [], recent: [], timerRunning: false, jira: true };
  it("offers the Issues page and an issue key", () => {
    expect(quickItems("jira", ctx).some((i) => i.action.type === "issues")).toBe(true);
    expect(quickItems("proj-12", ctx).find((i) => i.action.type === "issue")?.action).toEqual({ type: "issue", key: "PROJ-12" });
    expect(quickItems("proj-12", { ...ctx, jira: false }).some((i) => i.action.type === "issue")).toBe(false);
  });
});
