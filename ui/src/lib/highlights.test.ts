import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { compareVersions, HIGHLIGHTS, highlightsBetween, imageUrl, knownVersions, NOTE_VERSIONS, textOf, type VersionHighlights } from "./highlights";

const v = (version: string): VersionHighlights => ({ version, items: [{ id: "x", en: { title: "T", text: "S." }, de: { title: "T", text: "S." } }] });

describe("compareVersions", () => {
  it("orders like semver", () => {
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("v1.9.1", "1.9.1")).toBe(0);
    expect(compareVersions("1.9.0-beta.2", "1.9.0")).toBe(-1);
    expect(compareVersions("1.9.0-beta.10", "1.9.0-beta.2")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.9.0+win", "1.9.0")).toBe(0);
  });
});

describe("highlightsBetween", () => {
  const all = [v("1.10.0"), v("1.9.1"), v("1.9.0"), v("1.8.0")];
  it("shows the versions an update skipped over, up to the new one", () => {
    expect(highlightsBetween(all, "1.8.0", "1.9.1").map((h) => h.version)).toEqual(["1.9.1", "1.9.0"]);
    expect(highlightsBetween(all, "1.9.0", "1.9.1").map((h) => h.version)).toEqual(["1.9.1"]);
  });
  it("without the old version only the new one", () => {
    expect(highlightsBetween(all, null, "1.9.0").map((h) => h.version)).toEqual(["1.9.0"]);
    expect(highlightsBetween(all, undefined, "1.9.5")).toEqual([]);
  });
  it("nothing for a version without highlights", () => {
    expect(highlightsBetween(all, "1.10.0", "1.10.1")).toEqual([]);
  });
});

const ROOT = path.resolve(__dirname, "../../..");
const SECTIONS = new Set(["appearance", "locale", "start", "keyboard", "editor", "notes", "filing", "time", "calendar", "voice", "jira", "briefing", "ai", "privacy", "network", "notifications", "backup", "desktop", "admin", "logs", "about"]);
const keymapSource = fs.readFileSync(path.join(ROOT, "ui/src/lib/keymap.ts"), "utf8");

describe("bundled highlights", () => {
  it("are bundled for 1.9.0 and listed with the release notes", () => {
    expect(HIGHLIGHTS.map((h) => h.version)).toContain("1.9.0");
    expect(NOTE_VERSIONS).toContain("1.9.0");
    expect(knownVersions()[0]).toBe(NOTE_VERSIONS[0]);
  });
  for (const h of HIGHLIGHTS) {
    it(`${h.version}: 3–5 items in English and German, short, with valid images and actions`, () => {
      expect(h.items.length).toBeGreaterThanOrEqual(3);
      expect(h.items.length).toBeLessThanOrEqual(5);
      expect(new Set(h.items.map((i) => i.id)).size).toBe(h.items.length);
      for (const item of h.items) {
        for (const lang of ["en", "de"] as const) {
          const text = textOf(item, lang);
          expect(text.title.trim(), `${item.id} ${lang}`).not.toBe("");
          const sentences = text.text.split(/(?<=[.!?])\s+/).filter(Boolean);
          expect(sentences.length, `${item.id} ${lang}: one or two sentences`).toBeLessThanOrEqual(2);
          expect(text.text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
          if (item.action) expect(text.action ?? "", `${item.id} ${lang} action label`).not.toBe("");
        }
        if (item.image) {
          expect(fs.existsSync(path.join(ROOT, "docs/releases/highlights/img", item.image)), item.image).toBe(true);
          expect(imageUrl(item.image)).toBeTruthy();
        }
        const a = item.action;
        if (a?.type === "settings") expect(SECTIONS.has(a.section), a.section).toBe(true);
        if (a?.type === "command") expect(keymapSource).toContain(`id: "${a.command}"`);
      }
    });
  }
});
