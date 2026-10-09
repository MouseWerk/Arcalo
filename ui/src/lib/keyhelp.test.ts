// The table of fixed keys in Settings → Tastatur must list what the handlers really do: every key
// the calendar, the start page's edit mode, focus blocks and the graph react to is in its group.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { KEY_HELP } from "./keyhelp";
import { keyAction } from "./agenda";
import { hasKey } from "./i18n";
import type { TKey } from "./i18n";

const SRC = path.resolve(__dirname, "..");
const group = (title: TKey) => KEY_HELP.find((g) => g.title === title)!;
/** The keys a group names (the last word of each spec, as written in key events). */
const named = (title: TKey) => new Set(group(title).items.flatMap((it) => it.keys.map((k) => k.split(" ").pop()!.toLowerCase())));

/** Keys compared in the function starting at `marker` of `file` (up to the next top-level `};`). */
function handledKeys(file: string, marker: string): string[] {
  const text = fs.readFileSync(path.join(SRC, file), "utf8");
  const start = text.indexOf(marker);
  expect(start, `${marker} in ${file}`).toBeGreaterThan(-1);
  const body = text.slice(start, text.indexOf("\n  };", start));
  const keys = new Set<string>();
  for (const m of body.matchAll(/\.key === "([^"]+)"/g)) keys.add(m[1]);
  for (const m of body.matchAll(/\b(Arrow(?:Left|Right|Up|Down))\b/g)) keys.add(m[1]);
  if (/\[1-5\]/.test(body)) ["1", "2", "3", "4", "5"].forEach((k) => keys.add(k));
  // Alternatives that mean the same key („=“ is + without Shift, Backspace deletes like Delete, Space opens like Enter).
  for (const alt of ["=", "_", "Backspace", " "]) keys.delete(alt);
  return [...keys];
}

describe("keyhelp", () => {
  it("lists every key of the calendar", () => {
    const keys = named("kh.group.calendar");
    const candidates = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", ..."abcdefghijklmnopqrstuvwxyz"];
    for (const k of candidates) if (keyAction(k)) expect(keys.has(k.toLowerCase()), k).toBe(true);
  });

  it("lists every key of the start page's edit mode, focus blocks and the graph", () => {
    const cases: [TKey, string, string][] = [
      ["kh.group.dashboard", "components/Dashboard.tsx", "const keyDown = (w: GridWidget"],
      ["kh.group.blocks", "views/CalendarBlocks.tsx", "const key = (e: ReactKeyboardEvent<HTMLDivElement>)"],
      ["kh.group.graph", "components/graph/GraphCanvas.tsx", "const onKeyDown = (e: React.KeyboardEvent)"],
    ];
    for (const [title, file, marker] of cases) {
      const keys = named(title);
      for (const k of handledKeys(file, marker)) expect(keys.has(k.toLowerCase()), `${file}: ${k}`).toBe(true);
    }
  });

  it("has a text for every entry", () => {
    for (const g of KEY_HELP) {
      expect(hasKey(g.title), g.title).toBe(true);
      for (const it of g.items) expect(hasKey(it.label), it.label).toBe(true);
    }
  });
});
