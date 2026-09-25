// „Kalender auswählen“ (Settings → Kalender → Outlook): palette, kind badges and the status
// lines of the calendar rows.

import { relative } from "./format";
import { t, type TKey } from "./i18n";
import type { OutlookCalendarRow, OutlookKind } from "./types";

/** The colors of the calendar palette (the core's `PALETTE`). */
export const CAL_COLORS: { color: string; name: TKey }[] = [
  { color: "#2563eb", name: "olcal.c.blue" },
  { color: "#0d9488", name: "olcal.c.teal" },
  { color: "#9333ea", name: "olcal.c.violet" },
  { color: "#ea580c", name: "olcal.c.orange" },
  { color: "#db2777", name: "olcal.c.pink" },
  { color: "#65a30d", name: "olcal.c.green" },
  { color: "#0891b2", name: "olcal.c.cyan" },
  { color: "#ca8a04", name: "olcal.c.gold" },
];

/** The badge of a calendar that is not in the user's own mailbox. */
export const KIND_LABEL: Partial<Record<OutlookKind, TKey>> = {
  shared: "olcal.kind.shared",
  mailbox: "olcal.kind.mailbox",
  room: "olcal.kind.room",
  group: "olcal.kind.group",
  file: "olcal.kind.file",
};

export type RowTone = "neutral" | "success" | "warning" | "danger" | "busy";

/** The status line of a calendar row: syncing, its error, its meetings, or what discovery knows. */
export function rowStatus(r: OutlookCalendarRow): { tone: RowTone; text: string } {
  if (r.syncing) return { tone: "busy", text: t("olcal.syncing") };
  if (r.enabled && r.status?.error) return { tone: "danger", text: r.status.error };
  if (!r.enabled && r.error) return { tone: "danger", text: r.error };
  if (r.found === false) return { tone: "warning", text: t("olcal.notFound") };
  if (r.enabled && r.status?.synced_at) {
    const when = relative(r.status.synced_at);
    return { tone: "success", text: r.status.events === 1 ? t("olcal.eventsOne", { when }) : t("olcal.events", { n: r.status.events, when }) };
  }
  if (r.enabled) return { tone: "neutral", text: t("olcal.notSynced") };
  if (r.free_busy) return { tone: "neutral", text: t("olcal.freeBusyHint") };
  return { tone: "neutral", text: r.items != null ? t("olcal.items", { n: r.items }) : "" };
}

/** The Outlook status row: one selected calendar as its row says, several counted together. */
export function outlookSummary(rows: OutlookCalendarRow[]): { tone: Exclude<RowTone, "warning">; text: string } | null {
  const on = rows.filter((r) => r.enabled);
  if (!on.length) return null;
  if (on.some((r) => r.syncing)) return { tone: "busy", text: t("olcal.syncing") };
  if (on.length === 1) {
    const s = rowStatus(on[0]);
    return { tone: s.tone === "warning" ? "danger" : s.tone, text: s.text };
  }
  const failed = on.filter((r) => r.status?.error);
  if (failed.length) return { tone: "danger", text: t("olcal.summaryErrors", { k: failed.length, n: on.length }) };
  const synced = on.map((r) => r.status?.synced_at).filter((x): x is string => !!x);
  if (synced.length < on.length) return { tone: "neutral", text: t("olcal.notSynced") };
  const oldest = [...synced].sort()[0];
  const events = on.reduce((n, r) => n + (r.status?.events ?? 0), 0);
  return { tone: "success", text: t("olcal.summary", { n: on.length, m: events, when: relative(oldest) }) };
}
