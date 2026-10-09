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
  [/send-btn|task-check|qb-check|\.cite:hover|cf-choice\.on|btn-primary|switch-knob|\.check:|taskList.*checked::after|slide-task > input:checked::after|swatch|bm-steps li\.on/, "white on --accent-strong or a color swatch (>= 4.5:1 by construction)"],
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
    it(`${name} sets the mono font without ligatures`, () => {
      // JetBrains Mono's contextual alternates draw „http://“ as „http: //“ and „!==“ as one glyph.
      const odd: string[] = [];
      for (const m of code(name).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/(^|;)\s*font(-family)?:[^;]*var\(--font-mono\)/.test(m[2]) && !/font-variant-ligatures:\s*none/.test(m[2])) odd.push(m[1].trim());
      }
      expect(odd, "add font-variant-ligatures: none").toEqual([]);
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

// Selection, focus and side bars (CLAUDE.md): selected, active and current items are a neutral
// tint with text weight or color, never an accent border, outline, ring or glow; keyboard focus is
// a neutral ring on :focus-visible; nothing has a colored bar at its left side (a plain blockquote
// keeps a thin gray line). A filled control (a checked box) may keep a border in its own fill
// color, and drop targets while dragging may use the accent.
describe("selection and focus look", () => {
  const dir = resolve(__dirname);
  const sheets = readdirSync(dir).filter((f) => f.endsWith(".css") && f !== "tokens.css" && f !== "a11y.css");
  const rules = (name: string) =>
    [...readFileSync(resolve(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1].replace(/\s+/g, " ").trim(),
      decls: m[2]
        .split(";")
        .filter((d) => d.includes(":"))
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as const),
    }));
  const STATE = /\.(active|selected|sel|current|on|checked|picked|now|today|focused|is-selected|is-editing|recording|ProseMirror-selectednode)\b|:checked|:focus(-visible|-within)?\b|\[aria-(selected|current|pressed|checked)/;
  const ACCENT = /--accent(-strong|-soft|-text)?\b/;
  const FRAME = /^(border(-(top|right|bottom|left|inline|block|inline-start|inline-end))?(-color)?|outline(-color)?|box-shadow)$/;
  const DRAG = /drop|drag|\.over\b/;
  const COLORED = /--(accent|success|warning|danger|info|violet|ev|c|c-fill|star|series-\d|cv-c\d)\b|color-mix|#[0-9a-f]{3,8}\b|rgba?\(/i;
  const SIDE = /^border-(left|inline-start)$/;

  for (const name of sheets) {
    it(`${name}: selected, current and focused states have no accent frame`, () => {
      const bad: string[] = [];
      for (const { selector, decls } of rules(name)) {
        if (!STATE.test(selector) || DRAG.test(selector) || /^(@|from|to|\d)/.test(selector)) continue;
        const fill = decls.find(([p]) => p === "background" || p === "background-color")?.[1] ?? "";
        for (const [p, v] of decls) {
          if (!FRAME.test(p) || !ACCENT.test(v)) continue;
          // A filled control: the border is its own fill.
          if (/^border(-color)?$/.test(p) && fill && v === fill) continue;
          bad.push(`${selector} { ${p}: ${v} }`);
        }
      }
      expect(bad, "use --bg-selected/--bg-current and --focus-ring").toEqual([]);
    });

    it(`${name}: no colored bar at the left side`, () => {
      const bad: string[] = [];
      for (const { selector, decls } of rules(name)) {
        if (DRAG.test(selector)) continue;
        const get = (p: string) => decls.find(([q]) => q === p)?.[1] ?? "";
        for (const [p, v] of decls) {
          const line = `${selector} { ${p}: ${v} }`;
          if (/^border-(left|inline-start)(-color)?$/.test(p) && COLORED.test(v)) bad.push(line);
          // A thick side line is a bar even in gray; only blockquotes keep a thin one.
          else if (SIDE.test(p) && /\b([3-9]|\d{2,})px\b/.test(v)) bad.push(line);
          else if (SIDE.test(p) && /\b2px\b/.test(v) && !/blockquote/.test(selector)) bad.push(line);
          // An inset shadow offset sideways draws a bar.
          if (p === "box-shadow" && /inset\s+-?[1-9]\d*(px)?\s+0\b/.test(v)) bad.push(line);
        }
        // A thin pseudo element along the left edge in a color.
        if (/::(before|after)/.test(selector) && get("left") === "0" && /^[1-4]px$/.test(get("width")) && COLORED.test(get("background"))) {
          bad.push(`${selector} (side bar)`);
        }
        // A thin upright element in a color in front of a row (a meeting's calendar color as a bar
        // instead of a dot), sized by itself or by a 1-4 px first grid column. A marker placed
        // inside a chart (the „now“ line of a timeline) is no side bar.
        const marker = get("position") === "absolute" && !/^0(px)?$/.test(get("left") || "0");
        const fill = get("background") || get("background-color");
        const px = (v: string) => (/^\d+(\.\d+)?px$/.test(v) ? parseFloat(v) : null);
        const w = px(get("width")), h = px(get("height"));
        if (!marker && COLORED.test(fill) && h != null && h >= 8 && ((w != null && w <= 4) || (!get("width") && /(bar|stripe|rail|edge)$/.test(selector)))) {
          bad.push(`${selector} (upright bar, use an 8 px dot)`);
        }
        if (/^[1-4]px\b/.test(get("grid-template-columns"))) bad.push(`${selector} { grid-template-columns: ${get("grid-template-columns")} } (a bar column)`);
      }
      expect(bad, "use a tinted background and an icon").toEqual([]);
    });
  }

  for (const name of sheets) {
    it(`${name}: no colored frame marks a state`, () => {
      const bad: string[] = [];
      for (const { selector, decls } of rules(name)) {
        // A slider's thumb is a control filled with its own color.
        if (DRAG.test(selector) || /slider-thumb|range-thumb/.test(selector)) continue;
        for (const [p, v] of decls) {
          // A ring in a signal color (a day under its target outlined in amber): use a tint.
          if (p === "box-shadow" && /inset\s+0(px)?\s+0(px)?\s+0(px)?\s+[1-9]/.test(v) && /--(accent|success|warning|danger|info)\b/.test(v)) bad.push(`${selector} { ${p}: ${v} }`);
        }
      }
      expect(bad, "use a tinted background and text color").toEqual([]);
    });
  }

  // Readable content is not faded with opacity (that drops it below 4.5:1, q116 A8): a state
  // shows by the muted text color and a mark. Opacity stays for disabled controls, icons, drag
  // and loading states and drawn decoration.
  const FADE_OK = [
    /:disabled|\.disabled\b|\.off\b.*(slider|swatch)|\.opacity-slider/,
    /drag|is-loading|\.editing\b/,
    /icon|svg|chevron|caret|crumb-sep|dw-dot|marker|meter|handle|resize|scroll-outline|faint-mark|bm-badge|chip-x/,
    /wc-(bar|slice)|cv-mm|tm-(item|line)|gp-text|dwj-today|writing-bar|dw-size|progress/,
    /btn|button|wm-actions|quick-link-add|vh-toolbar|\.act\b/,
  ];
  for (const name of sheets) {
    it(`${name}: no faded text`, () => {
      const bad: string[] = [];
      for (const { selector, decls } of rules(name)) {
        if (/^(@|from|to|\d)/.test(selector) || FADE_OK.some((re) => re.test(selector))) continue;
        for (const [p, v] of decls) if (p === "opacity" && /^0?\.[0-7]\d*$/.test(v)) bad.push(`${selector} { opacity: ${v} }`);
      }
      expect(bad, "use color: var(--text-3) and a mark instead").toEqual([]);
    });
  }

  it("inline styles in components draw no side bars or accent frames", () => {
    const files = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(resolve(d, e.name)) : /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [resolve(d, e.name)] : []));
    const bad: string[] = [];
    for (const f of files(resolve(dir, ".."))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b(borderLeft\w*|borderInlineStart\w*|outline\w*|boxShadow|borderColor)\s*:\s*([^,}\n]+)/g)) {
        if (/^border(Left|InlineStart)/.test(m[1]) || ACCENT.test(m[2])) bad.push(`${f.slice(dir.length - 6)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("focus and selection tokens are neutral", () => {
    const css = readFileSync(resolve(dir, "tokens.css"), "utf8");
    for (const token of ["--border-focus", "--focus-ring", "--focus-halo", "--focus-soft", "--bg-selected", "--bg-current", "--selected-ring"]) {
      const values = [...css.matchAll(new RegExp(`${token}:\\s*([^;]+);`, "g"))].map((m) => m[1]);
      expect(values.length, token).toBeGreaterThan(0);
      for (const v of values) expect(v, token).not.toMatch(ACCENT);
    }
  });
});
