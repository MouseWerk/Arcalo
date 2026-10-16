// The links of a page as the side panel lists them.

import { fileExtension, isFileLinkTarget } from "../editor/fileEmbed";

export interface OutgoingLinks {
  /** Linked (and note-embedded) page titles, first spelling of each, in order. */
  pages: string[];
  /** Embedded and linked files: images, drawings, PDFs and other attachments. */
  files: string[];
}

/**
 * The `[[Seite]]` links and `![[datei.pdf]]` embeds of a page's Markdown, each once (case-insensitive).
 * A `[[Angebot.pdf]]` link to a file counts as a file unless `isPage` knows a page of that title.
 */
export function outgoingLinks(md: string, isPage: (title: string) => boolean = () => false): OutgoingLinks {
  const pages = new Map<string, string>();
  const files = new Map<string, string>();
  for (const m of md.matchAll(/(!?)\[\[([^\]|#\n]+)/g)) {
    const name = m[2].trim().normalize("NFC");
    if (!name) continue;
    const file = m[1] ? fileExtension(name) != null : isFileLinkTarget(name) && !isPage(name);
    const into = file ? files : pages;
    if (!into.has(linkKey(name))) into.set(linkKey(name), name);
  }
  return { pages: [...pages.values()], files: [...files.values()] };
}

/** A link target or title as `titleSet` holds it: trimmed, composed (a decomposed „ü“ from a macOS
 *  file name is the „ü“ of a title, as in the core) and lower-cased. */
export function linkKey(title: string): string {
  return title.trim().normalize("NFC").toLowerCase();
}

const titleSets = new WeakMap<Map<number, { title: string }>, Set<string>>();

/** The titles of `pages` as `linkKey` spells them, built once per page map (the store replaces it on changes). */
export function titleSet(pages: Map<number, { title: string }>): Set<string> {
  let set = titleSets.get(pages);
  if (!set) {
    set = new Set();
    for (const p of pages.values()) set.add(linkKey(p.title));
    titleSets.set(pages, set);
  }
  return set;
}

/** Characters a page title cannot hold (they end or split a `[[link]]`) and what replaces them.
 *  Same rule as the core (`notes::clean_title`), which applies it to every title it stores. */
const TITLE_REPLACEMENTS: Record<string, string> = { "[": "(", "]": ")", "|": "｜", "#": "＃", "^": "＾" };

/** The characters of `TITLE_REPLACEMENTS` replaced (no trimming, so it can run while typing). */
export function cleanTitleChars(title: string): string {
  return title.replace(/[[\]|#^]/g, (c) => TITLE_REPLACEMENTS[c] ?? c);
}
