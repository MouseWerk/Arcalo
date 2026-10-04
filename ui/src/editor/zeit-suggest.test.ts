import { describe, expect, it } from "vitest";
import { confidenceLabel, lacksReference, rankLeistungsarten, rankRefs, recentRefs, referenceOffset, refOptions, remainingHint, zeitToken } from "./zeit-suggest";
import type { ProjectTree } from "../lib/types";

describe("zeitToken", () => {
  it("completes the reference right after /zeit", () => {
    expect(zeitToken("/zeit ")).toEqual({ kind: "ref", query: "", from: 6 });
    expect(zeitToken("/zeit NP-88")).toEqual({ kind: "ref", query: "NP-88", from: 6 });
    expect(zeitToken("  /Time  np")).toEqual({ kind: "ref", query: "np", from: 9 });
  });
  it("completes a Leistungsart after #", () => {
    expect(zeitToken("/zeit NP-8801/1020 1h #")).toEqual({ kind: "la", query: "", from: 22 });
    expect(zeitToken("/zeit NP-8801/1020 1h #de")).toEqual({ kind: "la", query: "de", from: 22 });
  });
  it("does not complete a duration typed as first argument", () => {
    for (const t of ["/zeit 1:30", "/zeit 2h", "/zeit 1,5h", "/zeit 90min", "/zeit 1.5std", "/zeit 1h30m", "/time 2hrs", "/zeit 1,5stunden", "/zeit 9:00-10:30", "/zeit 9.15–10.00"]) expect(zeitToken(t), t).toBeNull();
    expect(zeitToken("/zeit 1:30 text")).toBeNull();
    expect(zeitToken("/zeit 1")).toEqual({ kind: "ref", query: "1", from: 6 });
    expect(zeitToken("/zeit 1:30 #de")).toEqual({ kind: "la", query: "de", from: 11 });
  });
  it("stays quiet elsewhere", () => {
    for (const t of ["/zeit", "/zeitNP", "zeit NP", "text /zeit NP", "/zeit NP-8801 ", "/zeit NP-8801 1.5h", "/zeit NP 1h #DEV Text"]) expect(zeitToken(t), t).toBeNull();
  });
});

const wbs: ProjectTree[] = [
  {
    id: 1,
    project_code: "PRJ-2026-X",
    name: "Rollout",
    created_at: "",
    netzplaene: [
      {
        id: 10,
        project_id: 1,
        netzplan_nr: "NP-8801",
        wbs_element: "NP-8801-1020",
        description: "Integration",
        planned_hours: 40,
        vorgaenge: [
          { id: 100, netzplan_id: 10, vorgang_nr: "1010", description: "Konzept", duration_days: 1, planned_hours: 8, remaining_hours: null, predecessors: [] },
          { id: 101, netzplan_id: 10, vorgang_nr: "1020", description: "Systemintegration", duration_days: 1, planned_hours: 16, remaining_hours: null, predecessors: [] },
          { id: 102, netzplan_id: 10, vorgang_nr: "1040", description: "Test und Übergabe", duration_days: 1, planned_hours: 4, remaining_hours: null, predecessors: [] },
        ],
      },
      { id: 11, project_id: 1, netzplan_nr: "NP-8802", wbs_element: "NP-8802-2010", description: "Schulung", planned_hours: 8, vorgaenge: [] },
    ],
  },
];

describe("refOptions / rankRefs", () => {
  const booked: Record<string, number> = { "NP-8801/1020": 3.5, "NP-8801/1040": 5 };
  const opts = refOptions(wbs, (r) => booked[r] ?? null);
  const refs = (q: string, recent: string[] = []) => rankRefs(opts, q, recent).map((o) => o.ref);

  it("lists Vorgänge, and Netzpläne without Vorgänge", () => {
    expect(opts.map((o) => o.ref)).toEqual(["NP-8801/1010", "NP-8801/1020", "NP-8801/1040", "NP-8802"]);
    expect(opts[1]).toMatchObject({ title: "Systemintegration", project: "PRJ-2026-X · Rollout", planned: 16, booked: 3.5 });
  });
  it("filters by reference, description (umlaut-tolerant) and loose spelling", () => {
    expect(refs("NP-88")).toEqual(["NP-8801/1010", "NP-8801/1020", "NP-8801/1040", "NP-8802"]);
    expect(refs("1020")).toEqual(["NP-8801/1020"]);
    expect(refs("system")).toEqual(["NP-8801/1020"]);
    expect(refs("uebergabe")).toEqual(["NP-8801/1040"]);
    expect(refs("np8802")).toEqual(["NP-8802"]);
    expect(refs("schulung")).toEqual(["NP-8802"]);
    expect(refs("rollout konzept")).toEqual(["NP-8801/1010"]);
    expect(refs("gibtsnicht")).toEqual([]);
  });
  it("puts recently used references first", () => {
    expect(refs("", ["NP-8802", "np-8801/1040"])).toEqual(["NP-8802", "NP-8801/1040", "NP-8801/1010", "NP-8801/1020"]);
    expect(refs("NP-8801", ["NP-8802", "NP-8801/1040"])).toEqual(["NP-8801/1040", "NP-8801/1010", "NP-8801/1020"]);
  });
  it("derives recent references from entries", () => {
    const e = (netzplan_nr: string, vorgang_nr: string | null, start_time: string) => ({ netzplan_nr, vorgang_nr, start_time });
    expect(
      recentRefs([e("NP-8801", "1020", "2026-09-20T08:00:00Z"), e("NP-8802", null, "2026-09-22T08:00:00Z"), e("NP-8801", "1020", "2026-09-23T08:00:00Z"), e("NP-8801", "1010", "2026-09-01T08:00:00Z")]),
    ).toEqual(["NP-8801/1020", "NP-8802", "NP-8801/1010"]);
  });
  it("shows remaining plan hours", () => {
    const fmt = (h: number) => h.toFixed(1);
    expect(remainingHint(opts[1], fmt)).toBe("12.5 h offen");
    expect(remainingHint(opts[2], fmt)).toBe("1.0 h über Plan");
    expect(remainingHint(opts[0], fmt)).toBeUndefined();
  });
});

describe("rankLeistungsarten", () => {
  const las: [string, string][] = [
    ["CONSULTING", "Beratung"],
    ["DEV", "Entwicklung"],
    ["PM", "Projektmanagement"],
    ["TEST", "Test und Qualitätssicherung"],
  ];
  it("matches code prefix first, then description", () => {
    expect(rankLeistungsarten(las, "").map(([c]) => c)).toEqual(["CONSULTING", "DEV", "PM", "TEST"]);
    expect(rankLeistungsarten(las, "de").map(([c]) => c)).toEqual(["DEV"]);
    expect(rankLeistungsarten(las, "te").map(([c]) => c)).toEqual(["TEST"]);
    expect(rankLeistungsarten(las, "ber").map(([c]) => c)).toEqual(["CONSULTING"]);
    expect(rankLeistungsarten(las, "qualitaet").map(([c]) => c)).toEqual(["TEST"]);
  });
});

describe("smart /zeit helpers", () => {
  it("detects lines without reference", () => {
    expect(lacksReference("/zeit 2h habe am Interface-Mapping gearbeitet")).toBe(true);
    expect(lacksReference("  /time 1:30 Review")).toBe(true);
    expect(lacksReference("/zeit 90min")).toBe(true);
    // Every duration the core understands, and a time span.
    for (const l of ["/zeit 1h30m Abstimmung", "/time 90mins review", "/zeit 2std. Doku", "/zeit 08:00-09:15 Daily"]) expect(lacksReference(l), l).toBe(true);
    expect(lacksReference("/zeit NP-8801-1020 1h x")).toBe(false);
    expect(lacksReference("/zeit NP-8801/1020 2h x")).toBe(false);
    expect(lacksReference("/zeit Mapping 2h")).toBe(false);
    expect(lacksReference("zeit 2h x")).toBe(false);
  });

  it("finds where the reference goes and labels confidence", () => {
    expect(referenceOffset("/zeit 2h x")).toBe(6);
    expect(referenceOffset("/zeit   2h x")).toBe(8);
    expect(referenceOffset("2h x")).toBe(-1);
    expect([0.9, 0.6, 0.2].map(confidenceLabel)).toEqual(["sicher", "wahrscheinlich", "unsicher"]);
  });
});
