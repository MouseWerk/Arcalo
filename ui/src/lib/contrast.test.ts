// Text contrast over the theme tokens: every text color reaches 4.5:1 (WCAG AA) on every
// surface it is shown on, in all built-in themes (light and dark), with every accent preset,
// and in tokens.css (the Arcalo themes, which the app uses as they are). Tinted rows (hover,
// current, selected) are laid over the surface underneath. Muted text (--text-3: dates,
// counts, hints) reaches 4.5:1 on the plain surfaces and 4:1 on a highlighted row.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACCENT_PRESETS, contrast } from "./color";
import { BUILTIN_THEMES, themeTokens, withAccent } from "./themes";

/** "rgb(r g b / a)" over a solid background; "#rrggbb" as it is. */
function solid(token: string, under: string): string {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(token);
  if (!m) return token;
  const b = [1, 3, 5].map((i) => parseInt(under.slice(i, i + 2), 16));
  const a = Number(m[4]);
  return "#" + [1, 2, 3].map((i, j) => Math.round(Number(m[i]) * a + b[j] * (1 - a)).toString(16).padStart(2, "0")).join("");
}

const SURFACES = ["--bg-canvas", "--bg-sidebar", "--bg-raised", "--bg-overlay", "--bg-input"];
const TINTS = ["--bg-hover", "--bg-current", "--bg-selected", "--accent-soft"];
const TEXT = ["--text", "--text-2", "--accent-text", "--success", "--warning", "--danger", "--info"];

/** Every text/background pair below the minimum, as readable lines. */
function failures(name: string, k: Record<string, string>): string[] {
  const out: string[] = [];
  const check = (fg: string, bgName: string, bg: string, min: number) => {
    const c = contrast(k[fg], bg);
    if (c < min) out.push(`${name}: ${fg} on ${bgName} ${c.toFixed(2)} < ${min}`);
  };
  for (const s of SURFACES) {
    for (const fg of [...TEXT, "--text-3"]) check(fg, s, k[s], 4.5);
    for (const tint of TINTS) {
      const bg = solid(k[tint], k[s]);
      for (const fg of TEXT) check(fg, `${tint} on ${s}`, bg, 4.5);
      check("--text-3", `${tint} on ${s}`, bg, 4);
    }
  }
  // Status badges and banners: the status color on its own soft tint.
  for (const st of ["success", "warning", "danger", "info"]) {
    for (const s of ["--bg-canvas", "--bg-sidebar", "--bg-raised", "--bg-overlay"]) check(`--${st}`, `--${st}-soft on ${s}`, solid(k[`--${st}-soft`], k[s]), 4.5);
  }
  // Primary buttons and switches: white on the strong accent.
  const white = contrast("#ffffff", k["--accent-strong"]);
  if (white < 4.5) out.push(`${name}: white on --accent-strong ${white.toFixed(2)}`);
  // Small solid markers with text: today's date in the calendars, counters (q116 A7).
  check("--on-accent", "--accent-fill", k["--accent-fill"], 4.5);
  // Keyboard focus: the neutral ring 3:1 on every surface and on a current or selected row (A9).
  for (const s of SURFACES) {
    check("--border-focus", s, k[s], 3);
    for (const tint of ["--bg-hover", "--bg-current", "--bg-selected"]) check("--border-focus", `${tint} on ${s}`, solid(k[tint], k[s]), 3);
  }
  return out;
}

describe("text contrast in every theme", () => {
  it("built-in themes with their own accent", () => {
    expect(BUILTIN_THEMES.flatMap((t) => failures(t.id, themeTokens(t)))).toEqual([]);
  });

  it("built-in themes with every accent preset", () => {
    expect(BUILTIN_THEMES.flatMap((t) => ACCENT_PRESETS.flatMap((p) => failures(`${t.id}+${p.id}`, withAccent(t, p.id))))).toEqual([]);
  });

  it("tokens.css (the Arcalo light and dark themes)", () => {
    const css = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");
    const block = (sel: string) => {
      const body = css.slice(css.indexOf(sel)).split("}")[0];
      return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    };
    expect([...failures("tokens.css dark", block(':root[data-theme="dark"] {')), ...failures("tokens.css light", block(':root[data-theme="light"] {'))]).toEqual([]);
  });
});
