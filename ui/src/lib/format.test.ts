import { describe, expect, it } from "vitest";
import { fileSize, importProgress, longTimerHours, importSummary, parseDayInput, parseGermanNumber, parseTimeInput, versionTimes } from "./format";

describe("parseGermanNumber", () => {
  const ok: [string, number][] = [
    ["120", 120],
    ["1,5", 1.5],
    ["1.5", 1.5],
    ["1.200,5", 1200.5],
    ["1.200.000", 1200000],
    ["1.234.567,25", 1234567.25],
    [" 42 ", 42],
    [",5", 0.5],
    ["0", 0],
    ["-3,25", -3.25],
  ];
  for (const [s, n] of ok) it(`"${s}" → ${n}`, () => expect(parseGermanNumber(s)).toBe(n));

  for (const s of ["", "abc", "1,2,3", "12.34,5", "1.2.3", "1e3", "12h"]) it(`"${s}" ist ungültig`, () => expect(parseGermanNumber(s)).toBeNull());
});

describe("fileSize", () => {
  it("formats bytes, KB and MB", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(812 * 1024)).toBe("812 KB");
    expect(fileSize(3.4 * 1024 * 1024)).toBe("3,4 MB");
  });
});

describe("versionTimes", () => {
  it("shows seconds only when two versions share a minute, and the date for other days", () => {
    const now = new Date(2026, 8, 24, 16, 0);
    const at = (d: number, h: number, m: number, s: number) => new Date(2026, 8, d, h, m, s).toISOString();
    expect(versionTimes([at(24, 14, 3, 5), at(24, 14, 3, 50), at(24, 9, 7, 0), at(21, 9, 7, 0)], now)).toEqual(["14:03:05", "14:03:50", "09:07", "21.09., 09:07"]);
  });
});

describe("longTimerHours", () => {
  it("flags a timer forgotten over night", () => {
    const now = new Date("2026-09-24T09:00:00Z");
    expect(longTimerHours("2026-09-23T15:00:00Z", now)).toBe(18);
    expect(longTimerHours("2026-09-24T01:00:00Z", now)).toBeNull();
  });
});

describe("importProgress", () => {
  it("counts the files read", () => {
    expect(importProgress({ done: 120, total: 480 })).toBe("120 von 480 Dateien gelesen");
    expect(importProgress({ done: 0, total: 0 })).toBe("Dateien werden gelesen …");
  });
});

describe("importSummary", () => {
  it("uses singular and plural", () => {
    expect(importSummary({ pages: 1, folders: 1, attachments: 1, skipped: 1 })).toBe("1 Seite, 1 Ordner, 1 Bild, 1 Datei übersprungen");
    expect(importSummary({ pages: 12, folders: 3, attachments: 2, skipped: 4 })).toBe("12 Seiten, 3 Ordner, 2 Bilder, 4 Dateien übersprungen");
    expect(importSummary({ pages: 0, folders: 0, attachments: 0, skipped: 0 })).toBe("0 Seiten, 0 Ordner");
  });
});

describe("parseDayInput", () => {
  const now = new Date(2026, 8, 24);
  it("reads German and ISO dates", () => {
    expect(parseDayInput("1.10.2026", now)).toBe("2026-10-01");
    expect(parseDayInput("01.10.26", now)).toBe("2026-10-01");
    expect(parseDayInput("3.2.", now)).toBe("2026-02-03");
    expect(parseDayInput(" 2026-10-01 ", now)).toBe("2026-10-01");
  });
  it("refuses impossible days", () => {
    expect(parseDayInput("31.02.2026", now)).toBeNull();
    expect(parseDayInput("morgen", now)).toBeNull();
    expect(parseDayInput("", now)).toBeNull();
  });
});

describe("parseTimeInput", () => {
  it("reads 24-hour times", () => {
    expect(parseTimeInput("9")).toBe("09:00");
    expect(parseTimeInput("930")).toBe("09:30");
    expect(parseTimeInput("9.30")).toBe("09:30");
    expect(parseTimeInput("17:05")).toBe("17:05");
  });
  it("refuses what is no time", () => {
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("9:75")).toBeNull();
    expect(parseTimeInput("9 Uhr")).toBeNull();
  });
});
