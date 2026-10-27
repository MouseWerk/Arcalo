// The app draws its own controls: the system's stock ones (a `<select>`'s dropdown, the date and
// time pickers, an unstyled checkbox, `alert`/`confirm`/`prompt`) look like Windows, GTK or Android
// instead of the app, and a phone shows them as foreign dialogs. Use `Select`, `DateInput`, the
// `check` box and the app's dialogs instead.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "locales" ? [] : sources(p);
    return /\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

const found = (re: RegExp, skip: string[] = []) =>
  sources(SRC)
    .filter((f) => !skip.includes(rel(f)))
    .flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        // Code only: comments may name what they replace.
        .flatMap((line, i) => (!/^\s*(\/\/|\/?\*)/.test(line) && re.test(line) ? [`${rel(f)}:${i + 1}: ${line.trim()}`] : [])),
    );

/** Every `<input … />` of the components, whole (they span lines), with where it starts. */
const inputs = () =>
  sources(SRC).flatMap((f) => {
    const text = fs.readFileSync(f, "utf8");
    return [...text.matchAll(/<input\b[\s\S]*?\/>/g)].map((m) => ({ file: rel(f), at: `${rel(f)}:${text.slice(0, m.index).split("\n").length}`, tag: m[0] }));
  });

// The Jira files another branch is rewriting; their findings are in docs/quality/q122/findings.md.
const JIRA_IN_PROGRESS = ["components/dashboard/jira.tsx"];

describe("the app's own controls", () => {
  it("draws no system select", () => {
    expect(found(/<select[\s>]/)).toEqual([]);
  });

  it("draws no system date or time picker", () => {
    expect(found(/type=["'{]+(date|time|datetime-local|month|week)["'}]/)).toEqual([]);
  });

  it("asks no question in a system dialog", () => {
    // The PAC script's own `alert` is a function of the proxy script it runs, not the browser's.
    expect(found(/(^|[^.\w])(window\.)?(alert|confirm|prompt)\s*\(/, ["lib/pac.ts"])).toEqual([]);
    expect(found(/window\.(alert|confirm|prompt)\b/)).toEqual([]);
  });

  it("draws every checkbox as the app's box (class check, task-check or task-select)", () => {
    for (const f of JIRA_IN_PROGRESS) expect(fs.existsSync(path.join(SRC, f)), `listed exception ${f} is gone`).toBe(true);
    const stock = inputs()
      .filter((i) => /type="checkbox"/.test(i.tag) && !JIRA_IN_PROGRESS.includes(i.file))
      .filter((i) => !/className=[{"'`][^>]*\b(check|task-check|task-select)\b/.test(i.tag))
      .map((i) => i.at);
    expect(stock).toEqual([]);
  });
});

describe("the keyboard a field opens", () => {
  it("offers no words, corrections or saved entries in a search field", () => {
    const wrong = inputs()
      .filter((i) => /type="search"/.test(i.tag))
      .filter((i) => !/autoComplete="off"/.test(i.tag) || !/autoCorrect="off"/.test(i.tag) || !/autoCapitalize="off"/.test(i.tag) || !/spellCheck=\{false\}/.test(i.tag))
      .map((i) => i.at);
    expect(wrong).toEqual([]);
  });

  it("types addresses in an e-mail field: no capital letter", () => {
    const wrong = inputs()
      .filter((i) => /type="email"/.test(i.tag))
      .filter((i) => !/autoCapitalize="(off|none)"/.test(i.tag))
      .map((i) => i.at);
    expect(wrong).toEqual([]);
  });

  it("opens the number pad for a PIN", () => {
    const wrong = inputs()
      .filter((i) => /pin/i.test(i.tag) && /type="password"/.test(i.tag) && /maxLength=\{?\d/.test(i.tag))
      .filter((i) => !/inputMode="numeric"/.test(i.tag))
      .map((i) => i.at);
    expect(wrong).toEqual([]);
  });
});
