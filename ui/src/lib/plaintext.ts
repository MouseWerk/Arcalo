// Markdown source lines as readable text, for snippets (search hits, backlink context).

/**
 * One line (or FTS snippet) of Markdown as plain text: list, task, heading, quote and callout
 * markers go, emphasis and code marks go, links and embeds keep their label. With
 * `keepWikilinks` `[[…]]` stays for the caller to render. The STX/ETX hit markers of FTS
 * snippets pass through untouched.
 */
export function stripMarkdown(line: string, opts: { keepWikilinks?: boolean } = {}): string {
  let s = line
    .replace(/^(\s*>)+\s*/, "")
    .replace(/^\[![\w-]+\][+-]?\s*/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    // Footnote definitions and references, column markers, the [TOC] line.
    .replace(/^\[\^[^\]\s]+\]:\s*/, "")
    .replace(/^\[TOC\]\s*$/, "");
  s = s
    .replace(/\[\^[^\]\s]+\]/g, "")
    .replace(/<!--\s*\/?spalten?\s*-->/g, "")
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
    .replace(/!\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g, (_, name: string) => name.trim());
  if (!opts.keepWikilinks) s = s.replace(/\[\[([^\]|#\n]*)(?:#([^\]|\n]*))?(?:\|([^\]\n]+))?\]\]/g, (_, page: string, heading?: string, alias?: string) => (alias ?? (page || heading || "")).trim());
  return s
    .replace(/`+/g, "")
    .replace(/(\*\*|__|~~|==)/g, "")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Word and character (without spaces) count of a text, as the status bar shows it. */
export function textStats(text: string): { words: number; chars: number } {
  return { words: text.split(/\s+/).filter(Boolean).length, chars: text.replace(/\s/g, "").length };
}

/**
 * Counts a Markdown body like the visual editor counts its text: markers, fences, table rules
 * and HTML comments do not count, the text inside them does.
 */
export function markdownStats(body: string): { words: number; chars: number } {
  const lines: string[] = [];
  for (const raw of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) continue;
    if (/^([-*_]\s*){3,}$/.test(line)) continue;
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue;
    lines.push(line.startsWith("|") ? line.split("|").map((cell) => stripMarkdown(cell)).join(" ") : stripMarkdown(line));
  }
  return textStats(lines.join(" "));
}
