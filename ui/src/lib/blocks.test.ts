import { describe, expect, it } from "vitest";
import { PAGE_MIME, PLAN_MIME, blockIdOf, blockKey, blockMinutes, canPlan, dropRange, itemTitle, linkOf, minuteAt, moved, plannedMinutes, readPlanData, resized, snapMinutes } from "./blocks";

const data = (m: Record<string, string>) => ({ getData: (k: string) => m[k] ?? "" });

describe("focus blocks", () => {
  it("snaps drops to quarter hours inside the day", () => {
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    // 48 px per hour: 100 px is 125 minutes → 2:00.
    expect(minuteAt(100, 48)).toBe(120);
    expect(minuteAt(-20, 48)).toBe(0);
    expect(minuteAt(48 * 24 + 10, 48)).toBe(24 * 60 - 15);
    const day = new Date(2026, 9, 5, 12);
    const r = dropRange(day, 9 * 60 + 7, 60);
    expect([r.start.getHours(), r.start.getMinutes(), r.end.getHours(), r.end.getMinutes()]).toEqual([9, 0, 10, 0]);
    // Late drops are pulled back so the block ends at midnight.
    const late = dropRange(day, 23 * 60 + 30, 60);
    expect([late.start.getHours(), late.start.getMinutes(), late.end.getDate()]).toEqual([23, 0, 6]);
  });

  it("moves and resizes on the grid, never shorter than a step", () => {
    const b = { start: "2026-10-05T07:00:00.000Z", end: "2026-10-05T08:00:00.000Z" };
    expect(moved(b, 22)).toEqual({ start: "2026-10-05T07:15:00.000Z", end: "2026-10-05T08:15:00.000Z" });
    expect(moved(b, 0, 1).start).toBe("2026-10-06T07:00:00.000Z");
    // Across the clock change the block keeps its time of day (09:00 → 09:00, one hour later in UTC).
    const fri = { start: "2026-10-23T07:00:00.000Z", end: "2026-10-23T08:30:00.000Z" };
    expect(moved(fri, 0, 3)).toEqual({ start: "2026-10-26T08:00:00.000Z", end: "2026-10-26T09:30:00.000Z" });
    expect(resized(b, 30).end).toBe("2026-10-05T08:30:00.000Z");
    expect(resized(b, -120).end).toBe("2026-10-05T07:15:00.000Z");
  });

  it("sums planned minutes per day, clipped at midnight", () => {
    const day = new Date(2026, 9, 5);
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
    const blocks = [
      { start: at(5, 9), end: at(5, 10, 30) },
      { start: at(5, 23), end: at(6, 1) },
      { start: at(6, 9), end: at(6, 10) },
    ];
    expect(plannedMinutes(blocks, day)).toBe(150);
    expect(plannedMinutes(blocks, new Date(2026, 9, 6))).toBe(120);
  });

  it("reads what was dragged: tasks, issues, sidebar pages", () => {
    const task = { kind: "task" as const, page_id: 3, ordinal: 1, text: "Bericht", page_title: "Projekt" };
    expect(readPlanData(data({ [PLAN_MIME]: JSON.stringify(task) }))).toEqual(task);
    expect(readPlanData(data({ [PAGE_MIME]: "12" }))).toEqual({ kind: "page", page_id: 12 });
    expect(readPlanData(data({ [PLAN_MIME]: "{kaputt" }))).toBeNull();
    expect(readPlanData(data({ "text/plain": "x" }))).toBeNull();
    expect(canPlan(["text/plain", PLAN_MIME])).toBe(true);
    expect(canPlan(["Files"])).toBe(false);
    expect(linkOf(task)).toEqual({ kind: "task", page_id: 3, ordinal: 1, text: "Bericht" });
    expect(linkOf({ kind: "issue", key: "ERP-7" })).toEqual({ kind: "issue", key: "ERP-7" });
    expect(itemTitle({ kind: "issue", key: "ERP-7", summary: "Login" })).toBe("ERP-7 Login");
  });

  it("keys blocks apart from meetings and reads the default length", () => {
    expect(blockKey(4)).toBe("block:4");
    expect(blockIdOf("block:4")).toBe(4);
    expect(blockIdOf("outlook|G1|")).toBeNull();
    expect(blockMinutes(undefined)).toBe(60);
    expect(blockMinutes({ block_minutes: 90 } as never)).toBe(90);
  });
});
