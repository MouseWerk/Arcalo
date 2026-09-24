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
  [/fade-(left|right)|assistant-scroll/, "mask gradients (only the alpha counts)"],
  [/send-btn|task-check|\.cite:hover|cf-choice\.on|btn-primary|switch-knob|\.check:|theme-card-now|taskList.*checked::after|slide-task > input:checked::after|swatch/, "white on --accent-strong or a color swatch (>= 4.5:1 by construction)"],
  [/^:root, :root\[data-theme="dark"\]$|^body, \.app$/, "print: black on white paper"],
  [/onb-mark|about-mark/, "the app logo"],
  [/beamer/, "the white projector look of presentations"],
  [/slide-drawing|slide-pdf canvas|att-thumb|pdf-embed|pdf-page/, "drawings and PDF pages are white paper"],
  [/^\.opt-\d$/, "the fixed option colors users pick for select properties"],
  [/activity-view/, "category colors of the activity timeline"],
  [/find-hit\.current/, "the current search hit, distinct from --mark"],
  [/\.overlay$/, "dialog scrim"],
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
