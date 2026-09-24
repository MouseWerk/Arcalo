import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS, CANVAS, accentHex, accentTokens, contrast, ensureContrast, parseHex } from "./color";

describe("colors", () => {
  it("parses hex and presets", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("6366F1")).toEqual([99, 102, 241]);
    expect(parseHex("#12345")).toBeNull();
    expect(accentHex("teal")).toBe("#0d9488");
    expect(accentHex("#ABC")).toBe("#aabbcc");
    expect(accentHex("rot")).toBeNull();
  });

  it("computes WCAG contrast", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  it("moves a color until it has enough contrast", () => {
    const yellow = parseHex("#ffff00")!;
    const white = parseHex("#ffffff")!;
    expect(contrast(yellow, white)).toBeLessThan(2);
    expect(contrast(ensureContrast(yellow, white, 4.5, false), white)).toBeGreaterThanOrEqual(4.5);
  });

  it("accent tokens stay readable for every preset and extreme colors, in both modes", () => {
    const colors = [...ACCENT_PRESETS.map((p) => p.hex), "#ffff00", "#00ffff", "#111111", "#ffffff", "#7f7f7f"];
    for (const hex of colors) {
      for (const mode of ["light", "dark"] as const) {
        const t = accentTokens(hex, mode);
        const canvas = CANVAS[mode];
        expect(contrast(t["--accent-text"], canvas), `${hex} ${mode} text`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t["--accent"], canvas), `${hex} ${mode} accent`).toBeGreaterThanOrEqual(3);
        expect(contrast(t["--accent-strong"], "#ffffff"), `${hex} ${mode} button`).toBeGreaterThanOrEqual(4.5);
        expect(t["--accent-soft"]).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.1/);
      }
    }
  });
});
