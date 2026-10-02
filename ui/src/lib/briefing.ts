// Morgen-Briefing: opening it from anywhere, its sections (order and switches, Settings →
// Briefing and the gear on the view) and the numbers the view and the start page widget show.

import { useApp } from "../store/app";
import { api } from "./api";
import { t } from "./i18n";
import type { Briefing, BriefingMeeting, BriefingSection, BriefingSectionId, BriefingSettings } from "./types";

/** The sections in their default order (briefing.rs `SECTIONS`). */
export const SECTION_IDS: BriefingSectionId[] = ["ai", "meetings", "tasks", "jira", "time"];

export const DEFAULT_BRIEFING: BriefingSettings = {
  mode: "off",
  notify_time: "",
  sections: SECTION_IDS.map((id) => ({ id, on: true })),
};

/** Opens the briefing (a tab of its own). */
export function openBriefing(opts?: { newTab?: boolean }) {
  useApp.getState().openTab({ kind: "briefing" }, opts);
}

/** The notification came while the app is in front: a toast that opens the briefing. */
export function offerBriefing() {
  useApp.getState().toast({ tone: "info", title: t("brief.notified"), action: { label: t("brief.open"), run: () => openBriefing() } });
}

/** After the start: the first start of a briefing day opens it or notifies (Settings → Briefing). */
export async function startBriefing() {
  const action = await api.briefingStart().catch(() => "none" as const);
  if (action === "open") openBriefing();
  else if (action === "notify") offerBriefing();
}

/** Known sections once each in the saved order, missing ones appended (on). */
export function normalizeSections(list: BriefingSection[] | undefined): BriefingSection[] {
  const out: BriefingSection[] = [];
  for (const s of list ?? []) if (SECTION_IDS.includes(s.id) && !out.some((x) => x.id === s.id)) out.push({ id: s.id, on: !!s.on });
  for (const id of SECTION_IDS) if (!out.some((x) => x.id === id)) out.push({ id, on: true });
  return out;
}

/** The settings with their defaults (older settings have none). */
export const briefingSettings = (b: BriefingSettings | undefined): BriefingSettings => ({
  ...DEFAULT_BRIEFING,
  ...b,
  sections: normalizeSections(b?.sections),
});

/** Moves section `id` one place up (-1) or down (+1); unchanged at the ends. */
export function moveSection(list: BriefingSection[], id: BriefingSectionId, delta: -1 | 1): BriefingSection[] {
  const i = list.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export const toggleSection = (list: BriefingSection[], id: BriefingSectionId, on: boolean): BriefingSection[] => list.map((s) => (s.id === id ? { ...s, on } : s));

/** Meetings that are work (free, out-of-office and private appointments aside). */
export const workMeetings = (b: Briefing): BriefingMeeting[] => b.meetings.filter((m) => !m.free);

/** The meeting under way or next. */
export const nextMeeting = (b: Briefing): BriefingMeeting | null => b.meetings.find((m) => m.key === b.next_meeting) ?? null;

/** Counts per section for the widget and the overview. */
export function briefingCounts(b: Briefing) {
  const j = b.jira;
  return {
    meetings: workMeetings(b).length,
    upcoming: workMeetings(b).filter((m) => !m.past).length,
    tasks: b.tasks.overdue_total + b.tasks.today_total,
    overdue: b.tasks.overdue_total,
    jira: j ? j.overdue_total + j.due_total + j.blocked_total : 0,
    missing: b.time?.missing_minutes ?? 0,
  };
}

/** Whether the section shows on the page (switched on and available). */
export const shows = (b: Briefing, id: BriefingSectionId) => b.sections.includes(id);

/** Lines of the text without list markers (the widget shows the first). */
export const summaryLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
