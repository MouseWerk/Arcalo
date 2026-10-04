// „Neu in Arcalo“: the curated highlights per version (docs/releases/highlights/<version>.json,
// bundled at build time) and the full release notes (docs/releases/v<version>.md, loaded on
// demand; versions the build does not bundle are fetched from the repository).

import type { Lang } from "./i18n";

export interface HighlightText {
  title: string;
  /** One or two sentences. */
  text: string;
  /** Label of the action button (optional; a generic one otherwise). */
  action?: string;
  /** Image in this language (a screenshot with this language's text); else the item's `image`. */
  image?: string;
}

/** What the action button does: open a view, a settings section, or run a command (keymap ids). */
export type HighlightAction =
  | { type: "view"; view: "home" | "tasks" | "calendar" | "timesheet" | "settings" }
  | { type: "settings"; section: string }
  | { type: "command"; command: string };

export interface Highlight {
  id: string;
  /** File name in docs/releases/highlights/img (a small PNG) for every language; a language's
   *  own `image` (in `en` / `de`) wins. */
  image?: string;
  action?: HighlightAction;
  en: HighlightText;
  de: HighlightText;
}

export interface VersionHighlights {
  version: string;
  items: Highlight[];
}

const files = import.meta.glob<VersionHighlights>("../../../docs/releases/highlights/*.json", { eager: true, import: "default" });
const images = import.meta.glob<string>("../../../docs/releases/highlights/img/*.png", { eager: true, import: "default" });
const notes = import.meta.glob<string>("../../../docs/releases/v*.md", { import: "default", query: "?raw" });

const parts = (v: string) => {
  const [core, pre] = v.trim().replace(/^v/, "").split("+")[0].split(/-(.*)/s);
  return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? "" };
};

/** Semver order (pre-releases before their release, numeric identifiers as numbers). */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xs = x.pre.split(".");
  const ys = y.pre.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const [n, m] = [Number(xs[i]), Number(ys[i])];
    const d = !Number.isNaN(n) && !Number.isNaN(m) ? n - m : xs[i].localeCompare(ys[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** All bundled highlights, newest first. */
export const HIGHLIGHTS: VersionHighlights[] = Object.values(files)
  .filter((h) => h && typeof h.version === "string" && Array.isArray(h.items))
  .sort((a, b) => compareVersions(b.version, a.version));

/** The highlights an update from `from` to `to` brings: versions after `from` up to `to` (only `to` without `from`), newest first. */
export function highlightsBetween(all: VersionHighlights[], from: string | null | undefined, to: string): VersionHighlights[] {
  return all.filter((h) => compareVersions(h.version, to) <= 0 && (from ? compareVersions(h.version, from) > 0 : compareVersions(h.version, to) === 0) && h.items.length > 0);
}

/** The text of a highlight in the display language. */
export const textOf = (h: Highlight, lang: Lang): HighlightText => h[lang] ?? h.en;

/** The image file of a highlight in the display language: the language's own, else the shared one. */
export const imageOf = (h: Highlight, lang: Lang): string | undefined => h[lang]?.image ?? h.image;

/** URL of a bundled highlight image. */
export function imageUrl(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return Object.entries(images).find(([path]) => path.endsWith(`/img/${name}`))?.[1];
}

const versionOfNotes = (path: string) => /\/v([^/]+)\.md$/.exec(path)?.[1] ?? "";

/** Versions whose release notes the build bundles, newest first. */
export const NOTE_VERSIONS: string[] = Object.keys(notes)
  .map(versionOfNotes)
  .filter(Boolean)
  .sort((a, b) => compareVersions(b, a));

/** The bundled release notes of `version` (Markdown), or `null` when not bundled. */
export async function bundledNotes(version: string): Promise<string | null> {
  const v = version.replace(/^v/, "");
  const entry = Object.entries(notes).find(([path]) => versionOfNotes(path) === v);
  return entry ? entry[1]() : null;
}

/** The versions the „Neu in Arcalo“ list shows: with highlights or bundled notes, newest first, none
 * newer than `current` (the notes of a release in preparation are bundled before it ships). */
export function knownVersions(current?: string | null): string[] {
  const all = new Set([...HIGHLIGHTS.map((h) => h.version), ...NOTE_VERSIONS]);
  return [...all].filter((v) => !current || compareVersions(v, current) <= 0).sort((a, b) => compareVersions(b, a));
}
