import { describe as group, expect, it } from "vitest";
import { dayBounds, describe, feedRows, groupOf, presetDays, rowOffsets, visibleRange } from "./activity";
import type { Activity } from "./types";

const base: Activity = {
  id: 1,
  at: "2026-09-22T08:30:00Z",
  kind: "page_edited",
  page_id: 3,
  page_title: "Kickoff",
  page_icon: null,
  entry_id: null,
  netzplan_id: null,
  reference: null,
  project_code: null,
  title: "Kickoff alt",
  detail: "",
  amount: 340,
  count: 5,
  people: [],
};

group("Zeiträume", () => {
  const wed = new Date(2026, 8, 23, 15, 0);
  it("Vorgaben", () => {
    expect(presetDays("today", wed)).toEqual({ from: "2026-09-23", to: "2026-09-23" });
    expect(presetDays("yesterday", wed)).toEqual({ from: "2026-09-22", to: "2026-09-22" });
    expect(presetDays("week", wed)).toEqual({ from: "2026-09-21", to: "2026-09-23" });
    expect(presetDays("last7", wed)).toEqual({ from: "2026-09-17", to: "2026-09-23" });
  });
  it("Tagesgrenzen sind lokale Mitternacht, das Ende exklusiv", () => {
    const b = dayBounds("2026-09-22", "2026-09-22");
    expect(new Date(b.from).getHours()).toBe(0);
    expect(new Date(b.to).getTime() - new Date(b.from).getTime()).toBe(24 * 3600_000);
  });
});

group("Texte", () => {
  it("Seiten mit Änderungen und aktuellem Titel", () => {
    expect(describe(base)).toEqual({ verb: "Seite bearbeitet", title: "Kickoff", detail: "5 Änderungen · ~340 Zeichen" });
    expect(describe({ ...base, page_title: null }).title).toBe("Kickoff alt");
  });
  it("Buchungen und Freigaben", () => {
    const e = { ...base, kind: "entry_created" as const, title: "Review", reference: "NP-8801/1020", amount: 90, detail: "slash" };
    expect(describe(e)).toEqual({ verb: "1,5 h gebucht", title: "Review", detail: "NP-8801/1020 · /zeit" });
    const r = { ...base, kind: "entry_released" as const, title: "3 Einträge", detail: "NP-8801/1020, NP-8801/1030", amount: 240 };
    expect(describe(r)).toEqual({ verb: "3 Einträge freigegeben", title: "NP-8801/1020, NP-8801/1030", detail: "4 h" });
    expect(groupOf("entry_exported")).toBe("time");
    expect(groupOf("focus_session")).toBe("focus");
  });
});

group("Zeitleiste", () => {
  const items: Activity[] = [
    { ...base, id: 3, at: "2026-09-23T10:00:00" },
    { ...base, id: 2, at: "2026-09-23T09:00:00" },
    { ...base, id: 1, at: "2026-09-22T09:00:00" },
  ];
  it("Tageskopf vor den Einträgen", () => {
    const rows = feedRows(items);
    expect(rows.map((r) => (r.type === "day" ? `${r.day}:${r.count}` : r.item.id))).toEqual(["2026-09-23:2", 3, 2, "2026-09-22:1", 1]);
  });
  it("nur sichtbare Zeilen", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...base, id: i, at: "2026-09-23T10:00:00" }));
    const { offsets, total } = rowOffsets(feedRows(many));
    const [a, b] = visibleRange(offsets, total, 5600, 560, 2);
    expect(b - a).toBeLessThan(20);
    expect(offsets[a]).toBeLessThanOrEqual(5600);
    expect(visibleRange([], 0, 0, 500)).toEqual([0, 0]);
  });
});
