import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EFFECT_TINT, OPACITY_DEFAULT, OPACITY_MIN, glassAlpha, glassComposite, glassCoverage, previewOpacity, setBackdropPrefs } from "./backdrop";
import { contrast } from "./color";
import { BUILTIN_THEMES, customDef, themeTokens } from "./themes";

describe("backdrop opacity", () => {
  it("is a factor between the minimum and 1", () => {
    expect(glassAlpha(80)).toBe(0.8);
    expect(glassAlpha(100)).toBe(1);
    expect(glassAlpha(10)).toBe(OPACITY_MIN / 100);
    expect(glassAlpha(250)).toBe(1);
    expect(glassAlpha(62.4)).toBe(0.62);
    expect(glassAlpha(undefined)).toBe(OPACITY_DEFAULT / 100);
    expect(glassAlpha(Number.NaN)).toBe(OPACITY_DEFAULT / 100);
  });

  it("covers the content more than the chrome, both fully at 100 %", () => {
    expect(glassCoverage(1)).toEqual({ chrome: 1, content: 1 });
    const mid = glassCoverage(0.8);
    expect(mid.chrome).toBe(0.8);
    expect(mid.content).toBeCloseTo(0.96);
    const low = glassCoverage(0.4);
    expect(low.content).toBeCloseTo(0.64);
    for (let p = OPACITY_MIN; p < 100; p += 5) {
      const c = glassCoverage(glassAlpha(p));
      expect(c.content).toBeGreaterThan(c.chrome);
    }
  });

  it("composes like the CSS layers: the theme at 100 %, the effect showing below", () => {
    expect(glassComposite("#ff00ff", "#f5f5f6", 1)).toBe("#f5f5f6");
    expect(glassComposite("#ff00ff", "#f5f5f6", 1, "#ffffff")).toBe("#ffffff");
    // 50 %: halfway between the effect and the sidebar color.
    expect(glassComposite("#000000", "#ffffff", 0.5)).toBe("#808080");
    // The content layer sits on the chrome layer: white at 50 % over it.
    expect(glassComposite("#000000", "#000000", 0.5, "#ffffff")).toBe("#808080");
  });

  // Text colors never change, so they must stay readable over the layers at the lowest opacity,
  // over the effect's own tint (Mica/Acrylic in the theme's light or dark variant; also what
  // Windows shows while the window is inactive).
  const readable = (tokens: Record<string, string>, dark: boolean) => {
    const tint = dark ? EFFECT_TINT.dark : EFFECT_TINT.light;
    const a = glassAlpha(OPACITY_MIN);
    const sidebar = glassComposite(tint, tokens["--bg-sidebar"], a);
    const content = glassComposite(tint, tokens["--bg-sidebar"], a, tokens["--bg-canvas"]);
    return {
      text: Math.min(contrast(tokens["--text"], sidebar), contrast(tokens["--text"], content)),
      muted: Math.min(contrast(tokens["--text-3"], sidebar), contrast(tokens["--text-3"], content)),
    };
  };

  it("keeps text readable in all built-in themes at the lowest opacity", () => {
    expect(BUILTIN_THEMES.length).toBe(20);
    for (const def of BUILTIN_THEMES) {
      const r = readable(themeTokens(def), def.dark);
      expect(r.text, def.id).toBeGreaterThanOrEqual(4.5);
      expect(r.muted, def.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps text readable in custom themes too (light and dark)", () => {
    const light = customDef({ id: "custom-a", name: "Papier", dark: false, colors: { background: "#fbf7ee", surface: "#efe8d8", text: "#2b2b2b", muted: "#8a8170", border: "#ddd3bf", accent: "#b4532a", success: "#2f7d32", warning: "#9a6200", danger: "#b3261e" } });
    const dark = customDef({ id: "custom-b", name: "Nacht", dark: true, colors: { background: "#101826", surface: "#0b111c", text: "#dfe6f2", muted: "#7c8aa3", border: "#1d2940", accent: "#5aa9ff", success: "#4ade80", warning: "#fbbf24", danger: "#f87171" } });
    for (const def of [light, dark]) {
      const r = readable(themeTokens(def), def.dark);
      expect(r.text, def.name).toBeGreaterThanOrEqual(4.5);
      expect(r.muted, def.name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("applying", () => {
  it("sets the opacity live and shows no effect outside the main window", () => {
    const root = document.documentElement;
    previewOpacity(55);
    expect(root.style.getPropertyValue("--glass")).toBe("0.55");
    previewOpacity(5);
    expect(root.style.getPropertyValue("--glass")).toBe("0.4");
    // Quick capture, search and presenter never call initBackdrop: settings change nothing there.
    setBackdropPrefs("mica", 70);
    expect(root.style.getPropertyValue("--glass")).toBe("0.7");
    expect(root.dataset.backdrop).toBeUndefined();
  });
});

describe("backdrop styles", () => {
  const css = readFileSync(resolve(__dirname, "../styles/app.css"), "utf8");
  // The backdrop section only: from its header to the next section header (other features append after it).
  const start = css.indexOf("/* ---- window backdrop");
  const end = css.indexOf("/* ---- ", start + 1);
  const block = css.slice(start, end < 0 ? undefined : end);
  const rule = (selector: string) => {
    const at = block.indexOf(`${selector} {`);
    return at < 0 ? "" : block.slice(at, block.indexOf("}", at));
  };

  it("derives the layers from the theme tokens and the opacity", () => {
    expect(rule(":root[data-backdrop]")).toContain("--glass-chrome: color-mix(in srgb, var(--bg-sidebar) calc(var(--glass) * 100%), transparent)");
    expect(rule(":root[data-backdrop]")).toContain("--glass-content: color-mix(in srgb, var(--bg-canvas) calc(var(--glass) * 100%), transparent)");
  });

  it("paints one base layer on the body, the panels transparent over it (no holes between them)", () => {
    expect(rule(":root[data-backdrop] body")).toContain("background: var(--glass-chrome)");
    const clear = rule(":root[data-backdrop] :is(.app, .ribbon, .sidebar, .panel, .tabbar, .statusbar)");
    expect(clear).toContain("background: transparent");
    expect(rule(":root[data-backdrop] :is(.main, .app.focus .main)")).toContain("background: var(--glass-content)");
    // Nothing in the block paints an opaque theme background again.
    expect(block).not.toMatch(/background:\s*var\(--bg-(app|sidebar|canvas)\)/);
  });
});
