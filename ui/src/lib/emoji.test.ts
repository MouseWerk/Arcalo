// "No emojis anywhere" (CLAUDE.md), checked in
// every text file of the repository (code, tests, docs, workflows, the Android and iOS sources).
// Characters that are text by default (©, ⌘, ⇧, arrows) are fine; emoji-style characters and any
// character followed by the emoji selector U+FE0F are not. Tests that need an emoji in a page
// write it as an escape (`"\u{1F600}"`), which this check does not see.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", ".gradle", ".git", ".vitest", "screenshots"]);
const TEXT = /\.(ts|tsx|js|mjs|cjs|rs|md|json|toml|yml|yaml|html|css|sql|sh|ps1|kt|kts|swift|xml|txt|plist|eml|ics|vcf)$/;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
// U+2705 is the done marker of the Obsidian Tasks format (data, not decoration): the imported
// sample and the notes of the crash it caused quote it as users type it. Only there.
const DONE_MARKER = /\u{2705}/gu;
const QUOTES_DONE_MARKER = ["ui/src/editor/corpus/obsidian-daily.md", "docs/releases/v1.15.1.md", "docs/quality/q116/core-findings.md"];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : files(p);
    return TEXT.test(e.name) || e.name === "CLAUDE.md" ? [p] : [];
  });
}

describe("no emojis", () => {
  it("in any text file of the repository", () => {
    const bad: string[] = [];
    for (const f of QUOTES_DONE_MARKER) expect(fs.existsSync(path.join(ROOT, f)), `listed exception ${f} is gone`).toBe(true);
    for (const f of files(ROOT)) {
      const quotes = QUOTES_DONE_MARKER.includes(path.relative(ROOT, f).split(path.sep).join("/"));
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (EMOJI.test(quotes ? l.replace(DONE_MARKER, "") : l)) bad.push(`${path.relative(ROOT, f)}:${i + 1}: ${l.trim().slice(0, 80)}`);
      });
    }
    expect(bad).toEqual([]);
  }, 30_000);

  it("the check finds emojis and leaves key glyphs alone", () => {
    expect(EMOJI.test(String.fromCodePoint(0x1f680))).toBe(true);
    expect(EMOJI.test(String.fromCodePoint(0x2705))).toBe(true);
    expect(EMOJI.test(String.fromCodePoint(0x2764, 0xfe0f))).toBe(true);
    expect(EMOJI.test("⌘ ⇧ ⌥ © → „du“")).toBe(false);
  });
});
