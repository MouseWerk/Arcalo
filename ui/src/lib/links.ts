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

/** Characters a page title cannot hold (they end or split a `[[link]]`) and what replaces them.
 *  Same rule as the core (`notes::clean_title`), which applies it to every title it stores. */
const TITLE_REPLACEMENTS: Record<string, string> = { "[": "(", "]": ")", "|": "｜", "#": "＃", "^": "＾" };

/** The characters of `TITLE_REPLACEMENTS` replaced (no trimming, so it can run while typing). */
export function cleanTitleChars(title: string): string {
  return title.replace(/[[\]|#^]/g, (c) => TITLE_REPLACEMENTS[c] ?? c);
}
