import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rememberSplash, startSplash } from "./splash";

describe("splash colors", () => {
  it("shows the remembered theme colors and ignores anything that is not a color", () => {
    localStorage.clear();
    // (happy-dom reports itself as automated, which skips the splash.)
    localStorage.setItem("annalo.splash-test", "1");
    rememberSplash({ dark: true, bg: "#242933", text: "#eceff4", muted: "#a3adc2", accent: "#88c0d0" });
    rememberSplash({ off: false });
    const el = document.createElement("div");
    el.id = "splash";
    document.body.appendChild(el);
    startSplash(false);
    expect(el.dataset.theme).toBe("dark");
    expect(el.style.getPropertyValue("--splash-bg")).toBe("#242933");
    expect(el.style.getPropertyValue("--splash-accent")).toBe("#88c0d0");
    expect(el.style.getPropertyValue("--splash-muted")).toBe("#a3adc2");
    el.remove();

    localStorage.setItem("annalo.splash", JSON.stringify({ bg: "red; background: url(x)", accent: "#12345" }));
    const el2 = document.createElement("div");
    el2.id = "splash";
    document.body.appendChild(el2);
    startSplash(false);
    expect(el2.style.getPropertyValue("--splash-bg")).toBe("");
    expect(el2.style.getPropertyValue("--splash-accent")).toBe("");
    el2.remove();
  });
});

describe("index.html", () => {
  // Tauri adds hashes of inline styles/scripts in index.html to the CSP; browsers then ignore
  // 'unsafe-inline' and block every style the app sets at runtime (accent color, popups).
  it("has no inline <style> or <script> blocks", () => {
    const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) ?? []).toEqual([]);
  });
});
