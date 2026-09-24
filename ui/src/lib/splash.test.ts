import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("index.html", () => {
  // Tauri adds hashes of inline styles/scripts in index.html to the CSP; browsers then ignore
  // 'unsafe-inline' and block every style the app sets at runtime (accent color, popups).
  it("has no inline <style> or <script> blocks", () => {
    const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) ?? []).toEqual([]);
  });
});
