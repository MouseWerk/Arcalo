import { describe, expect, it } from "vitest";
import { accepted, dayState, dayTotals, edit, gapSummary, initRows, nextRow, overlaps, requestWeekProposal, rowProblem, setChecked, takeWeekProposalRequest, toggle } from "./weekplan";
import type { Proposal, ProposalDay, TimeEntryRow } from "./types";

const fmt = (m: number) => (m / 60).toFixed(2).replace(".", ",");
const parse = (s: string) => {
  const v = s.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(v) ? Math.round(+v * 60) : null;
};

function proposal(id: string, date: string, start: string, minutes: number, wbs: [number, string] | null, kind: Proposal["kind"] = "calendar"): Proposal {
  return {
    id,
    date,
    start,
    minutes,
    text: `Text ${id}`,
    kind,
    wbs: wbs && { netzplan_id: wbs[0], vorgang_nr: wbs[1], leistungsart: null, reference: `NP/${wbs[1]}`, confidence: "high", basis: "link", reason: "weil" },
    confidence: wbs ? "high" : "none",
    reason: wbs ? "weil" : "Kein passender Vorgang gefunden",
    sources: [{ kind, id: `src-${id}`, label: `Text ${id}` }],
  };
}

const day = (date: string, booked: number, extra: Partial<ProposalDay> = {}): ProposalDay => ({
  date,
  workday: true,
  target_minutes: 480,
  booked_minutes: booked,
  proposed_minutes: 0,
  gap_minutes: 0,
  capped_minutes: 0,
  started: true,
  ...extra,
});

const P = [
  proposal("a", "2026-09-21", "2026-09-21T07:00:00Z", 60, [1, "1010"]),
  proposal("b", "2026-09-21", "2026-09-21T09:00:00Z", 90, null, "page"),
  proposal("c", "2026-09-22", "2026-09-22T07:00:00Z", 30, [2, "2010"], "focus"),
];

describe("week proposal review", () => {
  it("checks the rows with a WBS and refuses rows without one", () => {
    const rows = initRows(P, fmt);
    expect(rows.map((r) => [r.id, r.checked, r.duration])).toEqual([
      ["a", true, "1,00"],
      ["b", false, "1,50"],
      ["c", true, "0,50"],
    ]);
    expect(rowProblem(rows[1])).toBe("Netzplan wählen");
    // Space on a row without WBS changes nothing; on others it toggles.
    expect(toggle(rows, "b")[1].checked).toBe(false);
    expect(toggle(rows, "a")[0].checked).toBe(false);
    expect(toggle(toggle(rows, "a"), "a")[0].checked).toBe(true);
  });

  it("selects per day and for the week, tri-state per day", () => {
    let rows = initRows(P, fmt);
    expect(dayState(rows, "2026-09-21")).toBe("all");
    rows = setChecked(rows, false, "2026-09-21");
    expect(rows.map((r) => r.checked)).toEqual([false, false, true]);
    expect(dayState(rows, "2026-09-21")).toBe("none");
    rows = edit(rows, "b", { netzplanId: 3, vorgang: "" }, parse);
    expect(rows[1].checked).toBe(true);
    expect(dayState(rows, "2026-09-21")).toBe("some");
    rows = setChecked(rows, true);
    expect(rows.every((r) => r.checked)).toBe(true);
  });

  it("edits duration and text; invalid values uncheck the row", () => {
    let rows = initRows(P, fmt);
    rows = edit(rows, "a", { duration: "1,5" }, parse);
    expect([rows[0].minutes, rows[0].checked]).toEqual([90, true]);
    rows = edit(rows, "a", { duration: "viel" }, parse);
    expect([rows[0].minutes, rows[0].checked, rowProblem(rows[0])]).toEqual([0, false, "Dauer prüfen"]);
    rows = edit(rows, "c", { text: "  " }, parse);
    expect([rows[2].checked, rowProblem(rows[2])]).toEqual([false, "Beschreibung fehlt"]);
  });

  it("totals per day against the target, gaps only on started workdays", () => {
    const rows = initRows(P, fmt);
    const days = [day("2026-09-21", 300), day("2026-09-22", 480), day("2026-09-26", 0, { workday: false, target_minutes: 0 }), day("2026-09-23", 0, { started: false })];
    const t = dayTotals(days, rows);
    expect(t.map((x) => [x.selected, x.gap])).toEqual([
      [60, 120],
      [30, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(gapSummary(t, (d) => (d === "2026-09-21" ? "Mo" : "?"), fmt)).toBe("Mo 2,00 h");
  });

  it("finds overlaps with other rows and existing bookings after edits", () => {
    let rows = initRows(P, fmt);
    const entry = { id: 1, start_time: "2026-09-22T07:15:00Z", duration_minutes: 30, status_flag: "draft" } as TimeEntryRow;
    expect([...overlaps(rows, [entry])]).toEqual(["c"]);
    // 07:00 + 150 minutes reaches into b's 09:00 once b is checked.
    rows = edit(rows, "a", { duration: "2,5" }, parse);
    rows = edit(rows, "b", { netzplanId: 3 }, parse);
    expect([...overlaps(rows, [])].sort()).toEqual(["a", "b"]);
    // Unchecked rows do not count.
    expect([...overlaps(toggle(rows, "b"), [])]).toEqual([]);
  });

  it("hands the checked rows over and marks a changed WBS for learning", () => {
    let rows = initRows(P, fmt);
    rows = edit(rows, "b", { netzplanId: 3, vorgang: "3010", text: "Konzept geschrieben" }, parse);
    rows = edit(rows, "c", { vorgang: "2020" }, parse);
    const out = accepted(rows);
    expect(out.map((x) => [x.netzplan_id, x.vorgang_nr, x.wbs_changed, x.text, x.original_text])).toEqual([
      [1, "1010", false, "Text a", "Text a"],
      [3, "3010", true, "Konzept geschrieben", "Text b"],
      [2, "2020", true, "Text c", "Text c"],
    ]);
    expect(out[1].sources).toEqual([{ kind: "page", id: "src-b", label: "Text b" }]);
    // The same Vorgang in another spelling is no change.
    expect(accepted(edit(initRows(P, fmt), "a", { vorgang: "1010" }, parse))[0].wbs_changed).toBe(false);
    expect(accepted(setChecked(rows, false))).toEqual([]);
  });

  it("moves between rows with the arrow keys", () => {
    const ids = ["a", "b", "c"];
    expect(nextRow(ids, null, 1)).toBe("a");
    expect(nextRow(ids, "a", 1)).toBe("b");
    expect(nextRow(ids, "c", 1)).toBe("c");
    expect(nextRow(ids, "a", -1)).toBe("a");
    expect(nextRow([], "a", 1)).toBe(null);
  });

  it("keeps an open request until the timesheet takes it", () => {
    let seen = 0;
    const on = () => seen++;
    window.addEventListener("annalo:week-proposal", on);
    requestWeekProposal();
    window.removeEventListener("annalo:week-proposal", on);
    expect(seen).toBe(1);
    expect(takeWeekProposalRequest()).toBe(true);
    expect(takeWeekProposalRequest()).toBe(false);
  });
});
