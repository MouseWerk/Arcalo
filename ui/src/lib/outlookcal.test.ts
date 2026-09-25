import { beforeEach, describe, expect, it } from "vitest";
import { outlookSummary, rowStatus } from "./outlookcal";
import { hiddenCalendars, legendSources, setCalendarHidden, visibleEvents } from "./calvisibility";
import { isSharedCalendar, outlookLabel, sourceColor, sourceName } from "./agenda";
import type { CalendarSettings, CalendarSourceInfo, CalendarStatus, OutlookCalendar, OutlookCalendarRow } from "./types";

const base: OutlookCalendar = { id: "outlook", store_id: "S", entry_id: "D", recipient: "", name: "Kalender", owner: "maurice@firma.de", path: "", kind: "own", default: true, free_busy: false, color: "#2563eb", enabled: true, booking: true };
const row = (p: Partial<OutlookCalendarRow> = {}): OutlookCalendarRow => ({ ...base, stored: true, found: true, items: 12, error: null, shared: false, status: null, syncing: false, ...p });
const synced = (events: number, error: string | null = null) => ({ source: "x", synced_at: error ? null : new Date(Date.now() - 60e3).toISOString(), attempted_at: new Date().toISOString(), error, events });

describe("Kalender auswählen", () => {
  it("each row says how its calendar is doing", () => {
    expect(rowStatus(row({ syncing: true })).tone).toBe("busy");
    expect(rowStatus(row({ status: synced(3) }))).toMatchObject({ tone: "success", text: expect.stringMatching(/^3 Termine · synchronisiert/) });
    expect(rowStatus(row({ status: synced(1) })).text).toMatch(/^1 Termin · /);
    expect(rowStatus(row({ status: synced(0, "Kein Zugriff auf diesen Kalender.") }))).toEqual({ tone: "danger", text: "Kein Zugriff auf diesen Kalender." });
    // Not selected: what discovery knows.
    expect(rowStatus(row({ enabled: false, items: 7 })).text).toBe("7 Elemente");
    expect(rowStatus(row({ enabled: false, items: null, free_busy: true })).text).toMatch(/nur Zeiten/);
    expect(rowStatus(row({ enabled: false, error: "Kein Zugriff" })).tone).toBe("danger");
    expect(rowStatus(row({ found: false })).tone).toBe("warning");
    expect(rowStatus(row()).text).toBe("Noch nicht synchronisiert");
  });

  it("the Outlook status row sums up several calendars", () => {
    expect(outlookSummary([row({ enabled: false })])).toBeNull();
    expect(outlookSummary([row({ status: synced(3) })])?.text).toMatch(/^3 Termine/);
    const two = [row({ status: synced(3) }), row({ id: "outlook:a", default: false, status: synced(5) }), row({ id: "outlook:b", enabled: false })];
    expect(outlookSummary(two)).toMatchObject({ tone: "success", text: expect.stringMatching(/^2 Kalender · 8 Termine · synchronisiert/) });
    two[1] = { ...two[1], status: synced(0, "weg") };
    expect(outlookSummary(two)).toEqual({ tone: "danger", text: "1 von 2 Kalendern mit Fehler" });
  });
});

describe("calendar colors and names", () => {
  const cal: CalendarSettings = {
    outlook: true,
    outlook_color: "#2563eb",
    outlook_calendars: [base, { ...base, id: "outlook:aaa", default: false, name: "Kalender", owner: "Anna Müller", kind: "shared", color: "#db2777", booking: false }, { ...base, id: "outlook:bbb", default: false, name: "Projekt X", color: "#65a30d" }],
    sources: [{ id: "s1", name: "Team", kind: "url", path: "", color: "#0d9488", enabled: true }],
    sync_minutes: 15,
    past_days: 30,
    future_days: 90,
    private_details: false,
    include_body: false,
    meeting_links: true,
  };
  it("every Outlook calendar has its own color and name", () => {
    expect(sourceColor("outlook", cal)).toBe("#2563eb");
    expect(sourceColor("outlook:aaa", cal)).toBe("#db2777");
    expect(sourceColor("outlook:gone", cal)).toBe("var(--accent)");
    expect(sourceName("outlook", cal)).toBe("Outlook");
    expect(sourceName("outlook:aaa", cal)).toBe("Anna Müller – Kalender");
    expect(sourceName("outlook:bbb", cal)).toBe("Projekt X");
    expect(sourceName("ics:s1", cal)).toBe("Team");
    // Settings without the list (older state) still work.
    expect(sourceColor("outlook:aaa", { ...cal, outlook_calendars: undefined })).toBe("var(--accent)");
    expect(isSharedCalendar({ kind: "room" }) && !isSharedCalendar({ kind: "file" })).toBe(true);
    expect(outlookLabel({ name: "Raum Zürich", owner: "Raum Zürich", kind: "room" })).toBe("Raum Zürich");
  });
});

describe("visible calendars", () => {
  beforeEach(() => {
    for (const id of hiddenCalendars()) setCalendarHidden(id, false);
  });
  const ev = (source: string) => ({ source, key: source });
  it("hiding a calendar hides its events in the views and is remembered", () => {
    const events = [ev("outlook"), ev("outlook:aaa"), ev("ics:s1")];
    expect(visibleEvents(events, hiddenCalendars())).toHaveLength(3);
    setCalendarHidden("outlook:aaa", true);
    expect(visibleEvents(events, hiddenCalendars()).map((e) => e.source)).toEqual(["outlook", "ics:s1"]);
    expect(JSON.parse(localStorage.getItem("annalo.calendar.hidden") ?? "[]")).toEqual(["outlook:aaa"]);
    setCalendarHidden("outlook:aaa", false);
    expect(hiddenCalendars().size).toBe(0);
  });
  it("the legend lists the calendars that sync", () => {
    const src = (id: string, enabled: boolean) => ({ id, name: id, enabled }) as CalendarSourceInfo;
    const status = { sources: [src("outlook", true), src("outlook:a", true), src("ics:s1", false)] } as CalendarStatus;
    expect(legendSources(status).map((s) => s.id)).toEqual(["outlook", "outlook:a"]);
    expect(legendSources(null)).toEqual([]);
  });
});
