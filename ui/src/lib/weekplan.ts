// „Woche vorschlagen“: the review state of a week proposal – rows the user checks, edits
// (duration, text, WBS) and takes over; totals per day against the target; overlaps.

import type { AcceptedProposal, Proposal, ProposalDay, TimeEntryRow } from "./types";

export interface ReviewRow {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  start: string;
  minutes: number;
  /** As typed in the duration field ("1,5", "1:30"); `minutes` follows it when it parses. */
  duration: string;
  text: string;
  netzplanId: number | null;
  vorgang: string;
  leistungsart: string | null;
  checked: boolean;
  proposal: Proposal;
}

export const wbsKey = (np: number | null, vorgang: string | null | undefined) => (np == null ? "" : `${np}/${(vorgang ?? "").toLowerCase()}`);

/** Rows from a proposal: checked when a WBS was found. */
export function initRows(proposals: Proposal[], fmt: (m: number) => string): ReviewRow[] {
  return proposals.map((p) => ({
    id: p.id,
    date: p.date,
    start: p.start,
    minutes: p.minutes,
    duration: fmt(p.minutes),
    text: p.text,
    netzplanId: p.wbs?.netzplan_id ?? null,
    vorgang: p.wbs?.vorgang_nr ?? "",
    leistungsart: p.wbs?.leistungsart ?? null,
    checked: p.wbs != null,
    proposal: p,
  }));
}

/** Why a row cannot be taken over, or null. */
export function rowProblem(r: ReviewRow): string | null {
  if (r.netzplanId == null) return "Netzplan wählen";
  if (!(r.minutes > 0 && r.minutes <= 24 * 60)) return "Dauer prüfen";
  if (!r.text.trim()) return "Beschreibung fehlt";
  return null;
}

export const selectable = (r: ReviewRow) => rowProblem(r) == null;

export function toggle(rows: ReviewRow[], id: string): ReviewRow[] {
  return rows.map((r) => (r.id === id ? { ...r, checked: !r.checked && selectable(r) } : r));
}

/** Checks (or unchecks) every row of a day, or of the week without `date`; rows that cannot be taken over stay unchecked. */
export function setChecked(rows: ReviewRow[], checked: boolean, date?: string): ReviewRow[] {
  return rows.map((r) => (date == null || r.date === date ? { ...r, checked: checked && selectable(r) } : r));
}

/** A changed field; a row whose change makes it invalid is unchecked, one given a WBS is checked. */
export function edit(rows: ReviewRow[], id: string, patch: Partial<Pick<ReviewRow, "duration" | "text" | "netzplanId" | "vorgang" | "leistungsart">>, parse: (s: string) => number | null): ReviewRow[] {
  return rows.map((r) => {
    if (r.id !== id) return r;
    const next = { ...r, ...patch };
    if (patch.duration != null) next.minutes = parse(patch.duration) ?? 0;
    if (patch.netzplanId != null && r.netzplanId == null) next.checked = true;
    if (!selectable(next)) next.checked = false;
    return next;
  });
}

/** The day's state: all, some or none of its selectable rows checked. */
export function dayState(rows: ReviewRow[], date: string): "all" | "some" | "none" {
  const list = rows.filter((r) => r.date === date && selectable(r));
  const n = list.filter((r) => r.checked).length;
  return n === 0 ? "none" : n === list.length ? "all" : "some";
}

export interface DayTotal {
  date: string;
  workday: boolean;
  target: number;
  booked: number;
  /** Checked rows. */
  selected: number;
  /** Still missing to the target once the checked rows are booked (days that began). */
  gap: number;
  /** Proposed time left out by the target cap. */
  capped: number;
}

export function dayTotals(days: ProposalDay[], rows: ReviewRow[]): DayTotal[] {
  return days.map((d) => {
    const selected = rows.filter((r) => r.date === d.date && r.checked).reduce((a, r) => a + r.minutes, 0);
    return {
      date: d.date,
      workday: d.workday,
      target: d.target_minutes,
      booked: d.booked_minutes,
      selected,
      gap: d.started && d.workday ? Math.max(0, d.target_minutes - d.booked_minutes - selected) : 0,
      capped: d.capped_minutes,
    };
  });
}

const span = (start: string, minutes: number) => {
  const s = new Date(start).getTime();
  return [s, s + minutes * 60000] as const;
};

/** Ids of checked rows that overlap another checked row or an existing booking (after edits). */
export function overlaps(rows: ReviewRow[], entries: TimeEntryRow[]): Set<string> {
  const out = new Set<string>();
  const checked = rows.filter((r) => r.checked && r.minutes > 0);
  const booked = entries
    .filter((e) => e.duration_minutes != null || e.status_flag === "running")
    .map((e) => (e.status_flag === "running" ? ([new Date(e.start_time).getTime(), Date.now()] as const) : span(e.start_time, e.duration_minutes ?? 0)));
  checked.forEach((r, i) => {
    const [a0, a1] = span(r.start, r.minutes);
    if (booked.some(([b0, b1]) => a0 < b1 && b0 < a1)) out.add(r.id);
    checked.forEach((o, j) => {
      if (i === j) return;
      const [b0, b1] = span(o.start, o.minutes);
      if (a0 < b1 && b0 < a1) out.add(r.id);
    });
  });
  return out;
}

/** The checked rows as the command takes them; a WBS other than proposed is learned. */
export function accepted(rows: ReviewRow[]): AcceptedProposal[] {
  return rows
    .filter((r) => r.checked && selectable(r))
    .map((r) => ({
      start: r.start,
      minutes: r.minutes,
      text: r.text.trim(),
      netzplan_id: r.netzplanId!,
      vorgang_nr: r.vorgang || null,
      leistungsart: r.leistungsart || null,
      sources: r.proposal.sources,
      wbs_changed: wbsKey(r.netzplanId, r.vorgang) !== wbsKey(r.proposal.wbs?.netzplan_id ?? null, r.proposal.wbs?.vorgang_nr),
      original_text: r.proposal.text,
    }));
}

/** „Mo 2,5 h“ style list of the days with a gap. */
export function gapSummary(totals: DayTotal[], weekday: (iso: string) => string, fmt: (m: number) => string): string {
  return totals
    .filter((t) => t.gap > 0)
    .map((t) => `${weekday(t.date)} ${fmt(t.gap)} h`)
    .join(", ");
}

/** The next row to focus with the arrow keys. */
export function nextRow(ids: string[], current: string | null, dir: 1 | -1): string | null {
  if (!ids.length) return null;
  const i = current == null ? -1 : ids.indexOf(current);
  if (i < 0) return dir === 1 ? ids[0] : ids[ids.length - 1];
  return ids[Math.min(ids.length - 1, Math.max(0, i + dir))];
}

// ---- opening the panel from anywhere (palette, reminder, card)

let pending = false;
export const OPEN_EVENT = "annalo:week-proposal";

/** Asks the timesheet to open the proposal (it may mount only after this call). */
export function requestWeekProposal() {
  pending = true;
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Takes a pending request (once). */
export function takeWeekProposalRequest(): boolean {
  const p = pending;
  pending = false;
  return p;
}
