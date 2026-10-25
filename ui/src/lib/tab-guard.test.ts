// Fails on a key handler that checks Tab by its name alone: WebKitGTK (Linux) sends Shift+Tab as
// ISO_Left_Tab, whose key is "Unidentified", so such a check misses Shift+Tab there (a focus trap
// lets the focus out, a menu stays open). `isTab(e)` from lib/ime.ts also looks at the code.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "locales" ? [] : sources(p);
    return /\.(tsx|ts)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("Tab handlers", () => {
  it("ask isTab(e) instead of comparing the key name", () => {
    const found: string[] = [];
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel === "lib/ime.ts") continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\.key\s*[!=]==?\s*["']Tab["']|["']Tab["']\s*[!=]==?\s*\w+\.key\b|case\s+["']Tab["']\s*:/.test(line)) found.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(sources(SRC).length).toBeGreaterThan(100);
    expect(found).toEqual([]);
  });
});
