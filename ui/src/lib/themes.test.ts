import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contrast } from "./color";
import { BUILTIN_THEMES, contrastChecks, customDef, effectiveAccent, findTheme, isDarkColor, themeCss, themeTokens } from "./themes";
import type { CustomTheme } from "./types";

// Parses "rgb(r g b / a)" or "#rrggbb" over a background into a solid color.
function solid(token: string, bg: string): string {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(token);
  if (!m) return token;
  const b = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  const a = Number(m[4]);
  return "#" + [1, 2, 3].map((i, j) => Math.round(Number(m[i]) * a + b[j] * (1 - a)).toString(16).padStart(2, "0")).join("");
}

describe("color themes", () => {
  it("has unique ids, light and dark versions and 12+ families", () => {
    const ids = BUILTIN_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILTIN_THEMES.filter((t) => t.dark).length).toBeGreaterThanOrEqual(8);
    expect(BUILTIN_THEMES.filter((t) => !t.dark).length).toBeGreaterThanOrEqual(8);
    const families = new Set(BUILTIN_THEMES.map((t) => t.name.replace(/ (Hell|Dunkel|Light|Dark|Latte|Mocha|Dawn)$/, "")));
    expect(families.size).toBeGreaterThanOrEqual(12);
    for (const t of BUILTIN_THEMES) expect(isDarkColor(t.colors.background), t.id).toBe(t.dark);
  });

  it("every theme's own colors are readable: text >= 4.5, muted >= 3 on background and surface", () => {
    for (const t of BUILTIN_THEMES) {
      for (const bg of [t.colors.background, t.colors.surface, t.raised ?? t.colors.background]) {
        expect(contrast(t.colors.text, bg), `${t.id} text on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.colors.muted, bg), `${t.id} muted on ${bg}`).toBeGreaterThanOrEqual(3);
        if (t.text2) expect(contrast(t.text2, bg), `${t.id} text-2 on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("derived tokens keep text, accent and status colors readable in every theme", () => {
    for (const t of BUILTIN_THEMES) {
      const k = themeTokens(t);
      for (const bgKey of ["--bg-canvas", "--bg-sidebar", "--bg-raised", "--bg-overlay"]) {
        const bg = k[bgKey];
        expect(contrast(k["--text"], bg), `${t.id} --text on ${bgKey}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(k["--text-2"], bg), `${t.id} --text-2 on ${bgKey}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(k["--text-3"], bg), `${t.id} --text-3 on ${bgKey}`).toBeGreaterThanOrEqual(3);
      }
      // Selected rows and the hover tint keep the text readable.
      for (const tint of ["--bg-hover", "--bg-current", "--bg-selected"]) {
        expect(contrast(k["--text"], solid(k[tint], k["--bg-sidebar"])), `${t.id} text on ${tint}`).toBeGreaterThanOrEqual(4.5);
      }
      const canvas = k["--bg-canvas"];
      expect(contrast(k["--accent-text"], canvas), `${t.id} accent text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(k["--accent"], canvas), `${t.id} accent`).toBeGreaterThanOrEqual(3);
      expect(contrast(k["--accent-strong"], "#ffffff"), `${t.id} primary button`).toBeGreaterThanOrEqual(4.5);
      for (const s of ["--success", "--warning", "--danger", "--info"]) {
        expect(contrast(k[s], canvas), `${t.id} ${s}`).toBeGreaterThanOrEqual(4.5);
      }
      // Borders are visible, but quieter than text.
      expect(contrast(k["--border-strong"], canvas), `${t.id} border`).toBeGreaterThan(1.15);
      expect(k["color-scheme"]).toBe(t.dark ? "dark" : "light");
    }
  });

  it("code blocks, syntax colors and the violet callout are readable in every theme", () => {
    for (const t of BUILTIN_THEMES) {
      const k = themeTokens(t);
      const code = k["--code-bg"];
      // The block stands out from the page a little (it also has a border).
      expect(contrast(code, k["--bg-canvas"]), `${t.id} code background`).toBeGreaterThanOrEqual(1.04);
      expect(contrast(k["--text"], code), `${t.id} code text`).toBeGreaterThanOrEqual(4.5);
      for (const s of ["--code-keyword", "--code-string", "--code-number", "--code-title", "--code-type", "--code-meta"]) {
        expect(contrast(k[s], code), `${t.id} ${s}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(k["--violet"], k["--bg-canvas"]), `${t.id} --violet`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("tokens.css (the Annalo themes) defines every derived token and keeps the same contrast", () => {
    const css = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");
    const block = (sel: string) => {
      const body = css.slice(css.indexOf(sel)).split("}")[0];
      return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    };
    const derived = Object.keys(themeTokens(BUILTIN_THEMES[0])).filter((key) => key.startsWith("--"));
    for (const [name, k] of [
      ["dark", block(':root[data-theme="dark"] {')],
      ["light", block(':root[data-theme="light"] {')],
    ] as const) {
      for (const key of derived) expect(k[key], `tokens.css ${name} ${key}`).toBeDefined();
      const canvas = k["--bg-canvas"];
      for (const s of ["--text", "--text-2", "--accent-text", "--success", "--warning", "--danger", "--info", "--violet"]) {
        expect(contrast(k[s], canvas), `tokens.css ${name} ${s}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(k["--text-3"], canvas), `tokens.css ${name} --text-3`).toBeGreaterThanOrEqual(3);
      for (const s of ["--code-keyword", "--code-string", "--code-number", "--code-title", "--code-type", "--code-meta"]) {
        expect(contrast(k[s], k["--code-bg"]), `tokens.css ${name} ${s}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("CSS: nothing for Annalo with its own accent, the full set for other themes, accents on top", () => {
    const annalo = findTheme("annalo-dark", undefined, true);
    expect(themeCss(annalo, "theme")).toBe("");
    expect(themeCss(annalo, "indigo")).toBe("");
    expect(themeCss(annalo, "teal")).toMatch(/--accent: #/);
    const nord = findTheme("nord", undefined, true);
    const css = themeCss(nord, "theme");
    expect(css).toContain("--bg-canvas: #2e3440;");
    expect(css).toContain("--text: #eceff4;");
    expect(css.split(":root:root").length).toBe(2);
    // A chosen accent comes after the theme (so it wins).
    const teal = themeCss(nord, "teal");
    expect(teal.split(":root:root").length).toBe(3);
    // High contrast keeps its accent.
    const hc = findTheme("contrast-dark", undefined, true);
    expect(themeCss(hc, "rose")).toBe(themeCss(hc, "theme"));
    expect(effectiveAccent(hc, "rose")).toBe(hc.colors.accent);
    expect(effectiveAccent(nord, "#ff0000")).toBe("#ff0000");
  });

  it("finds custom themes and falls back to Annalo for unknown ids", () => {
    const mine: CustomTheme = { id: "custom-1", name: "Papier", dark: false, colors: { ...BUILTIN_THEMES[0].colors, background: "#fbf8f1" } };
    const a = { custom_themes: [mine] };
    expect(findTheme("custom-1", a, false).name).toBe("Papier");
    expect(findTheme("gibt-es-nicht", a, true).id).toBe("annalo-dark");
    expect(findTheme("gibt-es-nicht", a, false).id).toBe("annalo-light");
    // A custom theme copied from Annalo still gets its CSS (it is not the built-in).
    expect(themeCss(customDef({ ...mine, id: "custom-2" }), "theme")).toContain("--bg-canvas: #fbf8f1;");
  });

  it("custom themes with poor contrast are shown readable and flagged in the editor", () => {
    const poor: CustomTheme = { id: "custom-1", name: "Grau", dark: false, colors: { ...BUILTIN_THEMES[0].colors, text: "#bbbbbb", muted: "#dddddd" } };
    const checks = contrastChecks(poor.colors);
    expect(checks.find((c) => c.key === "text")!.ok).toBe(false);
    expect(checks.find((c) => c.key === "muted")!.ok).toBe(false);
    const k = themeTokens(customDef(poor));
    expect(contrast(k["--text"], k["--bg-canvas"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(k["--text-3"], k["--bg-sidebar"])).toBeGreaterThanOrEqual(3);
    expect(contrastChecks(BUILTIN_THEMES[0].colors).every((c) => c.ok)).toBe(true);
  });
});
