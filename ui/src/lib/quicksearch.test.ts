import { describe, expect, it } from "vitest";
import { KEEP_QUERY_MS, followSelection, keepQuery, quickItems, snippetHtml, type QsContext } from "./quicksearch";
import type { Page, SearchHit } from "./types";

const page = (id: number, title: string): Page => ({ id, title, parent_id: null, icon: null, position: 0, updated_at: "2026-09-20T10:00:00Z", favorite: false, daily_date: null });
const ctx = (over: Partial<QsContext> = {}): QsContext => ({ hits: [], recent: [], timerRunning: false, lastRef: "NP-8801/1020", ...over });

describe("quick search", () => {
  it("shows recent pages and actions without a query", () => {
    const items = quickItems("  ", ctx({ recent: [page(1, "Architektur"), page(2, "Jour fixe")] }));
    expect(items.map((i) => i.id)).toEqual(["page-1", "page-2", "daily", "timer"]);
    expect(items[0].section).toBe("Zuletzt bearbeitet");
    expect(items[3]).toMatchObject({ title: "Timer starten", action: { type: "timer_start" } });
    // No booking yet: nothing to resume. A running timer can be stopped.
    expect(quickItems("", ctx({ lastRef: null })).map((i) => i.id)).toEqual(["daily"]);
    expect(quickItems("", ctx({ timerRunning: true })).at(-1)).toMatchObject({ title: "Timer stoppen", action: { type: "timer_stop" } });
  });

  it("orders page hits, matching actions, passages and time entries, and offers a new page", () => {
    const hits: SearchHit[] = [
      { kind: "note", page_id: 5, title: "Jour fixe", icon: null, snippet: "…der \u0002Timer\u0003 läuft", score: 3 },
      { kind: "page", page_id: 7, title: "Timer-Konzept", icon: "file-text", score: 9 },
      { kind: "note", page_id: 7, title: "Timer-Konzept", icon: "file-text", snippet: "\u0002Timer\u0003 im Tray", score: 2 },
      { kind: "time_entry", id: 3, netzplan_nr: "NP-8801", vorgang_nr: "1020", snippet: "\u0002Timer\u0003 gebaut", score: 1 },
    ];
    const items = quickItems("timer", ctx({ hits }));
    expect(items.map((i) => i.id)).toEqual(["page-7", "timer", "page-5", "te-3", "new"]);
    expect(items[0]).toMatchObject({ section: "Seiten", snippet: "\u0002Timer\u0003 im Tray", action: { type: "page", pageId: 7 } });
    expect(items[2].section).toBe("Inhalte");
    expect(items[3]).toMatchObject({ title: "NP-8801/1020", action: { type: "timesheet" } });
    expect(items[4]).toMatchObject({ title: "Neue Seite „timer“", action: { type: "new_page", title: "timer" } });
    // An exact title match needs no „Neue Seite“.
    expect(quickItems("Timer-Konzept", ctx({ hits })).some((i) => i.id === "new")).toBe(false);
    expect(quickItems("tages", ctx()).map((i) => i.id)).toEqual(["daily", "new"]);
    expect(quickItems("stund", ctx()).map((i) => i.id)).toEqual(["timesheet", "new"]);
  });

  it("turns /zeit into a single booking item", () => {
    const items = quickItems("/zeit NP-8801/1020 1h #DEV Review", ctx({ recent: [page(1, "A")] }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Buchen: NP-8801/1020 1h #DEV Review", action: { type: "zeit", line: "/zeit NP-8801/1020 1h #DEV Review" } });
    expect(quickItems("/zeit", ctx())[0].title).toBe("Buchen: …");
    expect(quickItems("/zeitplan", ctx())[0].id).not.toBe("zeit");
  });

  it("keeps the last query for 60 seconds", () => {
    expect(keepQuery(null, 1000)).toBe(false);
    expect(keepQuery(1000, 1000 + KEEP_QUERY_MS)).toBe(true);
    expect(keepQuery(1000, 1001 + KEEP_QUERY_MS)).toBe(false);
  });

  it("escapes snippets and marks the hits", () => {
    expect(snippetHtml("<b>\u0002a&b\u0003</b>")).toBe("&lt;b&gt;<mark>a&amp;b</mark>&lt;/b&gt;");
  });

  it("keeps the selected item selected when pages found by meaning arrive (R7C-7)", () => {
    const note = (id: number): SearchHit => ({ kind: "note", page_id: id, title: `Seite ${id}`, icon: null, snippet: "x", score: 1 });
    const similar: SearchHit = { kind: "similar", page_id: 9, title: "Ähnlich", icon: null, passage: "y", similarity: 0.8, score: 1 };
    const exact = quickItems("budget", ctx({ hits: [note(1), note(2), note(3), note(4), note(5)] }));
    // The meaning answer keeps the first three exact hits in front and puts its page before the fourth.
    const fused = quickItems("budget", ctx({ hits: [note(1), note(2), note(3), similar, note(4), note(5)] }));
    const sel = exact.findIndex((i) => i.id === "page-4");
    expect(fused[followSelection(exact, sel, fused)].id).toBe("page-4");
    // An item that went away: the same place, in range.
    expect(followSelection(exact, 4, fused.slice(0, 2))).toBe(1);
    expect(followSelection(exact, 2, [])).toBe(0);
  });
});
