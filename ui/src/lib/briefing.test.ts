import { describe, expect, it } from "vitest";
import { briefingCounts, briefingSettings, missingLabel, moveSection, nextMeeting, normalizeSections, shows, summaryLines, toggleSection } from "./briefing";
import type { Briefing, BriefingMeeting, BriefingSection } from "./types";

const meeting = (key: string, extra: Partial<BriefingMeeting> = {}): BriefingMeeting => ({
  key,
  source: "ics:a",
  title: key,
  start: "2026-10-02T07:00:00Z",
  end: "2026-10-02T07:30:00Z",
  all_day: false,
  location: "",
  link: null,
  free: false,
  past: false,
  note_page_id: null,
  prep: null,
  ...extra,
});

const briefing = (extra: Partial<Briefing> = {}): Briefing => ({
  date: "2026-10-02",
  workday: true,
  sections: ["ai", "meetings", "tasks", "time"],
  meetings: [meeting("a", { past: true }), meeting("b"), meeting("c", { free: true })],
  next_meeting: "b",
  jira: null,
  tasks: { overdue: [], today: [], overdue_total: 3, today_total: 2 },
  time: { date: "2026-10-01", target_minutes: 480, booked_minutes: 390, missing_minutes: 90, holiday: null, absence: null, half: false },
  private: false,
  summary: null,
  ai_ready: true,
  ...extra,
});

describe("briefing sections", () => {
  it("normalizes: known ones once, missing ones appended", () => {
    const list = normalizeSections([
      { id: "time", on: false },
      { id: "bogus" as never, on: true },
      { id: "time", on: true },
      { id: "ai", on: true },
    ]);
    expect(list.map((s) => `${s.id}:${s.on}`)).toEqual(["time:false", "ai:true", "meetings:true", "tasks:true", "jira:true"]);
    expect(briefingSettings(undefined)).toMatchObject({ mode: "off", notify_time: "" });
    expect(briefingSettings({ mode: "start", notify_time: "08:30", sections: [] }).sections).toHaveLength(5);
  });

  it("moves and toggles", () => {
    const list: BriefingSection[] = normalizeSections([]);
    const up = moveSection(list, "tasks", -1);
    expect(up.map((s) => s.id)).toEqual(["ai", "tasks", "meetings", "jira", "time"]);
    expect(moveSection(list, "ai", -1)).toBe(list);
    expect(moveSection(list, "time", 1)).toBe(list);
    expect(toggleSection(list, "jira", false).find((s) => s.id === "jira")?.on).toBe(false);
    expect(list.find((s) => s.id === "jira")?.on).toBe(true);
  });
});

describe("briefing numbers", () => {
  it("counts work meetings, due tasks, Jira and missing time", () => {
    const b = briefing({ jira: { overdue: [], due: [], blocked: [], overdue_total: 1, due_total: 2, blocked_total: 1 } });
    expect(briefingCounts(b)).toEqual({ meetings: 2, upcoming: 1, tasks: 5, overdue: 3, jira: 4, missing: 90 });
    expect(nextMeeting(b)?.key).toBe("b");
    expect(nextMeeting(briefing({ next_meeting: null }))).toBeNull();
    expect(shows(b, "jira")).toBe(false);
    expect(shows(b, "time")).toBe(true);
    expect(briefingCounts(briefing({ time: null })).missing).toBe(0);
  });

  it("names the last workday of the unbooked hours shortly", () => {
    expect(missingLabel(briefing())).toBe("gestern offen");
    const monday = briefing({ date: "2026-10-05", time: { date: "2026-10-01", target_minutes: 480, booked_minutes: 0, missing_minutes: 480, holiday: null, absence: null, half: false } });
    expect(missingLabel(monday)).toBe("am 01.10. offen");
    expect(missingLabel(briefing({ time: null }))).toBe("");
  });

  it("takes the text's lines without list markers", () => {
    expect(summaryLines("- Angebot heute\n\n* Jour fixe vorbereiten\n1. Stunden buchen\n")).toEqual(["Angebot heute", "Jour fixe vorbereiten", "Stunden buchen"]);
  });
});
