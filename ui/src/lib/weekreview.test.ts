import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dayOff, dayProgress, dayShort, daySub, isEmptyWeek, isThisWeek, meetingsByDay, mondayOf, openWeekMeetings, shiftWeek, weekProgress, weekRange, weekSubtitle, weekTimeSub, type WeekDay, type WeekMeeting, type WeekReview } from "./weekreview";
import { setLang } from "./i18n";
import { setFormatPrefs } from "./format";

afterEach(() => {
  setLang("de");
  setFormatPrefs({ lang: "de" });
});

const day = (date: string, patch: Partial<WeekDay> = {}): WeekDay => ({
  date,
  target_minutes: 480,
  booked_minutes: 0,
  running_minutes: 0,
  missing_minutes: 0,
  future: false,
  holiday: null,
  absence: null,
  absence_half: false,
  gaps: [],
  meetings: 0,
  pages: 0,
  tasks_done: 0,
  ...patch,
});

const meeting = (key: string, dayIso: string, state: WeekMeeting["state"] = "booked"): WeekMeeting => ({
  key,
  day: dayIso,
  source: "ics:a",
  title: key,
  start: `${dayIso}T09:00:00Z`,
  end: `${dayIso}T10:00:00Z`,
  all_day: false,
  location: "",
  minutes: 60,
  state,
  entry_id: null,
  note_page_id: null,
});

function review(patch: Partial<WeekReview> = {}): WeekReview {
  return {
    monday: "2026-10-05",
    sunday: "2026-10-11",
    week: 41,
    year: 2026,
    from: "2026-10-04T22:00:00Z",
    to: "2026-10-11T22:00:00Z",
    days: [],
    time: { target_minutes: 2400, target_to_date: 2400, booked_minutes: 1800, running_minutes: 0, missing_minutes: 600, items: [], gaps: 0, gap_minutes: 0 },
    tasks: { done: [], open: [], overdue: [], done_total: 0, open_total: 0, overdue_total: 0, added_total: 0 },
    meetings: [],
    focus: { minutes: 0, sessions: 0, blocks: [], planned_minutes: 0 },
    pages: [],
    pages_total: 0,
    report_page_id: null,
    ...patch,
  };
}

describe("weeks", () => {
  it("run Monday to Sunday whatever the calendar's first day", () => {
    expect(mondayOf("2026-10-05")).toBe("2026-10-05");
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
    expect(mondayOf("2026-10-08")).toBe("2026-10-05");
    setFormatPrefs({ weekStartsOn: 0 });
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
    setFormatPrefs({ weekStartsOn: 1 });
  });

  it("move by weeks over the year and the DST change", () => {
    expect(shiftWeek("2026-10-08", 1)).toBe("2026-10-12");
    expect(shiftWeek("2026-10-08", -1)).toBe("2026-09-28");
    // 25 October: clocks go back; the next Monday is still a Monday.
    expect(shiftWeek("2026-10-19", 1)).toBe("2026-10-26");
    expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
    expect(shiftWeek("2026-03-23", 1)).toBe("2026-03-30");
  });

  it("know the current and the last week", () => {
    const now = new Date(2026, 9, 8, 12);
    expect(isThisWeek("2026-10-05", now)).toBe(true);
    expect(isThisWeek("2026-10-11", now)).toBe(true);
    expect(isThisWeek("2026-10-12", now)).toBe(false);
    expect(weekSubtitle({ monday: "2026-10-05", week: 41 }, now)).toBe("Diese Woche · KW 41 · 5.–11. Oktober 2026");
    // Intl may join the two months with a thin space.
    expect(weekSubtitle({ monday: "2026-09-28", week: 40 }, now).replace(/\s/g, " ")).toBe("Letzte Woche · KW 40 · 28. September – 4. Oktober 2026");
    expect(weekSubtitle({ monday: "2026-09-21", week: 39 }, now)).toBe("KW 39 · 21.–27. September 2026");
  });

  it("name the range in the display language, over a year's end too", () => {
    expect(weekRange("2026-12-28")).toMatch(/^28\. Dez\.? 2026 – 3\. Jan\.? 2027$/);
    setLang("en");
    setFormatPrefs({ lang: "en" });
    expect(weekRange("2026-10-05")).toBe("5–11 October 2026");
    expect(weekSubtitle({ monday: "2026-09-21", week: 39 }, new Date(2026, 9, 8))).toBe("Week 39 · 21–27 September 2026");
  });

  it("label days short", () => {
    expect(dayShort("2026-10-05")).toBe("Mo 5.");
    setFormatPrefs({ lang: "en" });
    expect(dayShort("2026-10-11")).toBe("Sun 11.");
  });
});

describe("numbers", () => {
  it("share of the target, per week and per day", () => {
    expect(weekProgress(review())).toBe(0.75);
    expect(weekProgress(review({ time: { ...review().time, target_minutes: 0, booked_minutes: 30 } }))).toBe(1);
    expect(weekProgress(review({ time: { ...review().time, target_minutes: 0, booked_minutes: 0 } }))).toBe(0);
    expect(dayProgress(day("2026-10-05", { booked_minutes: 600 }))).toBe(1);
    expect(dayProgress(day("2026-10-05", { booked_minutes: 240 }))).toBe(0.5);
  });

  it("days off by holiday or absence", () => {
    expect(dayOff(day("2026-10-05"))).toBeNull();
    expect(dayOff(day("2026-10-03", { holiday: "Tag der Deutschen Einheit", absence: "vacation" }))).toBe("Tag der Deutschen Einheit");
    expect(dayOff(day("2026-10-05", { absence: "vacation" }))).toBe("Urlaub");
    expect(dayOff(day("2026-10-05", { absence: "sick", absence_half: true }))).toBe("Krank (halber Tag)");
    expect(dayOff(day("2026-10-05", { absence: "special" }))).toBe("Abwesend");
  });

  it("meetings grouped by day and the ones still to book", () => {
    const r = review({ meetings: [meeting("a", "2026-10-05"), meeting("b", "2026-10-05", "open"), meeting("c", "2026-10-07", "upcoming")] });
    expect(meetingsByDay(r.meetings).map((g) => [g.day, g.meetings.map((m) => m.key)])).toEqual([
      ["2026-10-05", ["a", "b"]],
      ["2026-10-07", ["c"]],
    ]);
    expect(openWeekMeetings(r).map((m) => m.key)).toEqual(["b"]);
  });

  it("an empty week is empty, a planned block is not", () => {
    const empty = review({ time: { ...review().time, booked_minutes: 0 } });
    expect(isEmptyWeek(empty)).toBe(true);
    expect(isEmptyWeek({ ...empty, focus: { ...empty.focus, blocks: [{ id: 1, title: "x", start: "", end: "", minutes: 60, task_done: null, focus_minutes: 0, booked: false }] } })).toBe(false);
    expect(isEmptyWeek(review())).toBe(false);
  });
});

describe("week headings", () => {
  it("time tracking names its week like the week review (q116 T7)", () => {
    const src = readFileSync(resolve(__dirname, "../views/TimesheetView.tsx"), "utf8");
    expect(src).toMatch(/weekRange\(isoDay\(week\)\)/);
    expect(src).not.toMatch(/dayMonthName\(week\)/);
  });
});

describe("the lines under the days and the week (q116 V14, R5)", () => {
  it("names a workday before the setup neutrally and today's rest as open, not missing", () => {
    setFormatPrefs({ lang: "de", hours: "decimal" });
    const today = "2026-10-09";
    expect(daySub(day("2026-10-05", { target_minutes: 0, before_setup: true }), today)).toBe("vor der Einrichtung");
    expect(daySub(day("2026-10-10", { target_minutes: 0 }), today)).toBe("kein Arbeitstag");
    expect(daySub(day(today), today)).toBe("noch 8,00 h offen");
    expect(daySub(day("2026-10-08", { missing_minutes: 480 }), today)).toBe("8,00 h fehlen");
    expect(daySub(day("2026-10-12", { future: true }), today)).toBe("");
    expect(weekTimeSub({ target_minutes: 2400, booked_minutes: 2970, missing_minutes: 0 })).toBe("Soll erreicht");
    expect(weekTimeSub({ target_minutes: 480, booked_minutes: 0, missing_minutes: 0 })).toBe("noch 8,00 h offen");
    expect(weekTimeSub({ target_minutes: 2400, booked_minutes: 2970, missing_minutes: 480 })).toBe("8,00 h fehlen");
    setLang("en");
    setFormatPrefs({ lang: "en" });
    expect(daySub(day("2026-10-05", { target_minutes: 0, before_setup: true }), today)).toBe("before setup");
  });
});
