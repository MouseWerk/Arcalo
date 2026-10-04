import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The stylesheets are bundled into one file: an unclosed rule in one of them silently swallows
// every rule after it (a merge once dropped a `}` and took all of prefs.css with it).
describe("stylesheets", () => {
  const dir = resolve(__dirname);
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
    it(`${name} has balanced braces and no merge markers`, () => {
      const css = readFileSync(resolve(dir, name), "utf8");
      expect(css).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
      const code = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
      let depth = 0;
      for (const ch of code) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
    });
  }
});

// Colors come from the theme tokens (tokens.css, lib/themes.ts). A literal color elsewhere is only
// fine where it must not follow the theme; every such place is listed here with its reason.
const LITERAL_COLORS_OK: [RegExp, string][] = [
  [/win-close/, "Windows' own red close button"],
  [/fade-(left|right|top|bottom)|assistant-scroll|tab-title/, "mask gradients (only the alpha counts)"],
  [/send-btn|task-check|qb-check|\.cite:hover|cf-choice\.on|btn-primary|switch-knob|\.check:|theme-card-now|taskList.*checked::after|slide-task > input:checked::after|swatch|bm-steps li\.on/, "white on --accent-strong or a color swatch (>= 4.5:1 by construction)"],
  [/^:root, :root\[data-theme="dark"\]$|^body, \.app$/, "print: black on white paper"],
  [/onb-mark|about-mark/, "the app logo"],
  [/beamer/, "the white projector look of presentations"],
  [/slide-drawing|slide-pdf canvas|att-thumb|pdf-embed|pdf-page|mmd-view/, "drawings, PDF pages and printed diagrams are white paper"],
  [/^\.opt-\d$/, "the fixed option colors users pick for select properties"],
  [/activity-view/, "category colors of the activity timeline"],
  [/find-hit\.current/, "the current search hit, distinct from --mark"],
  [/\.overlay$/, "dialog scrim"],
  [/^\.bm-badge$/, "white letters on the browsers' own colors (bookmark import)"],
];

describe("literal colors", () => {
  const dir = resolve(__dirname);
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".css") && f !== "tokens.css")) {
    it(`${name} uses theme tokens except in the listed places`, () => {
      const css = readFileSync(resolve(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const unexplained: string[] = [];
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = m[1].replace(/\s+/g, " ").trim();
        // Black shadows and scrims are black in every theme.
        const body = m[2].replace(/rgb\(0 0 0 \/ [\d.]+\)/g, "");
        if (!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(body)) continue;
        if (!LITERAL_COLORS_OK.some(([re]) => re.test(selector))) unexplained.push(selector);
      }
      expect(unexplained).toEqual([]);
    });
  }
});

// Non-color design tokens (tokens.css): weights, layers, focus ring, eyebrow labels and pill radii come
// from one place, so a view cannot drift to its own values again.
describe("design tokens", () => {
  const dir = resolve(__dirname);
  const sheets = readdirSync(dir).filter((f) => f.endsWith(".css") && f !== "tokens.css");
  const code = (name: string) => readFileSync(resolve(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const name of sheets) {
    it(`${name} takes weights, layers, focus ring and pill radii from the tokens`, () => {
      const css = code(name);
      expect(css.match(/font-weight:\s*\d{3}\b[^;}]*/g) ?? []).toEqual([]);
      expect(css.match(/z-index:\s*\d{2,}[^;}]*/g) ?? []).toEqual([]);
      expect(css.match(/outline:\s*2px solid var\(--border-focus\)/g) ?? []).toEqual([]);
      expect(css.match(/border-radius:[^;}]*\b999px/g) ?? []).toEqual([]);
    });
    it(`${name} styles uppercase section labels one way`, () => {
      const odd: string[] = [];
      for (const m of code(name).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/text-transform:\s*uppercase/.test(m[2]) && /letter-spacing:\s*0\.04em/.test(m[2])) odd.push(m[1].trim());
      }
      expect(odd, "use var(--ls-eyebrow)").toEqual([]);
    });
  }
});
