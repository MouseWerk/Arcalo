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
