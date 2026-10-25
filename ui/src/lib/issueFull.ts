// The issue view („Issue-Ansicht“, src-tauri/src/issueview.rs, arcalo_core::issues::view): the
// types of one issue as Jira's own page shows it, the IPC calls, the store of the modal and the
// pure helpers (sanitized HTML, durations, the time bar, Jira's timestamps).

import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { create } from "zustand";
import type { SiteKind } from "./jira";

export interface JUser {
  id: string;
  name: string;
  avatar: string;
  active: boolean;
}
export interface StatusRef {
  id: string;
  name: string;
  category: "new" | "indeterminate" | "done";
}
export interface IssueRef {
  key: string;
  summary: string;
  status: StatusRef;
  issue_type: string;
  priority: string;
}
export interface Named {
  id: string;
  name: string;
  icon: string;
}
export interface SprintRef {
  name: string;
  state: string;
}
export interface TimeTracking {
  original: number | null;
  remaining: number | null;
  spent: number | null;
  original_text: string;
  remaining_text: string;
  spent_text: string;
}
/** A field value by its schema type (`arcalo_core::issues::view::Shown`). */
export type Shown =
  | { t: "text"; v: string }
  | { t: "html"; v: string }
  | { t: "number"; v: number }
  | { t: "date"; v: string }
  | { t: "date_time"; v: string }
  | { t: "options"; v: string[] }
  | { t: "users"; v: JUser[] }
  | { t: "link"; v: { url: string; label: string } }
  | { t: "issue"; v: string }
  | { t: "sprints"; v: SprintRef[] }
  | { t: "cascade"; v: [string, string | null] };
export interface FieldShown {
  id: string;
  name: string;
  kind: string;
  value: Shown;
}
export interface LinkGroup {
  label: string;
  issues: { link_id: string; issue: IssueRef }[];
}
export interface Attachment {
  id: string;
  filename: string;
  size: number;
  mime: string;
  created: string;
  author: JUser | null;
  content: string;
  thumbnail: string;
}
export interface RemoteLink {
  id: string;
  title: string;
  url: string;
  summary: string;
  relationship: string;
}
export interface JComment {
  id: string;
  author: JUser | null;
  created: string;
  updated: string;
  html: string;
  /** ADF (Cloud) or wiki markup (Server), for editing. */
  body: unknown;
  own: boolean;
}
export interface CommentPage {
  total: number;
  start: number;
  items: JComment[];
}
export interface JWorklog {
  id: string;
  author: JUser | null;
  started: string;
  seconds: number;
  time_spent: string;
  comment: string;
  own: boolean;
}
export interface WorklogPage {
  total: number;
  start: number;
  items: JWorklog[];
}
export interface HistoryEntry {
  id: string;
  author: JUser | null;
  created: string;
  items: { field: string; from: string; to: string }[];
}
export interface HistoryPage {
  total: number;
  start: number;
  items: HistoryEntry[];
}
export type EditKind = "text" | "rich" | "number" | "date" | "date_time" | "select" | "multi_select" | "cascade" | "user" | "users" | "labels" | "url" | "time_tracking" | "unsupported";
export interface Choice {
  id: string;
  label: string;
  icon: string;
  children: Choice[];
}
export interface EditField {
  id: string;
  name: string;
  required: boolean;
  kind: EditKind;
  allowed: Choice[];
  operations: string[];
  schema: string;
  /** The value it has now (the start of an edit). */
  current: FieldInput | null;
  /** Rich text: what the editor cannot keep of it. */
  lossy: string[];
}
export interface Transition {
  id: string;
  name: string;
  to: StatusRef;
  has_screen: boolean;
  fields: EditField[];
}
export interface Perms {
  comment: boolean;
  edit_own_comments: boolean;
  edit_all_comments: boolean;
  delete_own_comments: boolean;
  delete_all_comments: boolean;
  log_work: boolean;
  assign: boolean;
  assignable: boolean;
  transition: boolean;
}
export interface IssueFull {
  site: string;
  kind: SiteKind;
  base: string;
  key: string;
  id: string;
  url: string;
  summary: string;
  issue_type: Named;
  subtask: boolean;
  status: StatusRef;
  resolution: string;
  project: Named;
  parent: IssueRef | null;
  epic: string | null;
  description_html: string;
  description: unknown;
  environment_html: string;
  assignee: JUser | null;
  reporter: JUser | null;
  creator: JUser | null;
  priority: Named | null;
  labels: string[];
  components: string[];
  fix_versions: string[];
  affects_versions: string[];
  sprints: SprintRef[];
  story_points: number | null;
  story_points_field: string;
  due_date: string | null;
  time: TimeTracking;
  created: string;
  updated: string;
  resolved: string;
  custom: FieldShown[];
  subtasks: IssueRef[];
  links: LinkGroup[];
  attachments: Attachment[];
  remote_links: RemoteLink[];
  comments: CommentPage;
  worklogs: WorklogPage;
  history: HistoryPage;
  watchers: number;
  watching: boolean;
  votes: number;
  voted: boolean;
  edit: EditField[];
  transitions: Transition[];
  perms: Perms;
  me: JUser;
}
export interface FullView {
  issue: IssueFull;
  fetched_at: string;
  /** Jira could not be reached: the last copy, read-only. */
  offline: string | null;
  site_name: string;
  site_color: string;
  note_page_id: number | null;
  wbs: string | null;
  booked_minutes: number;
  time_tracking: boolean;
  logs_work: boolean;
}
/** What the user entered for a field (`arcalo_core::issues::view::FieldInput`). */
export type FieldInput =
  | { t: "text"; v: string }
  | { t: "doc"; v: unknown }
  | { t: "number"; v: number | null }
  | { t: "date"; v: string | null }
  | { t: "choice"; v: string | null }
  | { t: "choices"; v: string[] }
  | { t: "user"; v: string | null }
  | { t: "users"; v: string[] }
  | { t: "labels"; v: string[] }
  | { t: "cascade"; v: [string | null, string | null] }
  | { t: "estimates"; v: [string | null, string | null] };
export type UpdateOutcome = { outcome: "saved"; undo: FieldInput | null } | { outcome: "conflict"; updated: string; value: Shown | null; by: JUser | null };
export interface EditResult {
  outcome: UpdateOutcome;
  view: FullView | null;
}
export interface EditorDoc {
  doc: unknown;
  lossy: string[];
}

const call = <R>(cmd: string, args?: Record<string, unknown>) => invoke<R>(cmd, args);

export const fullApi = {
  cached: (key: string) => call<FullView | null>("jira_full_cached", { key }),
  load: (key: string) => call<FullView>("jira_full", { key }),
  comments: (key: string, skip: number) => call<CommentPage>("jira_full_comments", { key, skip }),
  worklogs: (key: string, skip: number) => call<WorklogPage>("jira_full_worklogs", { key, skip }),
  history: (key: string, skip: number) => call<HistoryPage>("jira_full_history", { key, skip }),
  update: (key: string, field: string, input: FieldInput, expected: string) => call<EditResult>("jira_full_update", { key, field, input, expected }),
  assign: (key: string, user: string | null, unassign: boolean, expected: string) => call<EditResult>("jira_full_assign", { key, user, unassign, expected }),
  transition: (key: string, id: string, inputs: [string, FieldInput][], comment: unknown | null) => call<{ view: FullView; undo: string | null }>("jira_full_transition", { key, id, inputs, comment }),
  commentAdd: (key: string, doc: unknown) => call<{ view: FullView; id: string }>("jira_full_comment_add", { key, doc }),
  commentEdit: (key: string, id: string, doc: unknown) => call<FullView>("jira_full_comment_edit", { key, id, doc }),
  commentDelete: (key: string, id: string) => call<FullView>("jira_full_comment_delete", { key, id }),
  worklogAdd: (key: string, started: string, duration: string, comment: string, book: boolean) =>
    call<{ view: FullView; worklog_id: string | null; entry_id: number | null }>("jira_full_worklog_add", { key, started, duration, comment, book }),
  worklogDelete: (key: string, id: string) => call<FullView>("jira_full_worklog_delete", { key, id }),
  users: (key: string, query: string, assignable: boolean) => call<JUser[]>("jira_full_users", { key, query, assignable }),
  bodyDoc: (body: unknown) => call<EditorDoc>("jira_body_doc", { body }),
  image: (site: string, url: string) => call<string>("jira_image", { site, url }),
  attachment: (site: string, url: string, filename: string, target: string | null) => call<string>("jira_attachment", { site, url, filename, target }),
};

// ------------------------------------------------------------------ the modal

interface ModalState {
  /** The issues opened, the shown one last (a subtask or link opened from the view goes on top). */
  stack: string[];
  open: (key: string) => void;
  /** Back to the issue before (or closed). */
  back: () => void;
  close: () => void;
}

export const useIssueModal = create<ModalState>((set) => ({
  stack: [],
  open: (key) => set((st) => (st.stack[st.stack.length - 1] === key ? st : { stack: [...st.stack, key].slice(-20) })),
  back: () => set((st) => ({ stack: st.stack.slice(0, -1) })),
  close: () => set({ stack: [] }),
}));

/** Opens the issue view of `key` (from a chip, a list, a widget, the palette). */
export function openIssueView(key: string) {
  const k = parseIssueKey(key);
  if (k) useIssueModal.getState().open(k);
}

/** An issue key typed or pasted: `proj-12`, `PROJ-12` or an address `…/browse/PROJ-12`; null otherwise. */
export function parseIssueKey(text: string): string | null {
  const s = text.trim();
  const m = /\/browse\/([A-Za-z][A-Za-z0-9_]{1,11}-[1-9]\d{0,6})(?:[/?#]|$)/.exec(s) ?? /^([A-Za-z][A-Za-z0-9_]{1,11}-[1-9]\d{0,6})$/.exec(s);
  return m ? m[1].toUpperCase() : null;
}

// ------------------------------------------------------------------ helpers

/** Jira's timestamps (`2026-10-20T11:22:33.123+0200`) as a Date; WebKit reads the offset only with a colon. */
export function jiraDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const fixed = s.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The same as ISO text for the formatting helpers (`relative`, `dateTime`). */
export const jiraIso = (s: string | null | undefined) => jiraDate(s)?.toISOString() ?? "";

/** Seconds as Jira words them with its default 8 h day and 5 day week: „1w 2d 3h 30m“. */
export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return "0m";
  let m = Math.round(sec / 60);
  const parts: string[] = [];
  const unit = (size: number, name: string) => {
    if (m >= size) {
      parts.push(`${Math.floor(m / size)}${name}`);
      m %= size;
    }
  };
  unit(5 * 8 * 60, "w");
  unit(8 * 60, "d");
  unit(60, "h");
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ");
}

/** The time tracking bar: logged and remaining as shares of the larger of the estimate and their sum. */
export function timeBar(t: TimeTracking): { logged: number; remaining: number; over: boolean } | null {
  const spent = t.spent ?? 0;
  const remaining = t.remaining ?? (t.original != null ? Math.max(0, t.original - spent) : 0);
  const total = Math.max(t.original ?? 0, spent + remaining);
  if (total <= 0) return null;
  return { logged: spent / total, remaining: remaining / total, over: t.original != null && spent + remaining > t.original };
}

/** The editmeta field `id` when Jira allows to change it. */
export function editable(issue: IssueFull, id: string): EditField | null {
  return issue.edit.find((f) => f.id === id && f.operations.some((o) => o === "set" || o === "add" || o === "edit") && f.kind !== "unsupported") ?? null;
}

/** Whether a comment may be edited or deleted by the user. */
export function canEditComment(p: Perms, c: JComment): boolean {
  return c.own ? p.edit_own_comments || p.edit_all_comments : p.edit_all_comments;
}
export function canDeleteComment(p: Perms, c: JComment): boolean {
  return c.own ? p.delete_own_comments || p.delete_all_comments : p.delete_all_comments;
}

/** The fields of the details that Jira lets change but the view does not place itself. */
export const PLACED_FIELDS = new Set(["summary", "description", "comment", "worklog", "timetracking", "issuelinks", "attachment", "issuetype", "parent", "project", "reporter"]);

// ------------------------------------------------------------------ Jira's HTML

/** Tags of Jira's rendered HTML that stay (everything else keeps its text only). */
const ALLOWED_TAGS = ["a", "b", "strong", "i", "em", "u", "s", "del", "ins", "sub", "sup", "tt", "code", "pre", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "div", "span", "img", "details", "summary", "time", "cite", "q", "dl", "dt", "dd", "font"];
/** Tags whose content goes with them. */
const DROPPED_TAGS = ["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "form", "input", "button", "textarea", "select", "link", "meta", "base"];
const ALLOWED_ATTRS = ["href", "src", "alt", "title", "class", "colspan", "rowspan", "start", "data-media-alt", "data-done", "open", "width", "height"];

/**
 * Jira's rendered HTML made safe to show: no scripts, styles or event handlers; links point to the
 * site (relative ones made absolute) and open outside; `/browse/KEY` links open that issue in the
 * view; images keep their address in `data-jira-src` and are loaded through the site's client
 * (never by the web view, so no login travels in an address); Jira's emoticon images are shown as
 * their short names, as text.
 */
export function sanitizeJiraHtml(html: string, base: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ALLOWED_ATTRS }) as unknown as string;
  const clean = tpl.content;
  // The same allowlist once more over the result (the HTML comes from a server).
  for (const el of [...clean.querySelectorAll("*")]) {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.includes(tag)) {
      if (DROPPED_TAGS.includes(tag)) el.remove();
      else el.replaceWith(...el.childNodes);
      continue;
    }
    for (const a of [...el.attributes]) if (!ALLOWED_ATTRS.includes(a.name.toLowerCase())) el.removeAttribute(a.name);
  }
  const abs = (u: string) => {
    try {
      return new URL(u, `${base.replace(/\/+$/, "")}/`).toString();
    } catch {
      return "";
    }
  };
  for (const img of [...clean.querySelectorAll("img")]) {
    if (img.classList.contains("emoticon") || /\/images\/icons\/emoticons\//.test(img.getAttribute("src") ?? "")) {
      img.replaceWith(document.createTextNode(img.getAttribute("alt") ?? ""));
      continue;
    }
    const src = img.getAttribute("src");
    img.removeAttribute("src");
    if (src && /^(https?:|\/)/i.test(src)) img.setAttribute("data-jira-src", abs(src));
    img.setAttribute("loading", "lazy");
    if (!img.getAttribute("alt")) img.setAttribute("alt", "");
  }
  for (const a of [...clean.querySelectorAll("a")]) {
    const href = a.getAttribute("href") ?? "";
    const url = /^(https?:|mailto:|\/|#)/i.test(href.trim()) ? abs(href) : "";
    if (!url) {
      a.removeAttribute("href");
      continue;
    }
    a.setAttribute("href", url);
    const issue = /\/browse\/([A-Z][A-Z0-9_]{1,11}-[1-9]\d{0,6})(?:[?#].*)?$/.exec(url);
    if (issue && url.startsWith(base)) a.setAttribute("data-issue-key", issue[1]);
    a.setAttribute("rel", "noreferrer");
  }
  // Jira's class names get a prefix (its `panel` or `code` must not take the app's styles); the
  // view's own (`jira-…`, `language-…`) stay.
  for (const el of [...clean.querySelectorAll("[class]")]) {
    const names = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    el.setAttribute("class", names.map((n) => (/^(jira-|language-)/.test(n) ? n : `j-${n}`)).join(" "));
  }
  // Server's `<font color>` and panel colors: the app's colors instead.
  for (const f of [...clean.querySelectorAll("font")]) f.replaceWith(...f.childNodes);
  const out = document.createElement("div");
  out.append(clean);
  return out.innerHTML;
}

/** The images of an issue's HTML that name an attachment by file name (ADF drawn by Arcalo). */
export function attachmentByName(issue: IssueFull, name: string): Attachment | null {
  return issue.attachments.find((a) => a.filename === name) ?? null;
}

/** Whether a file can be shown as an image thumbnail. */
export const isImage = (a: Attachment) => /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.mime) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename);

/** Comments in the order the user chose (Jira sends the newest first). */
export function ordered<T>(items: T[], newestFirst: boolean): T[] {
  return newestFirst ? items : [...items].reverse();
}

const ORDER_PREF = "arcalo.issue.comments.newest";
export function loadNewestFirst(): boolean {
  try {
    return localStorage.getItem(ORDER_PREF) !== "0";
  } catch {
    return true;
  }
}
export function saveNewestFirst(v: boolean) {
  try {
    localStorage.setItem(ORDER_PREF, v ? "1" : "0");
  } catch {
    /* not kept */
  }
}

// ------------------------------------------------------------------ „Issue öffnen…“

export const useIssuePrompt = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

/** The palette's „Issue öffnen…“: asks for a key (or picks a cached issue). */
export const openIssuePrompt = () => useIssuePrompt.getState().set(true);
