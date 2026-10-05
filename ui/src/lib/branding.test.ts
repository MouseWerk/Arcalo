// The old name „Annalo“ (renamed to Arcalo in 1.7) must not reach the user: not in the UI
// catalogs, the backend's German/English pairs, the start-up animation, the UI sources, the
// installer's messages or the bundle metadata. The one deliberate exception is the notice
// „Annalo heißt jetzt Arcalo“ for upgraders (`rebrand.*`). Internal names that existing installs
// depend on (credential service, data folder ids, legacy markers) are listed in KEPT with the
// reason; docs/ARCHITECTURE.md („Names kept from Annalo“) explains them.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { de } from "../locales/de";
import { en } from "../locales/en";

const ROOT = path.resolve(__dirname, "../../..");
const OLD = /annalo/i;

/** Catalog keys that may name the old product: the rename notice for upgraders. */
const NOTICE = /^rebrand\./;

/** File names in texts that keep the old name, with the reason. */
const KEPT_FILES: { name: string; reason: string }[] = [
  { name: "annalo-workspace.db", reason: "Database copy in Git sync repositories; computers on older versions share the repository." },
];

/** String literals in Rust code (outside tests) that keep the old name, with the reason. */
const KEPT: { file: string; text: string; reason: string }[] = [
  { file: "src-tauri/src/secrets.rs", text: "Annalo", reason: "Credential store service: entries of 1.6 and earlier are found only under it." },
  { file: "crates/annalo-core/src/rebrand.rs", text: "Annalo", reason: "The old name, to find and remove the old autostart entries and shortcuts." },
  { file: "crates/annalo-core/src/gitsync.rs", text: "# Annalo Git-Synchronisierung", reason: "Marker of sync repositories; computers on 1.6 look for it." },
  { file: "crates/annalo-core/src/gitsync.rs", text: "# Annalo – Git-Sicherung", reason: "README title of sync repositories written by 1.6, recognised as the sync's own." },
  { file: "crates/annalo-core/src/mirror.rs", text: "Annalo – Markdown-Kopie", reason: "Marker of Markdown mirrors written by 1.6, recognised as replaceable." },
  { file: "crates/annalo-core/src/settings_migrate.rs", text: "Annalo", reason: "The old default Git author, replaced by the settings step git-author." },
  { file: "crates/annalo-core/src/update_feed.rs", text: "https://github.com/MouseWerk/Annalo/", reason: "Fallback update feed under the old repository name (GitHub redirects it); never shown." },
];

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "target" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

describe("the old name stays out of sight", () => {
  it("UI catalogs: only the rename notice names Annalo", () => {
    const found: string[] = [];
    for (const [lang, cat] of [["de", de], ["en", en]] as const) {
      for (const [key, text] of Object.entries(cat)) {
        const shown = KEPT_FILES.reduce((s, k) => s.split(k.name).join(""), String(text));
        if (!NOTICE.test(key) && OLD.test(shown)) found.push(`${lang} ${key}: ${text}`);
      }
    }
    expect(found).toEqual([]);
    // The notice itself still says what happened.
    expect(de["rebrand.title"]).toMatch(/Annalo.*Arcalo/);
    expect(en["rebrand.title"]).toMatch(/Annalo.*Arcalo/);
  });

  it("Rust string literals outside tests (tr! pairs, titles, file names)", () => {
    const found: string[] = [];
    for (const file of [...walk(path.join(ROOT, "crates"), /\.rs$/), ...walk(path.join(ROOT, "src-tauri/src"), /\.rs$/)]) {
      const name = rel(file);
      // Test modules (at the end of a file) and test files may use the name freely.
      if (/(^|\/)tests?(\.rs|\/)/.test(name)) continue;
      let src = fs.readFileSync(file, "utf8");
      const tests = src.indexOf("#[cfg(test)]");
      if (tests >= 0) src = src.slice(0, tests);
      for (const line of src.split("\n")) {
        const code = line.trimStart();
        if (code.startsWith("//")) continue;
        for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
          const text = m[1];
          if (!/Annalo/.test(text)) continue;
          if (KEPT.some((k) => k.file === name && text.startsWith(k.text))) continue;
          found.push(`${name}: "${text}"`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("UI sources: no JSX text or string literal with Annalo", () => {
    const found: string[] = [];
    for (const file of walk(path.join(ROOT, "ui/src"), /\.(tsx?|css)$/)) {
      const name = rel(file);
      if (/\.test\.tsx?$/.test(name) || name.startsWith("ui/src/locales/")) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trimStart();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          if (/Annalo/.test(code.replace(/\/\/.*$/, ""))) found.push(`${name}:${i + 1}: ${code}`);
        });
    }
    expect(found).toEqual([]);
  });

  it("start-up animation and window title in index.html say Arcalo", () => {
    const html = fs.readFileSync(path.join(ROOT, "ui/index.html"), "utf8");
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).not.toMatch(OLD);
    const word = html.match(/<div class="splash-word">([\s\S]*?)<\/div>/)?.[1] ?? "";
    expect(word.replace(/<[^>]*>/g, "")).toBe("Arcalo");
    expect(html).toMatch(/<title>Arcalo<\/title>/);
  });

  it("bundle metadata and installer messages", () => {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.productName).toBe("Arcalo");
    expect(conf.bundle.windows.nsis.startMenuFolder).toBe("Arcalo");
    for (const w of conf.app?.windows ?? []) expect(String(w.title ?? "")).not.toMatch(OLD);
    for (const k of ["shortDescription", "longDescription", "copyright"]) expect(String(conf.bundle[k] ?? "")).not.toMatch(OLD);
    expect(fs.readFileSync(path.join(ROOT, "src-tauri/Info.plist"), "utf8")).not.toMatch(OLD);
    // What the installer shows (its details list); the hooks' variables and registry keys are internal.
    const nsh = fs.readFileSync(path.join(ROOT, "src-tauri/installer/hooks.nsh"), "utf8");
    const shown = [...nsh.matchAll(/^\s*(?:DetailPrint|MessageBox\s+\S+)\s+"([^"]*)"/gm)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((s) => OLD.test(s.replace(/\$\w+/g, "")))).toEqual([]);
  });
});
