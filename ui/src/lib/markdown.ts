// Safe Markdown rendering for assistant answers.

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Renders Markdown to sanitized HTML; `[[Page]]` becomes a clickable link. */
export function renderMarkdown(md: string): string {
  const withLinks = md.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, alias?: string) =>
    `<a data-wikilink data-target="${escapeHtml(target.trim())}" class="wikilink">${escapeHtml((alias ?? target).trim())}</a>`,
  );
  const html = marked.parse(withLinks, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["data-wikilink", "data-target", "target"] });
}

// Rendered answers by text: a long conversation renders each finished answer once.
const cache = new Map<string, string>();
const CACHE_SIZE = 300;

/** `renderMarkdown`, remembered for the last few hundred texts. */
export function renderMarkdownCached(md: string): string {
  const hit = cache.get(md);
  if (hit !== undefined) {
    cache.delete(md);
    cache.set(md, hit);
    return hit;
  }
  const html = renderMarkdown(md);
  cache.set(md, html);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return html;
}
