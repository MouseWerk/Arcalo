import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrast, mix, parseHex, toHex } from "./color";
import { CAL_PALETTE, SKIPPED_SHARE, TINT_TARGET, blockFit, eventFill, eventTokens, probeColors, worstContrast } from "./eventlook";
import { CAL_COLORS } from "./outlookcal";
import { BUILTIN_THEMES, customDef, themeTokens, type ThemeDef } from "./themes";

const rgb = (hex: string) => parseHex(hex)!;

/** Text and meta text on every probe color's fill, in one theme's derived tokens. */
function check(def: ThemeDef) {
  const k = themeTokens(def);
  const tint = parseFloat(k["--ev-tint"]);
  const colors = probeColors(k["--accent"]);
  // The Kalender's canvas and the start page's raised widgets.
  const bases = [rgb(k["--bg-canvas"]), rgb(k["--bg-raised"])];
  const worst = (fg: string, pct: number) => Math.min(...bases.map((b) => worstContrast(rgb(fg), b, pct, colors)));
  return {
    tint,
    text: worst(k["--text"], tint),
    meta: worst(k["--ev-meta"], tint),
    // Past meetings: half the tint, meta text for the title.
    past: worst(k["--ev-meta"], tint / 2),
    // „nicht buchen“: a neutral fill with a little of the text color.
    skipped: Math.min(...bases.map((b) => contrast(k["--ev-meta"], toHex(mix(b, rgb(k["--text"]), SKIPPED_SHARE / 100))))),
  };
}

const custom = (id: string, dark: boolean, colors: [string, string, string, string, string, string]) =>
  customDef({ id, name: id, dark, colors: { background: colors[0], surface: colors[1], text: colors[2], muted: colors[3], border: colors[4], accent: colors[5], success: "#2f9e44", warning: "#f08c00", danger: "#e03131" } });

describe("meeting colors", () => {
  it("the palette is the core's and the Outlook selection's", () => {
    expect(CAL_PALETTE).toEqual(CAL_COLORS.map((c) => c.color));
  });

  it("mixes like CSS color-mix in srgb", () => {
    expect(eventFill([255, 0, 0], [255, 255, 255], 0)).toEqual([255, 255, 255]);
    expect(eventFill([255, 0, 0], [255, 255, 255], 100)).toEqual([255, 0, 0]);
    expect(eventFill([200, 100, 0], [0, 0, 0], 50)).toEqual([100, 50, 0]);
  });

  it("title and meta text read >= 4.5:1 on the fill of every calendar color in all built-in themes", () => {
    expect(BUILTIN_THEMES.length).toBe(20);
    for (const def of BUILTIN_THEMES) {
      const r = check(def);
      expect(r.text, `${def.id} title`).toBeGreaterThanOrEqual(4.5);
      expect(r.meta, `${def.id} meta`).toBeGreaterThanOrEqual(4.5);
      expect(r.skipped, `${def.id} nicht buchen`).toBeGreaterThanOrEqual(4.5);
      expect(r.past, `${def.id} past`).toBeGreaterThanOrEqual(4.5);
      // The calendar color still shows: never below the floor in the built-in themes.
      expect(r.tint, def.id).toBeGreaterThanOrEqual(def.dark ? 12 : 8);
      expect(r.tint, def.id).toBeLessThanOrEqual(def.dark ? TINT_TARGET.dark : TINT_TARGET.light);
    }
  });

  it("custom themes, also with barely readable text, stay readable", () => {
    const themes = [
      custom("mid-dark", true, ["#3a3f47", "#33373e", "#d0d0d0", "#9a9a9a", "#4a4f57", "#ffd43b"]),
      custom("mid-light", false, ["#d8d8d8", "#cfcfcf", "#3a3a3a", "#5a5a5a", "#bdbdbd", "#0b7285"]),
      custom("faint-dark", true, ["#202020", "#1a1a1a", "#909090", "#6a6a6a", "#333333", "#ff6b6b"]),
      custom("cream", false, ["#fff8e7", "#f5ecd5", "#4a4033", "#7d6f5b", "#e8dcc0", "#e67700"]),
      custom("navy", true, ["#0b1d3a", "#081530", "#e6edf7", "#9fb0cc", "#1c2e4f", "#74c0fc"]),
    ];
    for (const def of themes) {
      const r = check(def);
      expect(r.text, `${def.id} title`).toBeGreaterThanOrEqual(4.5);
      expect(r.meta, `${def.id} meta`).toBeGreaterThanOrEqual(4.5);
      expect(r.skipped, `${def.id} nicht buchen`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tokens.css carries the values the Arcalo themes derive", () => {
    const css = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");
    const block = (sel: string) => css.slice(css.indexOf(sel)).split("}")[0];
    for (const [sel, id] of [
      [':root[data-theme="dark"] {', "arcalo-dark"],
      [':root[data-theme="light"] {', "arcalo-light"],
    ] as const) {
      const k = themeTokens(BUILTIN_THEMES.find((t) => t.id === id)!);
      const body = block(sel);
      expect(body).toContain(`--ev-tint: ${k["--ev-tint"]};`);
      expect(body).toContain(`--ev-meta: ${k["--ev-meta"]};`);
    }
  });

  it("lowers the tint before the title loses contrast, and lifts the meta text", () => {
    // Light text that barely passes on its canvas: hardly any tint is left.
    const r = eventTokens({ canvas: "#202020", text: "#8a8a8a", text2: "#808080", dark: true });
    expect(r.tint).toBeLessThan(12);
    // Meta text that does not read on the fill moves towards the text color.
    const m = eventTokens({ canvas: "#2d353b", text: "#e8dcc0", text2: "#a89f88", dark: true });
    expect(contrast(m.meta, "#a89f88")).toBeGreaterThan(1);
    expect(worstContrast(rgb(m.meta), rgb("#2d353b"), m.tint, probeColors())).toBeGreaterThanOrEqual(4.5);
  });
});

describe("meeting blocks", () => {
  it("short meetings: title and time on one line", () => {
    expect(blockFit(22, 30, true)).toEqual({ oneLine: true, titleLines: 1, time: false, place: false });
    expect(blockFit(16, 15, false).oneLine).toBe(true);
  });

  it("an hour: one title line and the time; longer: more title lines and the place", () => {
    expect(blockFit(46, 60, true)).toEqual({ oneLine: false, titleLines: 1, time: true, place: false });
    expect(blockFit(70, 90, true)).toEqual({ oneLine: false, titleLines: 2, time: true, place: true });
    expect(blockFit(70, 90, false)).toEqual({ oneLine: false, titleLines: 3, time: true, place: false });
    expect(blockFit(94, 120, true).titleLines).toBe(3);
  });

  it("a 45 minute block too small for two lines stays on one", () => {
    expect(blockFit(28, 45, false).oneLine).toBe(true);
  });
});
