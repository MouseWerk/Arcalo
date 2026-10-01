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

const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/**
 * Sanitized HTML of an assistant answer that never widens the chat: code blocks get a box
 * with their language and a copy button and scroll inside it, tables scroll in a wrapper.
 * Only fixed markup is added around the sanitized output (the language is the sanitized class).
 */
export function chatHtml(html: string, copyLabel = "Code kopieren"): string {
  return html
    .replace(/<pre><code(?: class="language-([\w+#.-]+)")?>/g, (_m, lang?: string) => {
      const label = lang ? `<span class="code-lang">${lang}</span>` : "<span></span>";
      return `<div class="code-box"><div class="code-head">${label}<button type="button" class="code-copy" data-code-copy aria-label="${copyLabel}" title="${copyLabel}">${COPY_ICON}</button></div><pre><code${lang ? ` class="language-${lang}"` : ""}>`;
    })
    .replace(/<\/code><\/pre>/g, "</code></pre></div>")
    .replace(/<table>/g, '<div class="table-scroll" tabindex="0"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

/** `chatHtml(renderMarkdown(md))`. */
export function renderChatMarkdown(md: string, copyLabel?: string): string {
  return chatHtml(renderMarkdown(md), copyLabel);
}

// Rendered answers by text: a long conversation renders each finished answer once.
const cache = new Map<string, string>();
const CACHE_SIZE = 300;
const chatCache = new Map<string, string>();

/** `renderChatMarkdown`, remembered like `renderMarkdownCached`. */
export function renderChatMarkdownCached(md: string, copyLabel?: string): string {
  const key = `${copyLabel ?? ""}\u0000${md}`;
  const hit = chatCache.get(key);
  if (hit !== undefined) {
    chatCache.delete(key);
    chatCache.set(key, hit);
    return hit;
  }
  const html = chatHtml(renderMarkdown(md), copyLabel);
  chatCache.set(key, html);
  if (chatCache.size > CACHE_SIZE) chatCache.delete(chatCache.keys().next().value!);
  return html;
}

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
