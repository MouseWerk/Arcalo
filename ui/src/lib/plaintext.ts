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
    .replace(/^#{1,6}\s+/, "");
  s = s
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
