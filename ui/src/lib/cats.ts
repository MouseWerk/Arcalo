// Week helpers for the timesheet: gaps against the daily target and a CATS-ready grid.

import { addDays, decimalPoint, isoDay } from "./format";
import type { StatusFlag, TimeEntryRow, TimePrefs } from "./types";
import { t } from "./i18n";

export interface DayGap {
  day: Date;
  bookedMinutes: number;
  missingMinutes: number;
}

/** Whether missing time on day `key` (YYYY-MM-DD) counts at `now`: past days, today once the working day is over
 *  (18:00, as `worktime::day_is_over` in the core counts it for the reviews and the week proposal). */
export function dayIsOver(key: string, now: Date): boolean {
  const today = isoDay(now);
  return key < today || (key === today && now.getHours() >= 18);
}

/** Days of the week that are over ({@link dayIsOver}) and below their target. `targets`: minutes per day from
 * the backend (`day_targets`, `worktime::DayTargets`: weekday targets, holidays, absences, none before the day a
 * new workspace was set up), so every view counts the same gaps. */
export function weekGaps(rows: TimeEntryRow[], week: Date, now: Date, targets: number[]): DayGap[] {
  const out: DayGap[] = [];
  for (let i = 0; i < 7; i++) {
    const day = addDays(week, i);
    const key = isoDay(day);
    const target = targets[i] ?? 0;
    if (!dayIsOver(key, now) || target <= 0) continue;
    const booked = rows
      .filter((r) => r.status_flag !== "running" && isoDay(new Date(r.start_time)) === key)
      .reduce((a, r) => a + (r.duration_minutes ?? 0), 0);
    if (booked < target) out.push({ day, bookedMinutes: booked, missingMinutes: target - booked });
  }
  return out;
}

/** Hundredths of an hour, rounded half up (as the CATS file export rounds). */
const hundredths = (minutes: number) => Math.floor((minutes * 100 + 30) / 60);
const cell = (cents: number, sep: string) => (cents ? `${Math.floor(cents / 100)}${sep}${String(cents % 100).padStart(2, "0")}` : "");

/** The decimal separator of CATS hours (Settings → Zeiterfassung, like the CATS file). */
export function catsDecimalSep(setting: TimePrefs["cats_decimal"]): "," | "." {
  if (setting === "point") return ".";
  if (setting === "number") return decimalPoint() ? "." : ",";
  return ",";
}

/**
 * Tab-separated rows in the layout of the CATS/CAT2 entry grid: one line per
 * Netzplan/Vorgang/Leistungsart, one column per weekday. Pastes straight into
 * SAP GUI or Excel.
 */
export function catsGrid(rows: TimeEntryRow[], week: Date, sep: "," | "." = ","): { text: string; ids: number[] } {
  const keys = Array.from({ length: 7 }, (_, i) => isoDay(addDays(week, i)));
  const lines = new Map<string, { np: string; vg: string; la: string; perDay: number[] }>();
  const ids: number[] = [];
  for (const r of rows) {
    // Exported entries are already in SAP; pasting them again would book them twice.
    if (r.status_flag === "running" || r.status_flag === "exported" || !r.duration_minutes) continue;
    const d = keys.indexOf(isoDay(new Date(r.start_time)));
    if (d < 0) continue;
    const k = `${r.netzplan_nr}\u0000${r.vorgang_nr ?? ""}\u0000${r.leistungsart ?? ""}`;
    const line = lines.get(k) ?? { np: r.netzplan_nr, vg: r.vorgang_nr ?? "", la: r.leistungsart ?? "", perDay: Array(7).fill(0) };
    line.perDay[d] += r.duration_minutes;
    lines.set(k, line);
    ids.push(r.id);
  }
  const sorted = [...lines.values()].sort((a, b) => `${a.np}/${a.vg}/${a.la}`.localeCompare(`${b.np}/${b.vg}/${b.la}`));
  // Two decimals that add up per day: each cell is the rounded running total of its day minus
  // the rounded total before it (three lines of 20 minutes are 0,33 + 0,34 + 0,33, not 0,99).
  const before = Array<number>(7).fill(0);
  const cells = sorted.map((l) =>
    l.perDay.map((m, d) => {
      const cents = hundredths(before[d] + m) - hundredths(before[d]);
      before[d] += m;
      return cell(cents, sep);
    }),
  );
  const text = sorted.map((l, i) => [l.np, l.vg, l.la, ...cells[i]].join("\t")).join("\r\n");
  return { text: text ? text + "\r\n" : "", ids };
}

/** Why an entry cannot be deleted (the core refuses it as well), or null: an exported entry is
 *  already in the time system, a running one is stopped first. */
export function undeletableReason(status: StatusFlag): string | null {
  if (status === "exported") return t("time.reasonExported");
  if (status === "running") return t("time.reasonRunning");
  return null;
}
