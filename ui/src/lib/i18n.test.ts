import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DICTS, langFromLocale, translate, type TKey } from "./i18n";
import type { Msg } from "../locales/en";
import { COMMANDS, RESERVED } from "./keymap";

const SRC = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const forms = (m: Msg) => (typeof m === "string" ? [m] : [m.one, m.other]);
const placeholders = (m: Msg) => [...new Set(forms(m).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1])))].sort();

describe("i18n", () => {
  it("English and German have the same keys, none empty", () => {
    const de = Object.keys(DICTS.de).sort();
    const en = Object.keys(DICTS.en).sort();
    expect(de).toEqual(en);
    for (const k of en as TKey[]) {
      for (const s of forms(DICTS.de[k])) expect(s.trim(), k).not.toBe("");
      for (const s of forms(DICTS.en[k])) expect(s.trim(), k).not.toBe("");
    }
  });

  it("placeholders and plural forms match in both languages", () => {
    for (const k of Object.keys(DICTS.en) as TKey[]) {
      expect(placeholders(DICTS.de[k]), k).toEqual(placeholders(DICTS.en[k]));
      expect(typeof DICTS.de[k], k).toBe(typeof DICTS.en[k]);
      // A plural entry is chosen by `n`.
      if (typeof DICTS.en[k] !== "string") expect(placeholders(DICTS.en[k]), k).toContain("n");
    }
  });

  it("every key used in the code exists", () => {
    const used = new Set<string>();
    for (const file of sources(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:t|tr|tStatic)\("([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
      for (const m of text.matchAll(/label: "((?:cmd|nav|navgroup|tool|keys)\.[a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
    }
    for (const c of COMMANDS) used.add(c.label);
    for (const r of Object.values(RESERVED)) used.add(r);
    expect(used.size).toBeGreaterThan(100);
    const missing = [...used].filter((k) => !(k in DICTS.en));
    expect(missing).toEqual([]);
  });

  it("translates with variables and keeps the German chrome strings", () => {
    expect(translate("de", "sidebar.noHits", { q: "NP" })).toBe("Keine Treffer für „NP“");
    expect(translate("en", "sidebar.noHits", { q: "NP" })).toBe("No results for “NP”");
    // e2e tests and users rely on these German labels.
    expect(translate("de", "ribbon.timesheet")).toBe("Zeiterfassung");
    expect(translate("de", "ribbon.projects")).toBe("Projekte");
    expect(translate("de", "nav.backup")).toBe("Sicherung");
    expect(translate("en", "ribbon.settings")).toBe("Settings");
  });

  it("picks plural forms with Intl.PluralRules", () => {
    const k = (Object.keys(DICTS.en) as TKey[]).find((x) => typeof DICTS.en[x] !== "string");
    expect(k, "at least one plural entry").toBeTruthy();
    const en = DICTS.en[k!] as { one: string; other: string };
    expect(translate("en", k!, { n: 1 })).toBe(en.one.split("{n}").join("1"));
    expect(translate("en", k!, { n: 2 })).toBe(en.other.split("{n}").join("2"));
    expect(translate("en", k!, { n: 0 })).toBe(en.other.split("{n}").join("0"));
  });

  it("chooses German only for German locales", () => {
    expect(langFromLocale("de-DE")).toBe("de");
    expect(langFromLocale("de")).toBe("de");
    expect(langFromLocale("DE-at")).toBe("de");
    expect(langFromLocale("en-US")).toBe("en");
    expect(langFromLocale("fr-FR")).toBe("en");
    expect(langFromLocale("")).toBe("en");
    expect(langFromLocale(undefined)).toBe("en");
  });
});
