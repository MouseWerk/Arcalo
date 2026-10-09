// „Erste Schritte“: the card on the start page after the first setup (FirstSteps.tsx). Three or
// four next steps that tick themselves off (a note written, today's daily note opened, a
// calendar connected) or once followed; it hides when all are done or when dismissed. Kept per
// computer in localStorage, like the panel layout: it is a hint, not a setting.

import { create } from "zustand";
import type { TKey } from "../lib/i18n";
import { isoDay } from "../lib/format";
import { aiOn } from "../lib/aiswitch";
import { timeTrackingOn } from "../lib/timetracking";
import { usableProvider } from "../lib/providers";
import type { Page, SettingsView } from "../lib/types";

const KEY = "arcalo.first-steps";

export interface Stored {
  /** When the setup was finished (pages changed after it count as written). */
  since: string;
  /** Steps followed from the card. */
  clicked: string[];
  hidden: boolean;
}

function read(): Stored | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Stored | null;
    return v && typeof v.since === "string" ? { since: v.since, clicked: Array.isArray(v.clicked) ? v.clicked : [], hidden: !!v.hidden } : null;
  } catch {
    return null;
  }
}

function write(v: Stored | null) {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode or full storage: the card simply does not come back after a restart.
  }
}

export const useFirstSteps = create<{ stored: Stored | null }>(() => ({ stored: read() }));

const save = (next: Stored | null) => {
  write(next);
  useFirstSteps.setState({ stored: next });
};

/** After the first setup of a new workspace. */
export function showFirstSteps(now = new Date()) {
  save({ since: now.toISOString(), clicked: [], hidden: false });
}


export const hideFirstSteps = () => {
  const cur = useFirstSteps.getState().stored;
  if (cur) save({ ...cur, hidden: true });
};

export const followFirstStep = (id: string) => {
  const cur = useFirstSteps.getState().stored;
  if (cur && !cur.clicked.includes(id)) save({ ...cur, clicked: [...cur.clicked, id] });
};

export type FirstStepId = "note" | "today" | "task" | "calendar" | "time" | "ai" | "aiSetup";

export interface FirstStep {
  id: FirstStepId;
  title: TKey;
  text: TKey;
  /** The keymap command that does the same: its shortcut of Settings → Tastatur is shown. */
  command?: string;
  done: boolean;
}

/** The steps for these settings and pages: three common ones and one that fits (calendar, time
 * or AI). Pure; tested in firststeps.test.ts. */
export function firstSteps(view: SettingsView | null, pages: Iterable<Page>, stored: Stored, today = isoDay(new Date())): FirstStep[] {
  const list = [...pages];
  const s = view?.settings;
  const written = list.some((p) => !p.daily_date && p.updated_at > stored.since);
  const daily = list.some((p) => p.daily_date === today);
  const calendar = !!s?.calendar && (s.calendar.outlook || (s.calendar.sources ?? []).some((x) => x.enabled));
  const clicked = (id: string) => stored.clicked.includes(id);
  const out: FirstStep[] = [
    { id: "note", title: "fs.note", text: "fs.noteText", command: "new_page", done: written },
    { id: "today", title: "fs.today", text: "fs.todayText", command: "daily_note", done: daily },
    { id: "task", title: "fs.task", text: "fs.taskText", done: clicked("task") },
  ];
  if (!calendar) out.push({ id: "calendar", title: "fs.calendar", text: "fs.calendarText", done: false });
  else if (s && timeTrackingOn(s)) out.push({ id: "time", title: "fs.time", text: "fs.timeText", done: clicked("time") });
  else if (view && aiOn(view))
    out.push(usableProvider(view) ? { id: "ai", title: "fs.ai", text: "fs.aiText", command: "assistant", done: clicked("ai") } : { id: "aiSetup", title: "fs.aiSetup", text: "fs.aiSetupText", done: clicked("aiSetup") });
  return out;
}

