import { describe, expect, it } from "vitest";
import { bookedEntry, bookingPrefill, hasSources, keyAction, layoutDay, monthCells, rangeTitle, sourceColor, step, timeRange, unbooked, viewRange, weekLabel } from "./agenda";
import { isoDay } from "./format";
import type { CalendarEvent, CalendarSettings, TimeEntryRow } from "./types";

const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();

function ev(key: string, d: number, h: number, minutes: number, patch: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = new Date(2026, 8, d, h);
  return {
    key,
    source: "outlook",
    uid: key,
    instance: "",
    recurring: false,
    start: start.toISOString(),
    end: new Date(start.getTime() + minutes * 60000).toISOString(),
    all_day: false,
    title: `Termin ${key}`,
    location: "",
    organizer: "",
    attendees: [],
    body: null,
    link: null,
    busy: "busy",
    private: false,
    categories: [],
    skip: false,
    note_page_id: null,
    entry_id: null,
    ...patch,
  };
}

function entry(id: number, d: number, h: number, minutes: number, description: string, status: TimeEntryRow["status_flag"] = "draft"): TimeEntryRow {
  return {
    id,
    netzplan_id: 1,
    vorgang_nr: "1020",
    leistungsart: "PM",
    start_time: at(d, h),
    end_time: null,
    duration_minutes: minutes,
    description,
    status_flag: status,
    source: "manual",
    page_id: null,
    project_code: "PRJ",
    netzplan_nr: "NP-8801",
    wbs_element: "NP-8801-1020",
  } as TimeEntryRow;
}

describe("visible ranges", () => {
  const fri = new Date(2026, 8, 25, 15);
  it("day, week, work week, month and list", () => {
    expect(viewRange("day", fri).days.map(isoDay)).toEqual(["2026-09-25"]);
    const week = viewRange("week", fri, 1);
    expect(week.days.map(isoDay)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]);
    expect(isoDay(week.to)).toBe("2026-09-28");
    expect(viewRange("week", fri, 0).days[0].getDay()).toBe(0);
    expect(viewRange("workweek", fri, 1, [1, 2, 3, 4, 5]).days.map((d) => d.getDate())).toEqual([21, 22, 23, 24, 25]);
    expect(viewRange("workweek", fri, 1, [2, 4]).days.map((d) => d.getDate())).toEqual([22, 24]);
    const month = viewRange("month", fri, 1);
    expect(month.days.length).toBe(42);
    expect(isoDay(month.days[0])).toBe("2026-08-31");
    expect(viewRange("agenda", fri).days.length).toBe(14);
  });
  it("steps and titles", () => {
    expect(isoDay(step("week", fri, 1))).toBe("2026-10-02");
    expect(isoDay(step("month", new Date(2026, 0, 31), 1))).toBe("2026-02-28");
    expect(isoDay(step("day", fri, -1))).toBe("2026-09-24");
    expect(rangeTitle("month", viewRange("month", fri), fri)).toBe("September 2026");
    expect(rangeTitle("workweek", viewRange("workweek", fri, 1), fri)).toBe("21.–25. September 2026");
    expect(rangeTitle("week", viewRange("week", new Date(2026, 8, 30), 1), new Date(2026, 8, 30))).toBe("28. September – 4. Oktober 2026");
    expect(weekLabel(viewRange("week", fri, 1))).toBe("KW 39");
  });
  it("keys", () => {
    expect(keyAction("t")).toEqual({ today: true });
    expect(keyAction("ArrowLeft")).toEqual({ move: -1 });
    expect(keyAction("M")).toEqual({ view: "month" });
    expect(keyAction("w")).toEqual({ view: "week" });
    expect(keyAction("x")).toBeNull();
  });
});

describe("overlap layout", () => {
  const day = new Date(2026, 8, 21);
  it("puts overlapping meetings side by side and keeps separate groups full width", () => {
    const items = [ev("a", 21, 9, 60), ev("b", 21, 9, 30), ev("c", 21, 9, 90), ev("d", 21, 11, 60), ev("e", 21, 10, 60)];
    // b ends 9:30, so e (10:00) reuses a column of the 9:00 group (c runs until 10:30).
    const placed = new Map(layoutDay(items, day).map((p) => [p.item.key, p]));
    expect(placed.get("a")!.cols).toBe(3);
    expect(new Set(["a", "b", "c"].map((k) => placed.get(k)!.col))).toEqual(new Set([0, 1, 2]));
    expect(placed.get("e")!.cols).toBe(3);
    expect(placed.get("e")!.col).not.toBe(placed.get("c")!.col);
    expect(placed.get("d")!.cols).toBe(1);
    expect(placed.get("d")!.top).toBe(11 * 60);
    expect(placed.get("a")!.height).toBe(60);
  });
  it("clips at midnight and gives short items a minimum height", () => {
    const night = ev("n", 20, 23, 120);
    const [p] = layoutDay([night], day);
    expect(p.top).toBe(0);
    expect(p.height).toBe(60);
    expect(p.clippedStart).toBe(true);
    const [short] = layoutDay([ev("s", 21, 8, 5)], day);
    expect(short.height).toBe(20);
    expect(layoutDay([ev("x", 22, 9, 60)], day)).toEqual([]);
  });
  it("back-to-back meetings do not overlap", () => {
    const placed = layoutDay([ev("a", 21, 9, 60), ev("b", 21, 10, 60)], day);
    expect(placed.map((p) => p.cols)).toEqual([1, 1]);
  });
});

describe("month cells", () => {
  it("shows all-day first and folds the rest into „weitere“", () => {
    const days = viewRange("month", new Date(2026, 8, 1), 1).days;
    const list = [ev("a", 21, 9, 60), ev("b", 21, 10, 60), ev("c", 21, 11, 60), ev("d", 21, 12, 60), ev("e", 21, 13, 60), ev("f", 21, 0, 24 * 60, { all_day: true })];
    const cell = monthCells(list, days, 4).get("2026-09-21")!;
    expect(cell.shown.map((e) => e.key)).toEqual(["f", "a", "b"]);
    expect(cell.more).toBe(3);
    expect(cell.all.length).toBe(6);
    const small = monthCells(list.slice(0, 4), days, 4).get("2026-09-21")!;
    expect([small.shown.length, small.more]).toEqual([4, 0]);
    // A two-day event is on both days.
    const two = monthCells([ev("t", 22, 0, 48 * 60, { all_day: true })], days, 4);
    expect([two.get("2026-09-22")!.shown.length, two.get("2026-09-23")!.shown.length, two.get("2026-09-24")!.shown.length]).toEqual([1, 1, 0]);
  });
});

describe("booking", () => {
  it("prefills day, start, length, text and the remembered WBS", () => {
    const e = ev("a", 25, 10, 45, { title: "Jour fixe Änderungen" });
    expect(bookingPrefill(e, null)).toEqual({ day: "2026-09-25", from: "10:00", minutes: 45, description: "Jour fixe Änderungen", netzplanId: null, vorgangNr: null, leistungsart: null });
    const hint = { netzplan_id: 7, vorgang_nr: "1020", leistungsart: "PM", reference: "NP-8801/1020" };
    expect(bookingPrefill(e, hint)).toMatchObject({ netzplanId: 7, vorgangNr: "1020", leistungsart: "PM" });
    const allDay = ev("w", 25, 0, 24 * 60, { all_day: true, title: "Workshop" });
    expect(bookingPrefill(allDay, null, 7.5)).toMatchObject({ from: "09:00", minutes: 450 });
    expect(bookingPrefill(ev("p", 25, 8, 30, { private: true, title: "Privater Termin" }), null).description).toBe("Termin");
  });
  it("knows booked meetings by link or by an overlapping entry with the subject", () => {
    const e = ev("a", 25, 10, 60, { title: "Jour fixe" });
    expect(bookedEntry({ ...e, entry_id: 9 }, [])).toEqual({ id: 9 });
    expect(bookedEntry(e, [entry(1, 25, 10, 60, "jour  FIXE")])?.id).toBe(1);
    expect(bookedEntry(e, [entry(1, 25, 10, 60, "Jour fixe Projekt X")])?.id).toBe(1);
    expect(bookedEntry(e, [entry(1, 25, 12, 60, "Jour fixe")])).toBeNull();
    expect(bookedEntry(e, [entry(1, 25, 10, 60, "Anderes")])).toBeNull();
    expect(bookedEntry(e, [{ ...entry(1, 25, 10, 60, "Jour fixe"), status_flag: "running", duration_minutes: null }])).toBeNull();
  });
  it("offers past, busy, unmarked, unbooked meetings", () => {
    const now = new Date(2026, 8, 25, 12);
    const list = [
      ev("done", 25, 9, 60, { title: "Weekly" }),
      ev("booked", 25, 10, 60, { title: "Review" }),
      ev("later", 25, 14, 60),
      ev("skip", 25, 8, 30, { skip: true }),
      ev("free", 25, 7, 30, { busy: "free" }),
      ev("allday", 25, 0, 24 * 60, { all_day: true }),
    ];
    expect(unbooked(list, [entry(1, 25, 10, 60, "Review")], now).map((e) => e.key)).toEqual(["done"]);
  });
});

describe("helpers", () => {
  const cal: CalendarSettings = { outlook: true, outlook_color: "#2563eb", sources: [{ id: "s1", name: "Team", kind: "url", path: "", color: "#0d9488", enabled: true }], sync_minutes: 15, past_days: 30, future_days: 90, private_details: false, include_body: false, meeting_links: true };
  it("colors, sources and time labels", () => {
    expect(sourceColor("outlook", cal)).toBe("#2563eb");
    expect(sourceColor("ics:s1", cal)).toBe("#0d9488");
    expect(sourceColor("ics:gone", cal)).toBe("var(--accent)");
    expect(hasSources(cal, false)).toBe(true);
    expect(hasSources({ ...cal, sources: [] }, false)).toBe(false);
    expect(hasSources({ ...cal, sources: [] }, true)).toBe(true);
    expect(timeRange(ev("a", 25, 9, 90))).toBe("09:00–10:30");
    expect(timeRange(ev("a", 25, 0, 1440, { all_day: true }))).toBe("ganztägig");
  });
});
