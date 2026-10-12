import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rememberSplash, startSplash } from "./splash";

describe("splash colors", () => {
  it("shows the remembered theme colors and ignores anything that is not a color", () => {
    localStorage.clear();
    // (happy-dom reports itself as automated, which skips the splash.)
    localStorage.setItem("arcalo.splash-test", "1");
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

    localStorage.setItem("arcalo.splash", JSON.stringify({ bg: "red; background: url(x)", accent: "#12345" }));
    const el2 = document.createElement("div");
    el2.id = "splash";
    document.body.appendChild(el2);
    startSplash(false);
    expect(el2.style.getPropertyValue("--splash-bg")).toBe("");
    expect(el2.style.getPropertyValue("--splash-accent")).toBe("");
    el2.remove();
  });
});

// The desktop's page and the Android app's own (1.19, mobile.html).
describe.each(["index.html", "mobile.html"])("%s", (page) => {
  // Tauri adds hashes of inline styles/scripts in index.html to the CSP; browsers then ignore
  // 'unsafe-inline' and block every style the app sets at runtime (accent color, popups).
  it("has no inline <style> or <script> blocks", () => {
    const html = readFileSync(resolve(__dirname, "../..", page), "utf8");
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) ?? []).toEqual([]);
  });
});

describe("mobile.html", () => {
  // The phone loads its own entry, never the desktop bundle (q118 A18).
  const read = (f: string) => readFileSync(resolve(__dirname, "../..", f), "utf8");
  it("loads the mobile entry only, with the same start-up animation as index.html", () => {
    const scripts = (html: string) => [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts(read("mobile.html"))).toEqual(["/src/mobile/main.tsx"]);
    expect(read("mobile.html").replace("/src/mobile/main.tsx", "/src/main.tsx")).toBe(read("index.html"));
  });
  it("is the Android window's page, and its entry imports nothing of the desktop app", () => {
    const entry = read("src/mobile/main.tsx");
    expect(entry).not.toMatch(/from "\.\.\/App"|styles\/(app|editor|components|settings|dashboard|prefs|firstrun|workwidgets)\.css/);
    const conf = JSON.parse(read("../src-tauri/tauri.android.conf.json"));
    expect(conf.app.windows[0].url).toBe("mobile.html");
  });
});
