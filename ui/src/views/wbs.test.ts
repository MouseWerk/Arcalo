import { describe, expect, it, vi } from "vitest";

const wbs = vi.fn(() => Promise.resolve([]));
const leistungsarten = vi.fn(() => Promise.resolve([["DEV", "Entwicklung"]]));
vi.mock("../lib/api", () => ({ api: { wbs: () => wbs(), leistungsarten: () => leistungsarten() } }));

const { wbsData } = await import("./wbs");

describe("wbsData", () => {
  it("asks once per WBS version for every picker on screen, again after a change or a failure", async () => {
    const a = wbsData(1);
    const b = wbsData(1);
    expect(a).toBe(b);
    expect(await b.las).toEqual([["DEV", "Entwicklung"]]);
    expect([wbs.mock.calls.length, leistungsarten.mock.calls.length]).toEqual([1, 1]);
    wbsData(2);
    expect(wbs.mock.calls.length).toBe(2);
    wbs.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    await wbsData(3).wbs.catch(() => {});
    wbsData(3);
    expect(wbs.mock.calls.length).toBe(4);
  });
});
