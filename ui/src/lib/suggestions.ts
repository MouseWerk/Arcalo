import { t } from "./i18n";
// Suggestions of the assistant's empty state, built from what is going on: the open page (and
// its Vorgang), overdue and due tasks, gaps in this week's bookings, budget warnings and the
// time of day. At most five, the most specific first.

export type SuggestionKind = "page" | "tasks" | "time" | "budget" | "report" | "plan";

export interface Suggestion {
  kind: SuggestionKind;
  text: string;
}

export interface SuggestionContext {
  now: Date;
  page: { title: string; openTasks: number; reference: string | null } | null;
  overdue: number;
  dueToday: number;
  openTasks: number;
  /** Past workdays of this week below the daily target, e.g. ["Mo", "Di"]. */
  gapDays: string[];
  /** The Netzplan/Vorgang with the most critical budget, e.g. "NP-8801/1010". */
  budget: string | null;
  hasBookings: boolean;
  /** „Zeiterfassung verwenden“ (default on): off, nothing about bookings, budgets or the weekly report. */
  time?: boolean;
}

/** Kinds that are about booking time. */
const TIME_KINDS: ReadonlySet<SuggestionKind> = new Set<SuggestionKind>(["time", "budget", "report"]);

export function buildSuggestions(c: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = [];
  const time = c.time !== false;
  const add = (kind: SuggestionKind, text: string) => (time || !TIME_KINDS.has(kind)) && !out.some((s) => s.text === text) && out.push({ kind, text });
  const hour = c.now.getHours();
  const weekday = c.now.getDay(); // 0 = Sunday

  if (c.page) {
    add("page", t("sugg.summarize", { title: c.page.title }));
    if (c.page.reference && time) add("budget", t("sugg.budget", { ref: c.page.reference }));
    else if (c.page.openTasks > 0) add("tasks", t("sugg.prioritizePage", { title: c.page.title }));
    else add("page", t("sugg.nextSteps", { title: c.page.title }));
  }
  if (c.overdue > 0) add("tasks", t("sugg.overdue", { n: c.overdue }));
  else if (c.dueToday > 0) add("tasks", t("sugg.dueToday", { n: c.dueToday }));
  if (c.gapDays.length) add("time", t("sugg.gaps", { days: c.gapDays.join(", ") }));
  if (c.budget && !out.some((s) => s.kind === "budget")) add("budget", t("sugg.budget", { ref: c.budget }));
  // Friday, or Thursday afternoon: the weekly status mail is due.
  if (c.hasBookings && (weekday === 5 || (weekday === 4 && hour >= 14))) add("report", t("sugg.report"));
  if (hour < 11 && weekday >= 1 && weekday <= 5) add("plan", t("sugg.plan"));
  if (c.openTasks > 0 && !out.some((s) => s.kind === "tasks")) add("tasks", t("sugg.open"));
  if (c.hasBookings) add("time", t("sugg.booked"));
  add("plan", t("sugg.next"));
  return out.slice(0, 5);
}
