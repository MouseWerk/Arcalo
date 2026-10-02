// Smart meeting work (1.10): „Besprechung vorbereiten“, „Statusbericht“ and „Nachfass-Mail“.
// The pages and mails are built by the core (`annalo_core::meetwork`); this module holds the
// calls, the types and the small decisions the views share (which period, which fallback).

import { invoke } from "@tauri-apps/api/core";
import type { Page } from "./types";

const call = <R>(cmd: string, args?: Record<string, unknown>) =>
  invoke<R>(cmd, args).catch((e: unknown) => (e === "app-locked" ? new Promise<R>(() => {}) : Promise.reject(e)));

// ------------------------------------------------------------------ types

export interface AiOutcome {
  text: string | null;
  error: string | null;
  local: boolean;
}

export interface PrepOutcome {
  page: Page;
  created: boolean;
  ai: AiOutcome;
}

export type ScopeKind = "netzplan" | "jira" | "folder" | "tag";
export interface Scope {
  kind: ScopeKind;
  id: string;
  label: string;
}
export interface ScopeChoices {
  netzplaene: Scope[];
  jira: Scope[];
  folders: Scope[];
  tags: Scope[];
}

export type PeriodKind = "this_week" | "last_week" | "month" | "last_month" | "custom";
export interface Period {
  kind: PeriodKind;
  from: string | null;
  to: string | null;
}

/** The sections of a report in their default order (status.rs `SECTIONS`). */
export const REPORT_SECTIONS = ["summary", "hours", "jira", "notes", "deadlines", "risks"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface ReportRequest {
  scope: Scope;
  period: Period;
  sections: ReportSection[];
  ai: boolean;
}

export interface ReportTemplate {
  id: string;
  name: string;
  scope: Scope;
  period: PeriodKind;
  sections: ReportSection[];
  ai: boolean;
}

export interface LastReport {
  page_id: number;
  title: string;
  request: ReportRequest;
  at: string;
}

export interface StatusOutcome {
  page: Page;
  created: boolean;
  ai: AiOutcome;
}

export interface FollowAction {
  text: string;
  owner: string | null;
  due: string | null;
  done: boolean;
}

export interface FollowUp {
  page_id: number;
  to: string[];
  subject: string;
  lang: "de" | "en";
  meeting: string;
  date: string | null;
  intro: string;
  results: string[];
  decisions: string[];
  actions: FollowAction[];
  private: boolean;
  polished: boolean;
}

export interface FollowUpView {
  followup: FollowUp;
  html: string;
  text: string;
  mailto: string;
  mailto_truncated: boolean;
  outlook: boolean;
}

// ------------------------------------------------------------------ calls

export const meetApi = {
  /** Writes or refreshes the prep page; `ai`: also „Worauf achten“ (streams for `requestId`). */
  prepare: (requestId: string, key: string, ai: boolean) => call<PrepOutcome>("meeting_prep", { requestId, key, ai }),
  prepPage: (key: string) => call<number | null>("meeting_prep_page", { key }),
  prepKey: (pageId: number) => call<string | null>("meeting_prep_key", { pageId }),
  scopes: () => call<ScopeChoices>("status_scopes"),
  templates: () => call<ReportTemplate[]>("status_templates"),
  saveTemplate: (template: ReportTemplate) => call<ReportTemplate[]>("status_template_save", { template }),
  deleteTemplate: (id: string) => call<ReportTemplate[]>("status_template_delete", { id }),
  lastReport: () => call<LastReport | null>("status_last"),
  report: (requestId: string, request: ReportRequest) => call<StatusOutcome>("status_report", { requestId, request }),
  /** The page as a .md file, without the markers of its generated part. */
  writeMarkdown: (pageId: number, path: string) => call<void>("page_markdown_write", { pageId, path }),
  markdownText: (pageId: number) => call<string>("page_markdown_text", { pageId }),
  draftAvailable: () => call<boolean>("mail_draft_available"),
  /** An Outlook draft, shown and never sent. */
  draft: (to: string[], subject: string, html: string) => call<void>("mail_draft", { to, subject, html }),
  followUp: (pageId: number) => call<FollowUpView>("followup_build", { pageId }),
  polish: (requestId: string, pageId: number) => call<FollowUpView>("followup_polish", { requestId, pageId }),
};

// ------------------------------------------------------------------ helpers

/** The period choices in their order. */
export const PERIODS: PeriodKind[] = ["this_week", "last_week", "month", "last_month", "custom"];

/** A request with the defaults: this week, every section, AI when one is connected. */
export function newRequest(scope: Scope, ai: boolean): ReportRequest {
  return { scope, period: { kind: "this_week", from: null, to: null }, sections: [...REPORT_SECTIONS], ai };
}

/** The request of a saved template. */
export function requestOf(t: ReportTemplate): ReportRequest {
  return { scope: t.scope, period: { kind: t.period, from: null, to: null }, sections: [...t.sections], ai: t.ai };
}

/** A custom period needs both days, the end not before the start. */
export function periodValid(p: Period): boolean {
  if (p.kind !== "custom") return true;
  return !!p.from && !!p.to && p.from <= p.to;
}

/** Sections switched on or off, keeping the default order. */
export function toggleSection(list: ReportSection[], id: ReportSection, on: boolean): ReportSection[] {
  const set = new Set(list);
  if (on) set.add(id);
  else set.delete(id);
  return REPORT_SECTIONS.filter((s) => set.has(s));
}

/** The scopes of the choices that the settings allow, as one list (Netzplans, Jira, folders, tags). */
export function scopeList(c: ScopeChoices): Scope[] {
  return [...c.netzplaene, ...c.jira, ...c.folders, ...c.tags];
}

export const scopeKey = (s: Scope) => `${s.kind}:${s.id}`;

/** Where the follow-up mail goes: an Outlook draft when there is one, else the mail program. */
export function mailRoute(view: Pick<FollowUpView, "outlook">): "outlook" | "mailto" {
  return view.outlook ? "outlook" : "mailto";
}

/** Plain text for a `mailto:` link: cut at a line end to `max` characters, with a hint line. */
export function clipForMailto(text: string, max: number, hint: string): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const room = Math.max(0, max - hint.length - 2);
  const head = text.slice(0, room);
  const at = head.lastIndexOf("\n");
  return { text: `${at > room / 2 ? head.slice(0, at) : head}\n\n${hint}`, cut: true };
}

/** A `mailto:` link with subject and body (RFC 6068 encoding). */
export function mailtoUrl(to: string[], subject: string, body: string): string {
  const addr = to.filter((a) => a.includes("@")).map(encodeURIComponent).join(",");
  return `mailto:${addr}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`;
}

/** The Markdown without front matter, for a mail body („Als Text kopieren“). */
export function stripFrontMatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, "");
}

/** A file name for the Markdown export. */
export function markdownFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${base || "report"}.md`;
}
