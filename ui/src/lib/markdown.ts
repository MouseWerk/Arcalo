// Safe Markdown rendering for assistant answers.

import { marked, Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { lazyGrammar, loadLanguage, lowlight } from "../editor/languages";
import { t } from "./i18n";

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
const CODE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/></svg>';

/**
 * Sanitized HTML that never widens the chat: code blocks get a box with their language and a
 * copy button and scroll inside it, tables scroll in a wrapper. Only fixed markup is added
 * around the sanitized output (the language is the sanitized class).
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

type Hast = { type: string; value?: string; tagName?: string; properties?: { className?: string[] }; children?: Hast[] };

/** lowlight's tree as HTML: text escaped, nothing but `<span class="hljs-…">`. */
function hastHtml(node: Hast): string {
  if (node.type === "text") return escapeHtml(node.value ?? "");
  const inner = (node.children ?? []).map(hastHtml).join("");
  if (node.type !== "element") return inner;
  const cls = (node.properties?.className ?? []).filter((c) => /^hljs-[\w-]+$|^[\w-]+_+$/.test(c)).join(" ");
  return cls ? `<span class="${cls}">${inner}</span>` : inner;
}

// A grammar loaded later renders the answers that wait for it again.
let grammarVersion = 0;
const grammarListeners = new Set<() => void>();
function grammarLoaded() {
  grammarVersion++;
  for (const f of grammarListeners) f();
}
/** Called when a code language loaded later can be highlighted now. */
export function onGrammarLoaded(f: () => void) {
  grammarListeners.add(f);
  return () => void grammarListeners.delete(f);
}

/** Highlighted HTML of `code` in `lang`; null for an unknown language (a known lazy grammar is fetched). */
export function highlightCode(code: string, lang: string): string | null {
  const name = lang.toLowerCase();
  if (!lowlight.registered(name)) {
    if (lazyGrammar(name)) void loadLanguage(name).then((ok) => ok && grammarLoaded());
    return null;
  }
  try {
    return hastHtml(lowlight.highlight(name, code) as unknown as Hast);
  } catch {
    return null;
  }
}

/** Whether `md` ends inside a code fence that is not closed yet (an answer streaming in). */
export function openFence(md: string): boolean {
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!fence) fence = m[1];
    else if (m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null;
  }
  return fence !== null;
}

/** The language a fence names: its first word, safe characters only. */
const fenceLang = (lang: string | undefined) => (lang ?? "").trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, "").slice(0, 32);

let copyLabelNow = "Code kopieren";

const chatMarked = new Marked({ gfm: true, breaks: false });
chatMarked.use({
  extensions: [
    {
      // `[[Page]]` and `[[Page|alias]]` become page links (raw HTML of an answer does not).
      name: "wikilink",
      level: "inline",
      start: (src: string) => {
        const i = src.indexOf("[[");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(src);
        return m ? { type: "wikilink", raw: m[0], target: m[1].trim(), label: (m[2] ?? m[1]).trim() } : undefined;
      },
      renderer: (token) => `<a data-wikilink data-target="${escapeHtml(String(token.target))}" class="wikilink">${escapeHtml(String(token.label))}</a>`,
    },
  ],
  renderer: {
    // Raw HTML of the model is shown as text, never run.
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
    code({ text, lang }: Tokens.Code) {
      const language = fenceLang(lang);
      const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "<span></span>";
      const highlighted = language ? highlightCode(text, language) : null;
      const body = highlighted ?? escapeHtml(text);
      const cls = language ? ` class="language-${escapeHtml(language)}${highlighted ? " hljs" : ""}"` : "";
      const copy = `<button type="button" class="code-copy" data-code-copy aria-label="${escapeHtml(copyLabelNow)}" title="${escapeHtml(copyLabelNow)}">${COPY_ICON}<span class="code-copy-text">${escapeHtml(t("chat.copyShort"))}</span></button>`;
      const box = (extra: string) => `<div class="code-box"><div class="code-head">${label}<span class="code-tools">${extra}${copy}</span></div><pre><code${cls}>${body}\n</code></pre></div>`;
      if (language.toLowerCase() !== "mermaid") return box("");
      // A diagram once the answer is complete; the source stays one click away.
      const toggle = `<button type="button" class="code-copy code-toggle" data-mermaid-toggle aria-pressed="false" title="${escapeHtml(t("chat.mermaidSource"))}">${CODE_ICON}<span class="code-copy-text">${escapeHtml(t("chat.mermaidSourceShort"))}</span></button>`;
      return `<div class="mermaid-box" data-mermaid>${box(toggle)}<div class="mermaid-view" hidden></div></div>`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      if (!/^(https?:|mailto:)/i.test(href)) return text;
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(title || href)}" data-external rel="noreferrer">${text}</a>`;
    },
    table(token: Tokens.Table) {
      const cell = (c: Tokens.TableCell, tag: "th" | "td") => `<${tag}${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</${tag}>`;
      const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
      const rows = token.rows.map((r) => `<tr>${r.map((c) => cell(c, "td")).join("")}</tr>`).join("");
      return `<div class="table-scroll" tabindex="0"><table><thead>${head}</thead>${rows ? `<tbody>${rows}</tbody>` : ""}</table></div>\n`;
    },
  },
});

const CHAT_PURIFY = {
  ADD_ATTR: ["data-wikilink", "data-target", "data-external", "data-code-copy", "data-mermaid", "data-mermaid-toggle", "aria-pressed", "tabindex"],
  // Answers bring no forms, frames or styles of their own.
  FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "script"],
};

/**
 * An assistant answer as sanitized HTML (GitHub-flavored Markdown) that never widens the chat:
 * code in a box with its language, highlighting and a copy button, scrolling inside it; tables
 * in a scroll box; links that open outside the app; raw HTML as text; ```mermaid as a diagram
 * once the answer is complete (TurnView draws it).
 */
export function renderChatMarkdown(md: string, copyLabel = "Code kopieren"): string {
  copyLabelNow = copyLabel;
  const html = chatMarked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, CHAT_PURIFY) as unknown as string;
}

// Rendered answers by text: a long conversation renders each finished answer once.
const cache = new Map<string, string>();
const CACHE_SIZE = 300;
const chatCache = new Map<string, string>();

/** `renderChatMarkdown`, remembered like `renderMarkdownCached`. */
export function renderChatMarkdownCached(md: string, copyLabel?: string): string {
  const key = `${grammarVersion}\u0000${copyLabel ?? ""}\u0000${md}`;
  const hit = chatCache.get(key);
  if (hit !== undefined) {
    chatCache.delete(key);
    chatCache.set(key, hit);
    return hit;
  }
  const html = renderChatMarkdown(md, copyLabel);
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
