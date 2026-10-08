import { afterEach, describe, expect, it } from "vitest";
import { applyBootAppearance } from "./prefs";

const KEY = "arcalo.boot-appearance";
const boot = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ data: { density: "compact", uiFont: "system", theme: "dark", themeId: "nord" }, timeOff: true, css: ":root:root { --bg: #000; }", mode: "dark", dark: true, ...over });

afterEach(() => {
  localStorage.removeItem(KEY);
  document.getElementById("arcalo-theme")?.remove();
  for (const k of ["density", "uiFont", "theme", "themeId"]) delete document.documentElement.dataset[k];
  document.documentElement.removeAttribute("data-time-off");
});

describe("appearance of the last start", () => {
  it("is applied before the settings arrive", () => {
    localStorage.setItem(KEY, boot());
    applyBootAppearance();
    const root = document.documentElement;
    expect(root.dataset.density).toBe("compact");
    expect(root.dataset.themeId).toBe("nord");
    expect(root.hasAttribute("data-time-off")).toBe(true);
    expect(document.getElementById("arcalo-theme")?.textContent).toContain("--bg: #000");
  });

  it("leaves the theme to the settings when „System“ now resolves the other way", () => {
    // happy-dom reports a light system scheme.
    localStorage.setItem(KEY, boot({ mode: "system", dark: true }));
    applyBootAppearance();
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.themeId).toBeUndefined();
    expect(document.getElementById("arcalo-theme")).toBeNull();
  });

  it("ignores nothing or garbage", () => {
    applyBootAppearance();
    localStorage.setItem(KEY, "{nope");
    applyBootAppearance();
    expect(document.documentElement.dataset.density).toBeUndefined();
  });
});
