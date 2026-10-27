import { describe, expect, it } from "vitest";
import { burndownPaths, columnsOf, emptyIssueQuery, filterIssues, findKeys, fromIssueTable, groupIssues, isKey, isSiteAddress, overdue, priorityClass, priorityLevel, priorityRank, valuesOf, worklogDeleteKeys, worklogShown, type EntryIssue, type Issue } from "./jira";
import { guessKind } from "../views/settings/JiraSection";
import { typeOf } from "./issueTypes";
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

describe("priority colors in any language", () => {
  it("uses the synced level, else the name", () => {
    expect(priorityClass({ priority: "Höchste", priority_level: 0 })).toBe("prio-up");
    expect(priorityClass({ priority: "Hoch" })).toBe("prio-up");
    expect(priorityClass({ priority: "Mittel" })).toBe("");
    expect(priorityClass({ priority: "Niedrig" })).toBe("prio-down");
    expect(priorityClass({ priority: "Niedrigste" })).toBe("prio-down");
    // A custom Server priority: only its level knows.
    expect(priorityClass({ priority: "Sofort erledigen", priority_level: 5 })).toBe("prio-up");
    expect(priorityClass({ priority: "Irgendwann", priority_level: 1 })).toBe("prio-down");
    expect(priorityClass({ priority: "Eigene" })).toBe("");
    expect(priorityLevel({ priority: " HIGH " })).toBe(4);
  });
  it("groups localized priorities by their level", () => {
    const names = { site: (id: string) => id, empty: "Ohne" };
    const de = [issue("A-1", { priority: "Niedrig", priority_level: 2 }), issue("A-2", { priority: "Sofort", priority_level: 5 }), issue("A-3", { priority: "Mittel", priority_level: 3 })];
    expect(groupIssues(de, "priority", names).map((g) => g.label)).toEqual(["Sofort", "Mittel", "Niedrig"]);
    expect(priorityRank("Höchste")).toBeLessThan(priorityRank("Niedrigste"));
  });
});

describe("Jira worklogs of time entries", () => {
  const e = (p: Partial<EntryIssue>): EntryIssue => ({ entry_id: 1, issue_key: "PROJ-5", site: "acme", worklog_state: "none", worklog_id: null, error: null, syncs: true, ...p });
  it("shows posted, pending and failed; a site that does not log work shows the key only", () => {
    expect(worklogShown(e({ worklog_state: "posted", worklog_id: "10" }))).toBe("posted");
    expect(worklogShown(e({ worklog_state: "pending" }))).toBe("pending");
    expect(worklogShown(e({ worklog_state: "posting" }))).toBe("pending");
    // An edit of a posted entry: pending again until Jira has it.
    expect(worklogShown(e({ worklog_state: "pending", worklog_id: "10" }))).toBe("pending");
    expect(worklogShown(e({ worklog_state: "failed", error: "offline" }))).toBe("failed");
    expect(worklogShown(e({ worklog_state: "none" }))).toBe("none");
    expect(worklogShown(e({ worklog_state: "pending", syncs: false }))).toBe("none");
    expect(worklogShown(e({ worklog_state: "pending", worklog_id: "10", syncs: false }))).toBe("posted");
  });
  it("names the issues whose worklog a deletion removes", () => {
    const list = [e({ worklog_id: "10", worklog_state: "posted" }), e({ entry_id: 2, worklog_id: "11", worklog_state: "posted" }), e({ entry_id: 3, issue_key: "OPS-7" }), e({ entry_id: 4, issue_key: "OPS-8", worklog_id: "12", syncs: false })];
    expect(worklogDeleteKeys(list)).toEqual(["PROJ-5"]);
    expect(worklogDeleteKeys([])).toEqual([]);
  });
});

describe("isSiteAddress", () => {
  it("takes cloud, company and intranet addresses", () => {
    for (const ok of ["firma.atlassian.net", "https://firma.atlassian.net/", "https://jira", "http://jira:8080", "jira:8080", "https://jira.firma.local/jira", "http://127.0.0.1:41234", " https://jira.firma.de "]) expect(isSiteAddress(ok), ok).toBe(true);
  });
  it("refuses what cannot be an address", () => {
    for (const bad of ["", "jira", "https://", "http://ji ra", "ftp://jira.firma.de", "jira firma.de", "mia@firma.de", "https://jira:port"]) expect(isSiteAddress(bad), bad).toBe(false);
  });
});

describe("compact issue list", () => {
  it("decodes the table of jira_issues_compact into the issue objects, without comments", () => {
    const [a, b] = fromIssueTable({
      projects: [
        ["PROJ", "Projekt"],
        ["OPS", "Betrieb"],
      ],
      rows: [
        ["acme", "PROJ-1", "10001", "Erstes", "In Arbeit", "indeterminate", "High", 4, "Mia", "Tom", "Task", 0, "Sprint 3", "active", "2026-10-20", "2026-10-01T08:00:00Z", null, "https://acme/browse/PROJ-1", "Text", ["mine"]],
        ["acme", "OPS-2", "10002", "Zweites", "Erledigt", "done", "", 0, "", "", "Bug", 1, "", "", null, null, "2026-10-02T08:00:00Z", "", "", []],
      ],
    });
    expect(a).toEqual(
      issue("PROJ-1", { remote_id: "10001", summary: "Erstes", status: "In Arbeit", status_category: "indeterminate", priority: "High", priority_level: 4, reporter: "Tom", project_name: "Projekt", sprint: "Sprint 3", sprint_state: "active", due_date: "2026-10-20", updated: "2026-10-01T08:00:00Z", url: "https://acme/browse/PROJ-1", description: "Text" }),
    );
    expect([b.project_key, b.project_name, b.resolved, b.comments, b.matches]).toEqual(["OPS", "Betrieb", "2026-10-02T08:00:00Z", [], []]);
  });
});
