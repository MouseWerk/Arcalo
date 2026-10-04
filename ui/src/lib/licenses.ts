// Settings → Über → „Lizenzen“: Arcalo's own license and the open-source libraries it ships
// (written at build time by scripts/licenses.mjs; missing in a checkout that was not built yet).

export interface Library {
  name: string;
  version: string;
  license: string;
}
export interface Libraries {
  /** Arcalo's own license text (the repository's LICENSE file). */
  license: string;
  ui: Library[];
  app: Library[];
}

const generated = import.meta.glob<Libraries>("../generated/licenses.json", { eager: true, import: "default" });

/** The libraries listed at build time (empty lists before the first build). */
export const LIBRARIES: Libraries = Object.values(generated)[0] ?? { license: "", ui: [], app: [] };

/** The text of Arcalo's license (the LICENSE file of the repository). */
export const APP_LICENSE: string = (LIBRARIES.license ?? "").trim();

/** The license's name from its first line ("MIT License" → "MIT"). */
export function licenseName(text: string): string {
  const first = text.split("\n")[0]?.trim() ?? "";
  return first.replace(/\s+License$/i, "") || first;
}

/** The copyright line of the license text, without the word „Copyright“. */
export function copyrightLine(text: string): string {
  const line = text.split("\n").find((l) => /^copyright\b/i.test(l.trim()));
  return line ? line.trim().replace(/^copyright\s*/i, "© ").replace(/^© \(c\)\s*/i, "© ") : "";
}

/** The libraries whose name or license contains `query` (case-insensitive), sorted by name. */
export function filterLibraries(list: Library[], query: string): Library[] {
  const q = query.trim().toLowerCase();
  const hits = q ? list.filter((l) => l.name.toLowerCase().includes(q) || l.license.toLowerCase().includes(q)) : list;
  return [...hits].sort((a, b) => a.name.localeCompare(b.name));
}
