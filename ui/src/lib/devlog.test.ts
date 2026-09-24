import { describe, expect, it } from "vitest";
import { createThrottle, entriesText, filterEntries, levelTone } from "./devlog";
import type { DevLogEntry } from "./types";

describe("developer log", () => {
  it("drops repeats within 10 s and more than 50 lines a minute", () => {
    let t = 0;
    const allow = createThrottle(() => t);
    expect(allow("a")).toBe(true);
    t = 9_000;
    expect(allow("a")).toBe(false);
    t = 10_000;
    expect(allow("a")).toBe(true);
    const written = Array.from({ length: 80 }, (_, i) => allow(`m${i}`)).filter(Boolean).length;
    expect(written).toBe(48);
    t = 61_000;
    expect(allow("later")).toBe(true);
  });

  const entries: DevLogEntry[] = [
    { time: "2026-09-24T14:05:03.123+02:00", level: "WARN", source: "ai", message: "langsam" },
    { time: "2026-09-24T14:05:01.000+02:00", level: "ERROR", source: "git", message: "push fehlgeschlagen" },
    { time: "", level: "INFO", source: "", message: "fremde Zeile" },
  ];

  it("filters by level and copies oldest first", () => {
    expect(filterEntries(entries, "errors").map((e) => e.source)).toEqual(["git"]);
    expect(filterEntries(entries, "warnings").map((e) => e.source)).toEqual(["ai"]);
    expect(filterEntries(entries, "all")).toHaveLength(3);
    expect(entriesText(entries)).toBe(
      "INFO fremde Zeile\n2026-09-24T14:05:01.000+02:00 ERROR [git] push fehlgeschlagen\n2026-09-24T14:05:03.123+02:00 WARN [ai] langsam",
    );
    expect([levelTone("ERROR"), levelTone("WARN"), levelTone("INFO")]).toEqual(["danger", "warning", "neutral"]);
  });
});
