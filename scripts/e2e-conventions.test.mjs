// The e2e tests reload the page only through the harness: `app.reload()` waits until the new
// document is ready, a bare `location.reload()` or `browser.refresh()` does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../e2e/", import.meta.url).pathname;
// The splash tests reload without waiting on purpose: they look at the page before it is ready.
const allowed = new Set(["lib/harness.js", "tests/27-splash.test.js", "tests/250-branding.test.js"]);

function files(dir, rel = "") {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(path).isDirectory()) return files(path, r);
    return name.endsWith(".js") ? [r] : [];
  });
}

test("e2e tests reload only through app.reload()", () => {
  const found = [];
  for (const rel of files(root)) {
    if (allowed.has(rel)) continue;
    readFileSync(join(root, rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/location\.reload\(|browser\.refresh\(/.test(line)) found.push(`e2e/${rel}:${i + 1}`);
      });
  }
  assert.deepEqual(found, []);
});
