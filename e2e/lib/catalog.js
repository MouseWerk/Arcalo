// The app's UI texts (ui/src/locales/de.ts and en.ts) for tests that find controls by their label
// in either language. Only the plain string entries are read; plural entries are left out.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const cache = {};

/** The plain string entries of the catalog of `lang` ("de" or "en"). */
export function catalog(lang) {
  if (cache[lang]) return cache[lang];
  const src = fs.readFileSync(path.join(ROOT, "ui/src/locales", `${lang}.ts`), "utf8");
  const out = {};
  for (const m of src.matchAll(/^\s*"([^"]+)": ("(?:[^"\\]|\\.)*"),?\s*$/gm)) out[m[1]] = JSON.parse(m[2]);
  return (cache[lang] = out);
}

/** `t(key, vars)` of `lang`, as the app's i18n fills placeholders (`{name}`). */
export function translator(lang) {
  const c = catalog(lang);
  return (key, vars = {}) => {
    const s = c[key];
    if (s == null) throw new Error(`no text ${key} in ${lang}`);
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  };
}
