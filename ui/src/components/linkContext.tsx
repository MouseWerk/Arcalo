// Renders a backlink's source line: [[links]] become plain names, the current page is emphasized.

import { stripMarkdown } from "../lib/plaintext";

/** Shows a backlink's source line with [[links]] as plain names and the current page emphasized. */
export function linkContext(line: string, title: string) {
  const clean = stripMarkdown(line, { keepWikilinks: true });
  const parts = clean.split(/(\[\[[^\]]+\]\])/g);
  return parts.map((p, i) => {
    const m = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/.exec(p);
    if (!m) return p;
    const label = m[2] ?? m[1];
    return m[1].trim().toLowerCase() === title.toLowerCase() ? <mark key={i}>{label}</mark> : <span key={i} className="ctx-link">{label}</span>;
  });
}

