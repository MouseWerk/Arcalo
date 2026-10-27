// An effect returns nothing or its cleanup function. `useEffect(() => el.current?.scrollTo(…))`
// returns what the DOM call returns: in Chromium (and so in Android's WebView) the scroll methods
// return a promise, which React then calls as the cleanup when the effect runs again, and the
// screen goes blank („l is not a function“, the phone's Git setup after its first step). DOM calls
// on a ref go in braces.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "locales" ? [] : sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("effects", () => {
  it("return no value of a DOM call on a ref", () => {
    const bad = sources(SRC).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((l, i) => (/use(Layout)?Effect\(\(\) => (?!\{|void\b|\(\) =>)[^;]*\.current\??\.\w+\(/.test(l) ? [`${path.relative(SRC, f)}:${i + 1}: ${l.trim()}`] : [])),
    );
    expect(bad).toEqual([]);
  });
});
