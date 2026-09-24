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
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function buildSuggestions(c: SuggestionContext): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (kind: SuggestionKind, text: string) => !out.some((s) => s.text === text) && out.push({ kind, text });
  const hour = c.now.getHours();
  const weekday = c.now.getDay(); // 0 = Sunday

  if (c.page) {
    add("page", `„${c.page.title}“ zusammenfassen`);
    if (c.page.reference) add("budget", `Wie steht das Budget von ${c.page.reference}?`);
    else if (c.page.openTasks > 0) add("tasks", `Offene Aufgaben in „${c.page.title}“ priorisieren`);
    else add("page", `Nächste Schritte zu „${c.page.title}“ vorschlagen`);
  }
  if (c.overdue > 0) add("tasks", `${plural(c.overdue, "überfällige Aufgabe", "überfällige Aufgaben")} priorisieren`);
  else if (c.dueToday > 0) add("tasks", `Was steht heute an? (${plural(c.dueToday, "Aufgabe", "Aufgaben")} fällig)`);
  if (c.gapDays.length) add("time", `Lücken in der Zeiterfassung prüfen (${c.gapDays.join(", ")})`);
  if (c.budget && !out.some((s) => s.kind === "budget")) add("budget", `Wie steht das Budget von ${c.budget}?`);
  // Friday, or Thursday afternoon: the weekly status mail is due.
  if (c.hasBookings && (weekday === 5 || (weekday === 4 && hour >= 14))) add("report", "Wochenbericht erstellen");
  if (hour < 11 && weekday >= 1 && weekday <= 5) add("plan", "Tagesplan für heute erstellen");
  if (c.openTasks > 0 && !out.some((s) => s.kind === "tasks")) add("tasks", "Welche Aufgaben sind noch offen?");
  if (c.hasBookings) add("time", "Was habe ich diese Woche gebucht?");
  add("plan", "Was sollte ich als Nächstes erledigen?");
  return out.slice(0, 5);
}
