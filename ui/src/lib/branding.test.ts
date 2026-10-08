// The old name „Annalo“ (renamed to Arcalo in 1.7; the internal names followed in 1.15) must not
// reach the user and must not come back in code: not in the UI catalogs, the backend's
// German/English pairs, the start-up animation, the UI sources, the installer's messages or the
// bundle metadata, in any spelling (`Annalo`, `annalo-…`, `ANNALO_…`). The one deliberate exception
// the user sees is the notice „Annalo heißt jetzt Arcalo“ for upgraders (`rebrand.*`). The code that
// reads what installs of 1.14 and earlier left behind (folders, credentials, markers, formats) is
// listed in KEPT and UI_KEPT with the reason; docs/ARCHITECTURE.md („Names kept from Annalo“)
// explains them.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { de } from "../locales/de";
import { en } from "../locales/en";

const ROOT = path.resolve(__dirname, "../../..");
const OLD = /annalo/i;

/** Catalog keys that may name the old product: the rename notice for upgraders. */
const NOTICE = /^rebrand\./;

/** String literals in Rust code (outside tests) that keep the old name, with the reason. `text: ""` allows the whole file. */
const KEPT: { file: string; text: string; reason: string }[] = [
  { file: "crates/arcalo-core/src/identity.rs", text: "", reason: "The old identifier, credential service, variable prefix and spelling, in one place: the 1.15 migration and every fallback read through it." },
  { file: "crates/arcalo-core/src/rebrand.rs", text: "Annalo", reason: "The product name of 1.6, to find and remove the old autostart entries and shortcuts." },
  { file: "crates/arcalo-core/src/gitsync.rs", text: "# Annalo Git-Synchronisierung", reason: "Marker of sync repositories of 1.14 and earlier: recognised and kept, computers on those versions look for it." },
  { file: "crates/arcalo-core/src/gitsync.rs", text: "# Annalo – Git-Sicherung", reason: "README title of sync repositories written by 1.6, recognised as the sync's own." },
  { file: "crates/arcalo-core/src/gitsync.rs", text: "annalo-workspace.db", reason: "Database copy of 1.14 and earlier in a shared repository: not removed, read when there is no new one." },
  { file: "crates/arcalo-core/src/mirror.rs", text: "Annalo – Markdown-Kopie", reason: "Marker of Markdown mirrors written by 1.6, recognised as replaceable." },
  { file: "crates/arcalo-core/src/settings_migrate.rs", text: "Annalo", reason: "The old default Git author, replaced by the settings step git-author." },
  { file: "crates/arcalo-core/src/settings_migrate.rs", text: "annalo@localhost", reason: "The old default Git author, replaced by the settings step git-author." },
  { file: "crates/arcalo-core/src/update_feed.rs", text: "https://github.com/MouseWerk/Annalo/", reason: "Fallback update feed under the old repository name (GitHub redirects it); never shown." },
  { file: "crates/arcalo-core/src/update_feed.rs", text: "https://github.com/mauricekleindienst/annalo/", reason: "Fallback update feed under the first repository name (GitHub redirects it); never shown." },
  { file: "crates/arcalo-core/src/datadir.rs", text: "annalo-portable", reason: "Portable marker of copies from before 1.7." },
  { file: "crates/arcalo-core/src/datadir.rs", text: ".annalo-portable", reason: "Portable marker of copies from before 1.7." },
  { file: "crates/arcalo-core/src/backup.rs", text: "annalo-", reason: "Backups written before 1.7 are listed, restored and pruned." },
  { file: "crates/arcalo-core/src/mail/mod.rs", text: "annalo-mail://", reason: "Links to e-mails in notes written by 1.14 and earlier keep working (never rewritten)." },
  { file: "crates/arcalo-core/src/prefs.rs", text: "annalo-light", reason: "Theme id of 1.14 and earlier, read as arcalo-light." },
  { file: "crates/arcalo-core/src/prefs.rs", text: "annalo-dark", reason: "Theme id of 1.14 and earlier, read as arcalo-dark." },
  { file: "crates/arcalo-core/src/prefs.rs", text: "annalo-theme", reason: "Theme files exported by 1.14 and earlier." },
  { file: "crates/arcalo-core/src/calsync/ics.rs", text: "annalo-", reason: "Ids of events without a UID: stored and linked by 1.14 and earlier, kept stable." },
];

/** UI files (outside tests) that may name the old spelling, with the reason. `text: ""` allows the whole file. */
const UI_KEPT: { file: string; text: string; reason: string }[] = [
  { file: "ui/src/lib/legacy.ts", text: "", reason: "The storage keys, formats, link scheme and theme ids of 1.14 and earlier, read only (in one place)." },
  { file: "ui/src/styles/editor.css", text: 'a[href^="annalo-mail:"]', reason: "Links to e-mails written by 1.14 and earlier look like the new ones." },
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
        if (!NOTICE.test(key) && OLD.test(String(text))) found.push(`${lang} ${key}: ${text}`);
      }
    }
    expect(found).toEqual([]);
    // The notice itself still says what happened.
    expect(de["rebrand.title"]).toMatch(/Annalo.*Arcalo/);
    expect(en["rebrand.title"]).toMatch(/Annalo.*Arcalo/);
  });

  it("Rust string literals outside tests (tr! pairs, titles, file names, markers), in any spelling", () => {
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
          if (!OLD.test(text)) continue;
          if (KEPT.some((k) => k.file === name && text.startsWith(k.text))) continue;
          found.push(`${name}: "${text}"`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("every kept name is still there (the list stays honest)", () => {
    for (const k of [...KEPT, ...UI_KEPT]) {
      const src = fs.readFileSync(path.join(ROOT, k.file), "utf8");
      expect(src.includes(k.text) && OLD.test(src), `${k.file}: ${k.text}`).toBe(true);
    }
  });

  it("UI sources: no JSX text, string literal, storage key or event name with the old name in any spelling", () => {
    const found: string[] = [];
    for (const file of walk(path.join(ROOT, "ui/src"), /\.(tsx?|css)$/)) {
      const name = rel(file);
      if (/\.test\.tsx?$/.test(name) || name.startsWith("ui/src/locales/")) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trimStart();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          const bare = code.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
          if (!OLD.test(bare)) return;
          if (UI_KEPT.some((k) => k.file === name && (k.text === "" || bare.includes(k.text)))) return;
          found.push(`${name}:${i + 1}: ${code}`);
        });
    }
    expect(found).toEqual([]);
  });

  it("start-up animation and window title in index.html say Arcalo", () => {
    const html = fs.readFileSync(path.join(ROOT, "ui/index.html"), "utf8");
    expect(html).not.toMatch(OLD);
    const word = html.match(/<div class="splash-word">([\s\S]*?)<\/div>/)?.[1] ?? "";
    expect(word.replace(/<[^>]*>/g, "")).toBe("Arcalo");
    expect(html).toMatch(/<title>Arcalo<\/title>/);
  });

  it("bundle metadata, identifier and installer messages", () => {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.productName).toBe("Arcalo");
    expect(conf.identifier).toBe("de.mousewerk.arcalo");
    expect(conf.bundle.windows.nsis.startMenuFolder).toBe("Arcalo");
    for (const w of conf.app?.windows ?? []) expect(String(w.title ?? "")).not.toMatch(OLD);
    for (const k of ["shortDescription", "longDescription", "copyright"]) expect(String(conf.bundle[k] ?? "")).not.toMatch(OLD);
    expect(conf.app.security.csp).not.toMatch(OLD);
    // Kept: the deb package of 1.6 that this one replaces, and the old repositories' feeds (GitHub redirects them).
    const rest = JSON.stringify({ ...conf, plugins: { ...conf.plugins, updater: { ...conf.plugins.updater, endpoints: [] } }, bundle: { ...conf.bundle, linux: {} } });
    expect(rest).not.toMatch(OLD);
    expect(fs.readFileSync(path.join(ROOT, "src-tauri/Info.plist"), "utf8")).not.toMatch(OLD);
    for (const pkg of ["ui/package.json", "e2e/package.json", "src-tauri/Cargo.toml", "crates/arcalo-core/Cargo.toml"]) {
      expect(fs.readFileSync(path.join(ROOT, pkg), "utf8"), pkg).not.toMatch(OLD);
    }
    // What the installer shows (its details list); the hooks' variables and registry keys are internal.
    const nsh = fs.readFileSync(path.join(ROOT, "src-tauri/installer/hooks.nsh"), "utf8");
    const shown = [...nsh.matchAll(/^\s*(?:DetailPrint|MessageBox\s+\S+)\s+"([^"]*)"/gm)].map((m) => m[1]);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((s) => OLD.test(s.replace(/\$\w+/g, "")))).toEqual([]);
  });
});
