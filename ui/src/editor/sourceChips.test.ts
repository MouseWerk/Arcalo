import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chipDiff, retargetChip, sourceChipIds, sourceChips } from "./sourceChips";
import { chipAwaited, chipRemoved, chipReturned, chipsPresent } from "./timeChip";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import type { ChipLink, TimeEntry } from "../lib/types";

vi.mock("../lib/api", async (orig) => {
  const m = await orig<typeof import("../lib/api")>();
  return { ...m, api: { ...m.api, chipDelete: vi.fn(), chipRestore: vi.fn(), chipStates: vi.fn(), timerStatus: vi.fn(async () => null) } };
});

const chip = (id: number, text = "Review", extra = "") => `<time-entry id="${id}" hours="1,50" target="NP-8801/1020"${extra}>${text}</time-entry>`;
const linked = (...ids: number[]) => new Map<number, ChipLink>(ids.map((id) => [id, "linked"]));

describe("chips in the Markdown source", () => {
  it("reads chips as the backend does (attributes unescaped, broken ones skipped)", () => {
    const md = `a ${chip(12, "A &amp; B", ' la="DEV" date="2026-10-02"')} b <time-entry id="13">kaputt <b></time-entry> ${chip(14)}`;
    const found = sourceChips(md);
    expect(found.map((c) => c.id)).toEqual([12, 14]);
    expect(found[0].attrs).toMatchObject({ entryId: "12", hours: "1,50", target: "NP-8801/1020", la: "DEV", date: "2026-10-02", text: "A & B" });
    expect(md.slice(found[1].start, found[1].end)).toBe(chip(14));
    expect(sourceChipIds("ohne Chips")).toEqual(new Set());
  });

  it("finds booked chips whose id is gone, and ids that came back", () => {
    const before = `x ${chip(12)} y ${chip(14)} z ${chip(15, "R", ' state="deleted"')}`;
    // 12 removed, 14 kept, 15 (deleted booking) removed: only the booked one counts.
    const after = `x y ${chip(14)} z`;
    const { removed, appeared } = chipDiff(before, after, linked(12, 14, 15));
    expect(removed.map((c) => c.id)).toEqual([12]);
    expect(appeared).toEqual([]);
    // A copy (second chip of 12) removed while the first stays: nothing to delete.
    expect(chipDiff(`${chip(12)} ${chip(12)}`, `${chip(12)}`, linked(12)).removed).toEqual([]);
    // Not known yet (or another note's booking): never deleted.
    expect(chipDiff(chip(12), "", new Map()).removed).toEqual([]);
    expect(chipDiff(chip(12), "", new Map([[12, "elsewhere"]])).removed).toEqual([]);
    // Moved inside the note: kept.
    expect(chipDiff(`a ${chip(12)}\nb`, `a\nb ${chip(12)}`, linked(12)).removed).toEqual([]);
    expect(chipDiff("", `hier ${chip(12)}`, new Map()).appeared).toEqual([12]);
  });

  it("points a chip at its restored booking's new id", () => {
    const md = `a ${chip(12, "x", ' state="deleted"')} ${chip(12)} ${chip(12)}`;
    expect(retargetChip(md, 12, 40)).toBe(`a ${chip(12, "x", ' state="deleted"')} ${chip(40)} ${chip(12)}`);
    expect(retargetChip("nichts", 12, 40)).toBe("nichts");
  });
});

describe("removing a booked chip", () => {
  const entry = { id: 12, duration_minutes: 90 } as TimeEntry;
  beforeEach(() => {
    vi.useFakeTimers();
    useApp.setState({ toasts: [] } as never);
    vi.mocked(api.chipDelete).mockResolvedValue(entry);
    vi.mocked(api.chipRestore).mockResolvedValue({ ...entry, id: 40 });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("deletes the booking when the toast closes; the chip back restores it (new id passed on)", async () => {
    const putBack = vi.fn();
    chipRemoved(12, { hours: "1,50", target: "NP-8801/1020", text: "Review" }, undefined, putBack);
    expect(chipAwaited(12)).toBe(true);
    await vi.advanceTimersByTimeAsync(6900);
    expect(api.chipDelete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(api.chipDelete).toHaveBeenCalledWith(12);
    const retarget = vi.fn();
    await chipReturned(12, retarget);
    expect(api.chipRestore).toHaveBeenCalledWith(entry);
    expect(retarget).toHaveBeenCalledWith(40);
    expect(chipAwaited(12)).toBe(false);
    expect(putBack).not.toHaveBeenCalled();
  });

  it("keeps the booking of a chip pasted into another open note, and of an exported one", async () => {
    const other = {};
    chipsPresent(other, [12]);
    chipRemoved(12, { hours: "1,50" }, undefined, () => {});
    expect(chipAwaited(12)).toBe(false);
    chipsPresent(other, null);
    chipRemoved(12, { hours: "1,50" }, { status_flag: "exported" } as never, () => {});
    await vi.advanceTimersByTimeAsync(8000);
    expect(api.chipDelete).not.toHaveBeenCalled();
  });

  it("another editor of the same note (a tab kept open behind another one) is not where the chip moved", async () => {
    const sameNote = {};
    chipsPresent(sameNote, [12], 7);
    chipRemoved(12, { hours: "1,50" }, undefined, () => {}, 7);
    expect(chipAwaited(12)).toBe(true);
    expect(useApp.getState().toasts.some((x) => x.key === "chip-12")).toBe(true);
    await vi.advanceTimersByTimeAsync(7100);
    expect(api.chipDelete).toHaveBeenCalledWith(12);
    chipsPresent(sameNote, null);
    await chipReturned(12, () => {});
    // In another note it is a move: the booking goes along.
    const otherNote = {};
    chipsPresent(otherNote, [13], 8);
    chipRemoved(13, { hours: "1,50" }, undefined, () => {}, 7);
    expect(chipAwaited(13)).toBe(false);
    chipsPresent(otherNote, null);
  });

  it("„Rückgängig“ in the toast puts the chip back and keeps the booking", async () => {
    const putBack = vi.fn();
    chipRemoved(12, { hours: "1,50" }, undefined, putBack);
    const toast = useApp.getState().toasts.find((x) => x.key === "chip-12");
    toast?.action?.run();
    expect(putBack).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8000);
    expect(api.chipDelete).not.toHaveBeenCalled();
  });
});
