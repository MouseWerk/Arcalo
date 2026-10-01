// Jira (annalo_core::issues, src-tauri/src/jira.rs): types, the IPC calls, the index of cached
// issues the chips in notes read, and the pure helpers of the Issues page and the widgets
// (filters, groups, key detection, the burndown path).

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { on } from "./api";

export type SiteKind = "cloud" | "server";

/** The search every site syncs (annalo_core::issues::DEFAULT_JQL without its order). */
export const DEFAULT_JQL = "assignee = currentUser() AND statusCategory != Done";

export interface JiraSite {
  id: string;
  name: string;
  color: string;
  kind: SiteKind;
  url: string;
  email: string;
  enabled: boolean;
  log_work: boolean;
  allow_writes: boolean;
}
export interface SavedQuery {
  id: string;
  site: string;
  name: string;
  jql: string;
}
export interface IssueSettings {
  sites: JiraSite[];
  queries: SavedQuery[];
  sync_minutes: number;
  tick_done_tasks: boolean;
}
export interface IssueComment {
  author: string;
  created: string;
  body: string;
}
export type Category = "new" | "indeterminate" | "done";
export interface Issue {
  site: string;
  key: string;
  remote_id: string;
  summary: string;
  status: string;
  status_category: Category;
  priority: string;
  assignee: string;
  reporter: string;
  issue_type: string;
  project_key: string;
  project_name: string;
  sprint: string;
  sprint_state: string;
  due_date: string | null;
  updated: string | null;
  resolved: string | null;
  url: string;
  description: string;
  comments: IssueComment[];
  matches: string[];
}
export interface SiteSync {
  site: string;
  synced_at: string | null;
  attempted_at: string | null;
  error: string | null;
  issues: number;
  account: string;
}
export interface SiteInfo extends JiraSite {
  token_set: boolean;
  sync: SiteSync | null;
  syncing: boolean;
}
export interface WbsMapping {
  kind: "issue" | "project";
  key: string;
  reference: string;
  learned: boolean;
}
export interface JiraStatus {
  sites: SiteInfo[];
  secret_storage: string;
  mappings: WbsMapping[];
  projects: [string, string, string][];
}
export interface TestResult {
  display_name: string;
  email: string;
  detected: SiteKind | null;
  kind: SiteKind;
}
/** What a chip and its hover card show. */
export type ChipIssue = Pick<Issue, "key" | "site" | "summary" | "status" | "status_category" | "issue_type" | "priority" | "assignee" | "due_date" | "url" | "description">;
export interface IssueIndex {
  projects: string[];
  issues: ChipIssue[];
}
export interface Backlink {
  page_id: number;
  title: string;
  icon: string | null;
  note: boolean;
}
export interface IssueView {
  issue: Issue | null;
  backlinks: Backlink[];
  note_page_id: number | null;
  wbs: string | null;
  booked_minutes: number;
}
export interface BurnPoint {
  date: string;
  remaining: number | null;
  ideal: number;
}
export interface Sprint {
  id: number;
  name: string;
  goal: string;
  board: string;
  start: string | null;
  end: string | null;
  issues: Issue[];
}
export interface SprintView {
  site: string;
  project: string;
  available: boolean;
  sprint: Sprint | null;
  burndown: BurnPoint[];
  read_at: string | null;
  error: string | null;
}
export interface RemoteProject {
  key: string;
  name: string;
  issue_types: string[];
}
export interface EntryIssue {
  entry_id: number;
  issue_key: string;
  site: string;
  worklog_state: "none" | "pending" | "posting" | "posted" | "failed";
  worklog_id: string | null;
  error: string | null;
}
export interface IssueFilterArgs {
  site?: string;
  query?: string;
  all?: boolean;
  limit?: number | null;
}

const call = <R>(cmd: string, args?: Record<string, unknown>) => invoke<R>(cmd, args);

export const jiraApi = {
  status: () => call<JiraStatus>("jira_status"),
  saveSite: (site: JiraSite, token: string | null) => call<JiraStatus>("jira_site_save", { site, token }),
  removeSite: (id: string) => call<JiraStatus>("jira_site_remove", { id }),
  test: (site: JiraSite, token: string | null) => call<TestResult>("jira_test", { site, token }),
  setWbs: (kind: "issue" | "project", key: string, reference: string) => call<JiraStatus>("jira_wbs_set", { kind, key, reference }),
  syncNow: (site: string | null = null) => call<JiraStatus>("jira_sync_now", { site }),
  issues: (filter: IssueFilterArgs = {}) => call<Issue[]>("jira_issues", { filter: { site: "", query: "", all: false, limit: null, ...filter } }),
  index: () => call<IssueIndex>("jira_index"),
  view: (key: string) => call<IssueView>("jira_issue_view", { key }),
  fetch: (key: string) => call<Issue>("jira_issue_fetch", { key }),
  note: (key: string) => call<{ page: { id: number; title: string }; created: boolean }>("jira_issue_note", { key }),
  addTask: (key: string) => call<{ page_id: number; title: string }>("jira_add_task", { key }),
  entryIssues: (entryIds: number[]) => call<EntryIssue[]>("jira_entry_issues", { entryIds }),
  projects: (site: string) => call<RemoteProject[]>("jira_projects", { site }),
  issueTypes: (site: string, project: string) => call<string[]>("jira_issue_types", { site, project }),
  create: (site: string, project: string, issueType: string, summary: string, pageId: number | null) =>
    call<Issue>("jira_create_issue", { site, project, issueType, summary, pageId }),
  sprint: (site: string | null, project: string | null) => call<SprintView>("jira_sprint", { site, project }),
  retryWorklog: (entryId: number) => call<void>("jira_worklog_retry", { entryId }),
  tool: (name: string, args: string) => call<string>("jira_tool", { name, arguments: args }),
};

// ------------------------------------------------------------------ index (chips)

interface IndexState {
  projects: Set<string>;
  byKey: Map<string, ChipIssue>;
  /** Bumped on every load (editors rebuild their chips). */
  version: number;
  load: () => Promise<void>;
}

export const useIssueIndex = create<IndexState>((set) => ({
  projects: new Set(),
  byKey: new Map(),
  version: 0,
  load: async () => {
    try {
      const idx = await jiraApi.index();
      set((st) => ({ projects: new Set(idx.projects), byKey: new Map(idx.issues.map((i) => [i.key, i])), version: st.version + 1 }));
    } catch {
      /* no index: no chips */
    }
  },
}));

let started = false;
/** Loads the index once and again after every sync. */
export function startIssueIndex() {
  if (started) return;
  started = true;
  void useIssueIndex.getState().load();
  void on("jira://synced", () => void useIssueIndex.getState().load());
}

// ------------------------------------------------------------------ keys

const keyChar = (c: string) => /[A-Z0-9_]/.test(c);

/** Whether `s` has the form of an issue key (`PROJ-123`); same rule as annalo_core::issues::is_key. */
export function isKey(s: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,11}-[1-9][0-9]{0,6}$/.test(s);
}

export const projectOf = (key: string) => key.split("-")[0];

/**
 * Issue keys in `text` of the projects in `projects`, standing alone (not inside a word, a path or
 * an address): offsets and keys. Mirrors annalo_core::issues::find_keys.
 */
export function findKeys(text: string, projects: Set<string>): { from: number; to: number; key: string }[] {
  const out: { from: number; to: number; key: string }[] = [];
  if (!projects.size) return out;
  const re = /[A-Z][A-Z0-9_]*-\d+/g;
  for (const m of text.matchAll(re)) {
    const from = m.index ?? 0;
    const to = from + m[0].length;
    const prev = from > 0 ? text[from - 1] : " ";
    if (/[\p{L}\p{N}\-_/.@#=]/u.test(prev) || keyChar(prev)) continue;
    const next = to < text.length ? text[to] : " ";
    if (/[\p{L}\p{N}\-_/]/u.test(next)) continue;
    if (next === "." && /\d/.test(text[to + 1] ?? "")) continue;
    const key = m[0];
    if (!isKey(key) || !projects.has(projectOf(key))) continue;
    out.push({ from, to, key });
  }
  return out;
}

// ------------------------------------------------------------------ the Issues page

export type GroupBy = "none" | "site" | "project" | "status" | "sprint" | "priority";
export const GROUP_BYS: GroupBy[] = ["none", "site", "project", "status", "sprint", "priority"];

export interface IssueQuery {
  text: string;
  site: string;
  project: string;
  status: string;
  sprint: string;
  priority: string;
}
export const emptyIssueQuery = (): IssueQuery => ({ text: "", site: "", project: "", status: "", sprint: "", priority: "" });

/** Issues matching the filters; the text matches key, summary, assignee, type and description (all words). */
export function filterIssues(list: Issue[], q: IssueQuery): Issue[] {
  const words = q.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((i) => {
    if (q.site && i.site !== q.site) return false;
    if (q.project && i.project_key !== q.project) return false;
    if (q.status && i.status !== q.status) return false;
    if (q.sprint && i.sprint !== q.sprint) return false;
    if (q.priority && i.priority !== q.priority) return false;
    if (!words.length) return true;
    const hay = `${i.key} ${i.summary} ${i.assignee} ${i.issue_type} ${i.status} ${i.description}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** Distinct non-empty values of a field, sorted. */
export function valuesOf(list: Issue[], field: "project_key" | "status" | "sprint" | "priority" | "site"): string[] {
  const set = new Set<string>();
  for (const i of list) if (i[field]) set.add(i[field]);
  return [...set].sort((a, b) => (field === "priority" ? priorityRank(a) - priorityRank(b) : a.localeCompare(b)));
}

const PRIORITY_ORDER = ["highest", "blocker", "critical", "high", "major", "medium", "normal", "low", "minor", "lowest", "trivial"];
/** Order of a priority name (Jira's default names; unknown ones after them). */
export function priorityRank(p: string): number {
  const i = PRIORITY_ORDER.indexOf(p.trim().toLowerCase());
  return i < 0 ? PRIORITY_ORDER.length : i;
}

const CATEGORY_ORDER: Record<string, number> = { indeterminate: 0, new: 1, done: 2 };

export interface IssueGroup {
  id: string;
  label: string;
  issues: Issue[];
}

/** Issues in groups by `by` (one group without a heading for `none`); `empty` names the group of issues without a value. */
export function groupIssues(list: Issue[], by: GroupBy, names: { site: (id: string) => string; empty: string }): IssueGroup[] {
  if (by === "none") return [{ id: "all", label: "", issues: list }];
  const value = (i: Issue): string => {
    switch (by) {
      case "site":
        return i.site;
      case "project":
        return i.project_key;
      case "status":
        return i.status;
      case "sprint":
        return i.sprint;
      case "priority":
        return i.priority;
    }
  };
  const groups = new Map<string, Issue[]>();
  for (const i of list) {
    const v = value(i);
    groups.set(v, [...(groups.get(v) ?? []), i]);
  }
  const rank = (id: string, sample: Issue) => {
    if (!id) return [9, 0, ""] as const;
    if (by === "status") return [0, CATEGORY_ORDER[sample.status_category] ?? 1, id] as const;
    if (by === "priority") return [0, priorityRank(id), id] as const;
    if (by === "sprint") return [0, sample.sprint_state === "active" ? 0 : sample.sprint_state === "future" ? 1 : 2, id] as const;
    return [0, 0, id] as const;
  };
  return [...groups.entries()]
    .map(([id, issues]) => ({ id: id || "-", label: id ? (by === "site" ? names.site(id) : by === "project" ? `${id}${issues[0].project_name ? ` · ${issues[0].project_name}` : ""}` : id) : names.empty, issues, r: rank(id, issues[0]) }))
    .sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2].localeCompare(b.r[2]))
    .map(({ id, label, issues }) => ({ id, label, issues }));
}

/** Badge tone of a status category. */
export function categoryTone(cat: string): "neutral" | "info" | "success" {
  return cat === "done" ? "success" : cat === "indeterminate" ? "info" : "neutral";
}

/** A due date before `today` (`YYYY-MM-DD`) of an open issue. */
export const overdue = (i: Pick<Issue, "due_date" | "status_category">, today: string) => !!i.due_date && i.due_date < today && i.status_category !== "done";

// ------------------------------------------------------------------ widgets

export const JIRA_COLUMNS = ["status", "priority", "assignee", "due", "type", "sprint"] as const;
export type JiraColumn = (typeof JIRA_COLUMNS)[number];

/** A widget's columns from its settings (unknown names dropped, at most four). */
export function columnsOf(v: unknown, fallback: JiraColumn[] = ["status"]): JiraColumn[] {
  if (!Array.isArray(v)) return fallback;
  return v.filter((c): c is JiraColumn => (JIRA_COLUMNS as readonly string[]).includes(c)).slice(0, 4);
}

/** The SVG paths of a burndown: the issues still open (up to today) and the ideal line, in a `w`×`h` box. */
export function burndownPaths(points: BurnPoint[], w: number, h: number): { actual: string; ideal: string; max: number; today: number | null } {
  if (points.length < 2) return { actual: "", ideal: "", max: 0, today: null };
  const max = Math.max(1, ...points.map((p) => Math.max(p.remaining ?? 0, p.ideal)));
  const x = (i: number) => +((i / (points.length - 1)) * w).toFixed(1);
  const y = (v: number) => +(h - (v / max) * h).toFixed(1);
  const ideal = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.ideal)}`).join(" ");
  let actual = "";
  let today: number | null = null;
  points.forEach((p, i) => {
    if (p.remaining == null) return;
    actual += `${actual ? " L" : "M"}${x(i)},${y(p.remaining)}`;
    today = x(i);
  });
  return { actual, ideal, max, today };
}
