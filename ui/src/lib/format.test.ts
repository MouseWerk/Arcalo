import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fmtApprox, fmtDuration, fmtHours, setFormatPrefs } from "./format";
import * as dayreview from "./dayreview";
import * as focus from "./focus";
import { hoursLabel } from "./calendar";
import { fileSize, importProgress, longTimerHours, importSummary, parseDayInput, parseDuration, parseDurationInput, parseGermanNumber, parseTimeInput, versionTimes } from "./format";

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
    expect(importProgress({ done: 0, total: 0 })).toBe("Dateien werden gelesen…");
    // Then the pages are written in batches.
    expect(importProgress({ done: 400, total: 20000, writing: true })).toBe("400 von 20000 Seiten angelegt");
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

describe("durations", () => {
  it("reads /zeit durations like the core", () => {
    for (const [s, m] of [["2,5h", 150], ["2.5std", 150], ["45min", 45], ["1:05", 65], ["1h30m", 90], ["1hr30mins", 90], ["2stunden", 120], ["20minuten", 20], ["90min.", 90], ["1,5Std.", 90]] as const) expect(parseDuration(s), s).toBe(m);
    for (const s of ["", "h", "2x", "1:75", "25h", "0m", "-1h", "2.5", "1h3", "2."]) expect(parseDuration(s), s).toBeNull();
  });
  it("reads typed durations: hours, clock and /zeit units with spaces", () => {
    for (const [s, m] of [["1,5", 90], ["1.5", 90], ["2", 120], ["1:30", 90], ["90m", 90], ["90 min", 90], ["1h 30m", 90], ["1,5 Std.", 90], ["2 hours", 120]] as const) expect(parseDurationInput(s), s).toBe(m);
    for (const s of ["", "abc", "1,5 Tage"]) expect(parseDurationInput(s), s).toBeNull();
  });
});

describe("hours: one format everywhere (q116 V15, T4)", () => {
  it("follows „Stunden als“: decimal with the regional separator or clock time", () => {
    expect(fmtDuration(90)).toBe("1,50 h");
    expect(fmtDuration(0)).toBe("0,00 h");
    expect(fmtDuration(2970)).toBe("49,50 h");
    expect(fmtHours(49.5)).toBe("49,50");
    expect(hoursLabel(450)).toBe("7,50");
    setFormatPrefs({ hours: "clock" });
    expect(fmtDuration(65)).toBe("1:05 h");
    expect(fmtDuration(0)).toBe("0:00 h");
    expect(hoursLabel(450)).toBe("7:30");
    setFormatPrefs({ hours: "decimal", numberFormat: "point" });
    expect(fmtDuration(90)).toBe("1.50 h");
  });

  it("rounds estimates as estimates: minutes under an hour, quarter hours above (q116 R6)", () => {
    setFormatPrefs({ hours: "decimal", numberFormat: "auto", lang: "de" });
    expect(fmtApprox(34)).toBe("35 Min.");
    expect(fmtApprox(3)).toBe("3 Min.");
    expect(fmtApprox(58)).toBe("1,00 h");
    expect(fmtApprox(80)).toBe("1,25 h");
    setFormatPrefs({ hours: "clock" });
    expect(fmtApprox(80)).toBe("1:15 h");
    expect(fmtApprox(34)).toBe("35 Min.");
    setFormatPrefs({ hours: "decimal" });
  });

  it("has no formatter of its own in the reviews and the focus sessions", () => {
    expect(Object.keys(dayreview)).not.toContain("hm");
    expect(Object.keys(dayreview)).not.toContain("hours");
    expect(Object.keys(focus)).not.toContain("hm");
  });

  it("writes no hours by hand („0:45 h“ built from minutes, h1 for hours)", () => {
    const files = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? (e.name === "locales" ? [] : files(p)) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
      });
    const bad: string[] = [];
    for (const f of files(path.resolve(__dirname, ".."))) {
      const src = fs.readFileSync(f, "utf8");
      // `${Math.floor(m / 60)}:${…} h` and h1(minutes / 60): both ignore the setting.
      for (const m of src.matchAll(/`\$\{[^`]*\/ 60[^`]*\}:\$\{[^`]*\} h`|\bh1\([^()]*\/ 60\)|\bh1\(\w+\.\w*hours\)/g)) bad.push(`${path.basename(f)}: ${m[0].slice(0, 80)}`);
    }
    expect(bad).toEqual([]);
  });
});
