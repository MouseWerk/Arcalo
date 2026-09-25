// Opening the Kalender view on a day or appointment, and the settings on one section, from
// anywhere (the views load lazily, so the request waits here until they read it).

import { api } from "./api";
import { useApp } from "../store/app";

export interface CalendarFocus {
  /** YYYY-MM-DD. */
  date?: string;
  /** Appointment to select. */
  key?: string;
}

let pendingFocus: CalendarFocus | null = null;
let pendingSection: string | null = null;

/** Opens the Kalender tab (on `focus` when given). */
export function openCalendarView(focus?: CalendarFocus) {
  if (focus) pendingFocus = focus;
  useApp.getState().openTab({ kind: "calendar" });
  if (focus) window.dispatchEvent(new CustomEvent("annalo:calendar-focus"));
}

/** The requested day/appointment, once. */
export function takeCalendarFocus(): CalendarFocus | null {
  const f = pendingFocus;
  pendingFocus = null;
  return f;
}

/** Opens the settings on `section` (e.g. `calendar`). */
export function openSettingsSection(section: string) {
  pendingSection = section;
  useApp.getState().openTab({ kind: "settings" });
  window.dispatchEvent(new CustomEvent("annalo:settings-section"));
}

/** „Kalender jetzt synchronisieren“: every active source; failures per source are reported. */
export async function syncCalendarsNow() {
  const s = useApp.getState();
  try {
    const st = await api.calendarSyncNow();
    const active = st.sources.filter((x) => x.enabled);
    const failed = active.filter((x) => x.status?.error);
    if (!active.length) {
      s.toast({ tone: "info", title: "Kein Kalender eingerichtet", detail: "Unter Einstellungen → Kalender Outlook oder einen ICS-Kalender hinzufügen.", action: { label: "Einrichten", run: () => openSettingsSection("calendar") } });
    } else if (failed.length) {
      s.toast({ tone: "warning", title: "Nicht alle Kalender synchronisiert", detail: failed.map((f) => `${f.name}: ${f.status?.error}`).join("\n") });
    } else s.toast({ tone: "success", title: "Kalender synchronisiert" });
  } catch (e) {
    s.error("Kalender nicht synchronisiert", e);
  }
}

/** The requested settings section, once. */
export function takeSettingsSection(): string | null {
  const s = pendingSection;
  pendingSection = null;
  return s;
}
