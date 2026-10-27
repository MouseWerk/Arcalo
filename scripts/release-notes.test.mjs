// The release notes' shape (CLAUDE.md): docs/releases/v<version>.md has the sections
// "## Improved", "## Fixed" and "## Checklist for Windows (manual)" in this order and no others,
// a list item in each, and the version in the file name is x.y.z. The automatic release reads
// these files (scripts/release-pick.mjs); a malformed one fails here, before it releases.
//
//   node --test scripts/release-notes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIR = path.join(ROOT, "docs/releases");
const SECTIONS = ["## Improved", "## Fixed", "## Checklist for Windows (manual)"];

/** What is wrong with one notes file (empty: nothing). */
export function problems(name, text) {
  const out = [];
  if (!/^v\d+\.\d+\.\d+\.md$/.test(name)) out.push(`${name}: name it v<major>.<minor>.<patch>.md`);
  const heads = text.split("\n").filter((l) => /^##\s/.test(l)).map((l) => l.trim());
  if (JSON.stringify(heads) !== JSON.stringify(SECTIONS)) out.push(`${name}: sections ${JSON.stringify(heads)}, expected ${JSON.stringify(SECTIONS)}`);
  // A patch release may have nothing under "## Improved" (it only fixes).
  const patch = /^v\d+\.\d+\.[1-9]\d*\.md$/.test(name);
  for (const h of SECTIONS) {
    const at = text.indexOf(`${h}\n`);
    if (at < 0 || (patch && h === "## Improved")) continue;
    const body = text.slice(at + h.length).split(/\n## /)[0];
    if (!/^\s*[-*] \S/m.test(body)) out.push(`${name}: "${h}" has no list item`);
  }
  // U+2705 is the done marker of the task format (data a note quotes, ui/src/lib/emoji.test.ts).
  if (/\p{Emoji_Presentation}/u.test(text.replace(/\u{2705}/gu, ""))) out.push(`${name}: no emojis`);
  return out;
}

// The rule came with 1.11.0; the notes of the releases before it are published as they are.
const RULE_SINCE = [1, 11, 0];
const since = (name) => {
  const v = /^v(\d+)\.(\d+)\.(\d+)\.md$/.exec(name)?.slice(1).map(Number);
  if (!v) return true;
  for (let i = 0; i < 3; i++) if (v[i] !== RULE_SINCE[i]) return v[i] > RULE_SINCE[i];
  return true;
};

test("every release notes file has the three sections", () => {
  const names = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".md") && since(f)) : [];
  assert.ok(names.length > 5, `only ${names.length} notes files`);
  assert.deepEqual(names.flatMap((n) => problems(n, fs.readFileSync(path.join(DIR, n), "utf8"))), []);
});

test("the check finds what it is meant to find", () => {
  const good = "# Arcalo 1.1.0\n\n## Improved\n\n- A.\n\n## Fixed\n\n- B.\n\n## Checklist for Windows (manual)\n\n- [ ] C.\n";
  assert.deepEqual(problems("v1.1.0.md", good), []);
  assert.equal(problems("v1.1.md", good).length, 1);
  assert.equal(problems("v1.1.0.md", good.replace("## Fixed", "## Bug fixes")).length, 1);
  assert.equal(problems("v1.1.0.md", good.replace("- B.", "")).length, 1);
  assert.deepEqual(problems("v1.1.1.md", good.replace("- A.", "")), []);
  assert.equal(problems("v1.2.0.md", good.replace("- A.", "")).length, 1);
  assert.equal(since("v1.10.0.md"), false);
  assert.equal(since("v1.11.0.md"), true);
  assert.equal(since("v2.0.0.md"), true);
});
