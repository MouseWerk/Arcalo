import { describe, expect, it } from "vitest";
import { countdown, hm, parseMinutes, phaseProgress, remainingMs, sessionSummary } from "./focus";
import type { FocusDone, FocusSession, FocusState } from "./types";

const session: FocusSession = {
  id: 1,
  netzplan_id: 1,
  vorgang_nr: "1020",
  reference: "NP-8801/1020",
  goal: "Konzept",
  started_at: "2026-09-24T08:00:00Z",
  planned_minutes: 25,
  break_minutes: 5,
  ended_at: null,
  status: "running",
  worked_minutes: 0,
  booked_minutes: 0,
  entry_id: null,
  break_until: null,
};
const t = (iso: string) => new Date(iso).getTime();

describe("Fokus-Countdown", () => {
  const work: FocusState = { session, phase: "work", ends_at: "2026-09-24T08:25:00Z", completed: null };
  it("Rest und Ring", () => {
    expect(remainingMs(work, t("2026-09-24T08:20:00Z"))).toBe(300_000);
    expect(phaseProgress(work, t("2026-09-24T08:12:30Z"))).toBe(0.5);
    expect(phaseProgress(work, t("2026-09-24T09:00:00Z"))).toBe(1);
    const pause: FocusState = { ...work, phase: "break", ends_at: "2026-09-24T08:30:00Z" };
    expect(phaseProgress(pause, t("2026-09-24T08:26:00Z"))).toBeCloseTo(0.2);
  });
  it("Anzeige rundet auf", () => {
    expect(countdown(1)).toBe("00:01");
    expect(countdown(25 * 60_000)).toBe("25:00");
    expect(countdown(3_900_000)).toBe("1:05:00");
    expect(hm(100)).toBe("1:40 h");
  });
  it("eigene Länge", () => {
    expect(parseMinutes("35")).toBe(35);
    expect(parseMinutes("12,5")).toBe(12.5);
    expect(parseMinutes("0")).toBeNull();
    expect(parseMinutes("500")).toBeNull();
    expect(parseMinutes("abc")).toBeNull();
  });
});

describe("Zusammenfassung nach der Sitzung", () => {
  const done = (patch: Partial<FocusSession>, entry = true, extended = false): FocusDone => ({
    session: { ...session, status: "done", worked_minutes: 25, ...patch },
    entry: entry ? { id: 9, netzplan_id: 1, vorgang_nr: "1020", leistungsart: null, start_time: "", end_time: "", duration_minutes: 25, description: "Konzept", status_flag: "draft", source: "timer" } : null,
    extended,
    held: [],
  });
  it("gebucht, mit zurückgehaltenen Hinweisen", () => {
    const s = sessionSummary(done({}), [{ title: "Budget-Warnung: NP-8801" }], [{ title: "Timer läuft noch", body: "" }]);
    expect(s.title).toBe("Pause – 5 Min.");
    expect(s.detail).toBe("0:25 h gebucht auf NP-8801/1020 (Entwurf). 2 Hinweise zurückgehalten: Budget-Warnung: NP-8801 · Timer läuft noch");
  });
  it("verlängert, abgebrochen, ohne Vorgang", () => {
    expect(sessionSummary(done({}, true, true), []).detail).toContain("zur Buchung addiert");
    expect(sessionSummary(done({ status: "aborted" }, false), [])).toEqual({ title: "Fokussitzung beendet", detail: "Nicht gebucht" });
    expect(sessionSummary(done({ reference: "", break_minutes: 0 }, false), []).title).toBe("Fokussitzung geschafft");
  });
});
