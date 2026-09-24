// The links of a page as the side panel lists them.

import { fileExtension } from "../editor/fileEmbed";

export interface OutgoingLinks {
  /** Linked (and note-embedded) page titles, first spelling of each, in order. */
  pages: string[];
  /** Embedded files: images, drawings, PDFs and other attachments. */
  files: string[];
}

/** The `[[Seite]]` links and `![[datei.pdf]]` embeds of a page's Markdown, each once (case-insensitive). */
export function outgoingLinks(md: string): OutgoingLinks {
  const pages = new Map<string, string>();
  const files = new Map<string, string>();
  for (const m of md.matchAll(/(!?)\[\[([^\]|#\n]+)/g)) {
    const name = m[2].trim();
    if (!name) continue;
    const into = m[1] && fileExtension(name) != null ? files : pages;
    if (!into.has(name.toLowerCase())) into.set(name.toLowerCase(), name);
  }
  return { pages: [...pages.values()], files: [...files.values()] };
}

const titleSets = new WeakMap<Map<number, { title: string }>, Set<string>>();

/** Lower-cased titles of `pages`, built once per page map (the store replaces it on changes). */
export function titleSet(pages: Map<number, { title: string }>): Set<string> {
  let set = titleSets.get(pages);
  if (!set) {
    set = new Set();
    for (const p of pages.values()) set.add(p.title.toLowerCase());
    titleSets.set(pages, set);
  }
  return set;
}
