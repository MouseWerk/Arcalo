// „Als HTML-Datei teilen“: renders pages with the editor's own schema (a headless editor, so
// the file shows what the note shows) and turns the editor HTML into static, self-contained
// markup: images and drawing previews as data URIs, attachments up to EMBED_FILE_BYTES as
// download links (larger ones by name), [[links]] as anchors when the target is in the file
// (else plain text), callouts (foldable ones as <details>), [TOC], footnotes, highlighted code.

import { Editor } from "@tiptap/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { buildExtensions, lowlight } from "./schema";
import { splitFrontmatter } from "./extensions";
import { tocTree, type TocTree } from "./blocks";
import { baseName, formatSize } from "./fileEmbed";
import { EMBED_FILE_BYTES, buildHtmlDocument, dataUri, htmlFileName, mimeOf, type ExportSection } from "../lib/htmlExport";
import { api } from "../lib/api";
import { fmtDate } from "../lib/format";
import { useApp } from "../store/app";
import { flushAllEditors } from "./NoteEditor";

/** Reads attachments for the export (the app: IPC; tests: fakes). */
export interface AttachmentSource {
  read: (name: string) => Promise<Uint8Array | null>;
  size: (name: string) => Promise<number | null>;
}

export interface RenderContext {
  /** Anchor of the page (`page-12`), used as prefix for heading and footnote ids. */
  id: string;
  files: AttachmentSource;
  /** Anchor of an exported page by its lower-cased title. */
  anchors: Map<string, string>;
}

const ATT = "annalo-attachment:";
const CALLOUT_RE = /^\[!(\w+)\]([+-]?)[ \t]*/;
const CALLOUT_LABELS: Record<string, string> = { note: "Notiz", info: "Info", tip: "Tipp", hint: "Tipp", important: "Wichtig", warning: "Warnung", caution: "Vorsicht", danger: "Gefahr", error: "Fehler", success: "Erledigt", question: "Frage", quote: "Zitat", example: "Beispiel", todo: "Aufgabe", abstract: "Zusammenfassung", summary: "Zusammenfassung", bug: "Fehler", failure: "Fehlschlag" };

/** The editor's HTML of a page body (Markdown), attachments as `annalo-attachment:` URLs. */
function editorHtml(markdown: string): string {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildExtensions({ attachmentUrl: (n) => ATT + encodeURIComponent(n) }),
    content: splitFrontmatter(markdown).body,
    contentType: "markdown",
  });
  try {
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

const attName = (src: string | null) => (src?.startsWith(ATT) ? decodeURIComponent(src.slice(ATT.length)) : null);

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}

/** hast (lowlight) → DOM. */
function hastToDom(doc: Document, node: { type: string; value?: string; tagName?: string; properties?: { className?: string[] }; children?: unknown[] }): Node {
  if (node.type === "text") return doc.createTextNode(node.value ?? "");
  const out = node.type === "element" ? doc.createElement(node.tagName ?? "span") : doc.createDocumentFragment();
  if (out instanceof HTMLElement && node.properties?.className) out.className = node.properties.className.join(" ");
  for (const c of (node.children ?? []) as (typeof node)[]) out.appendChild(hastToDom(doc, c));
  return out;
}

/** Renders one page body to static HTML for the file. */
export async function renderPageHtml(markdown: string, ctx: RenderContext): Promise<string> {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><body>${editorHtml(markdown)}</body>`, "text/html");
  const root = doc.body;
  const attachments = new Map<string, string>(); // name → embedded href (or "")

  // Headings get ids; [TOC] lists them.
  const headings = [...root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].filter((h) => h.textContent?.trim());
  headings.forEach((h, i) => h.setAttribute("id", `${ctx.id}-h${i + 1}`));
  for (const nav of root.querySelectorAll("nav[data-toc]")) {
    const box = el(doc, "nav", { class: "toc", "aria-label": "Inhaltsverzeichnis" });
    box.append(el(doc, "div", { class: "toc-head" }, "Inhaltsverzeichnis"));
    const entries = headings.map((h, i) => ({ level: Number(h.tagName[1]), text: h.textContent!.trim(), pos: i }));
    const list = (items: TocTree[]): HTMLUListElement => {
      const ul = el(doc, "ul");
      for (const it of items) {
        const li = el(doc, "li");
        li.append(el(doc, "a", { href: `#${ctx.id}-h${it.entry.pos + 1}` }, it.entry.text));
        if (it.children.length) li.append(list(it.children));
        ul.append(li);
      }
      return ul;
    };
    if (entries.length) box.append(list(tocTree(entries)));
    nav.replaceWith(box);
  }

  // Images and drawing previews → data URIs; web images → links (the file loads nothing).
  for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
    const name = attName(img.getAttribute("src"));
    const drawing = img.hasAttribute("data-drawing");
    for (const a of ["data-embed", "data-alt", "data-drawing", "loading", "draggable", "title"]) img.removeAttribute(a);
    img.className = drawing ? "drawing" : "";
    if (name) {
      const bytes = await ctx.files.read(name).catch(() => null);
      if (bytes) img.setAttribute("src", dataUri(bytes, mimeOf(name)));
      else img.replaceWith(el(doc, "span", { class: "missing" }, `[Bild fehlt: ${baseName(name)}]`));
    } else {
      const src = img.getAttribute("src") ?? "";
      if (/^data:image\//i.test(src)) continue;
      const a = el(doc, "a", { href: src }, img.getAttribute("alt") || src);
      img.replaceWith(/^https?:/i.test(src) ? a : el(doc, "span", { class: "missing" }, `[Bild: ${img.getAttribute("alt") || src}]`));
    }
  }

  // File embeds → a chip; small files embedded as download links.
  for (const span of root.querySelectorAll<HTMLElement>("span[data-file]")) {
    const name = span.getAttribute("data-file") ?? "";
    let href = attachments.get(name);
    let size: number | null = null;
    if (href === undefined) {
      size = await ctx.files.size(name).catch(() => null);
      href = "";
      if (size != null && size <= EMBED_FILE_BYTES) {
        const bytes = await ctx.files.read(name).catch(() => null);
        if (bytes) href = dataUri(bytes, mimeOf(name));
      }
      attachments.set(name, href);
    }
    const label = span.getAttribute("data-alt") || baseName(name);
    const chip = href ? el(doc, "a", { class: "attachment", href, download: baseName(name) }, label) : el(doc, "span", { class: "attachment" }, label);
    if (size != null) chip.append(" ", el(doc, "small", {}, formatSize(size)));
    else if (!href) chip.append(" ", el(doc, "small", {}, "nicht enthalten"));
    span.replaceWith(chip);
  }

  // [[Links]]: an anchor when the page is in the file, else plain text.
  for (const a of root.querySelectorAll<HTMLElement>("a[data-wikilink]")) {
    const target = (a.getAttribute("data-target") ?? "").toLowerCase();
    const anchor = ctx.anchors.get(target);
    const label = a.textContent ?? "";
    a.replaceWith(anchor ? el(doc, "a", { class: "wikilink", href: `#${anchor}` }, label) : el(doc, "span", { class: "wikilink" }, label));
  }

  // Time entry chips, task lists, web links.
  for (const t of root.querySelectorAll("time-entry")) t.replaceWith(el(doc, "span", { class: "time-chip" }, t.textContent ?? ""));
  for (const ul of root.querySelectorAll('ul[data-type="taskList"]')) {
    ul.removeAttribute("data-type");
    ul.className = "tasks";
    for (const li of ul.querySelectorAll(":scope > li")) {
      if (li.getAttribute("data-checked") === "true") li.classList.add("done");
      li.removeAttribute("data-type");
      li.removeAttribute("data-checked");
      li.querySelectorAll("input").forEach((i) => i.setAttribute("disabled", ""));
    }
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) a.setAttribute("rel", "noopener noreferrer");
    else if (!href.startsWith("#") && !href.startsWith("data:")) a.replaceWith(el(doc, "span", {}, a.textContent ?? ""));
  }

  // Callouts: `[!type]` quotes; `[!type]-`/`+` become <details>.
  for (const q of [...root.querySelectorAll("blockquote")].reverse()) {
    const first = q.firstElementChild;
    const text = first?.tagName === "P" ? (first.firstChild?.textContent ?? "") : "";
    const m = first?.firstChild?.nodeType === 3 ? CALLOUT_RE.exec(text) : null;
    if (!m || !first) continue;
    const type = m[1].toLowerCase();
    first.firstChild!.textContent = text.slice(m[0].length);
    // Title: the first line of the first paragraph.
    const title = el(doc, "span", { class: "callout-title" });
    const rest = el(doc, "p");
    let inRest = false;
    for (const n of [...first.childNodes]) {
      if (inRest) rest.append(n);
      else if (n.nodeName === "BR") inRest = true;
      else if (n.nodeType === 3 && n.textContent!.includes("\n")) {
        const i = n.textContent!.indexOf("\n");
        title.append(n.textContent!.slice(0, i));
        rest.append(n.textContent!.slice(i + 1));
        inRest = true;
      } else title.append(n);
    }
    const head = m[2] ? el(doc, "summary") : el(doc, "div");
    if (!title.textContent!.trim()) head.append(el(doc, "span", { class: "callout-label" }, CALLOUT_LABELS[type] ?? type));
    else head.append(title);
    const box = m[2] ? el(doc, "details", { class: `callout callout-${type}` }) : el(doc, "div", { class: `callout callout-${type}` });
    if (m[2] === "+") box.setAttribute("open", "");
    box.append(head);
    if (rest.childNodes.length && rest.textContent!.trim()) box.append(rest);
    for (const n of [...q.childNodes].slice(1)) box.append(n);
    q.replaceWith(box);
  }

  // Footnotes: numbered references, the definitions as a list at the end with back-links.
  const nums = new Map<string, number>();
  for (const s of root.querySelectorAll("sup[data-footnote]")) {
    const label = s.getAttribute("data-footnote") ?? "";
    if (!nums.has(label)) nums.set(label, nums.size + 1);
  }
  const defs = [...root.querySelectorAll<HTMLElement>("div[data-footnote-def]")];
  for (const d of defs) {
    const label = d.getAttribute("data-footnote-def") ?? "";
    if (!nums.has(label)) nums.set(label, nums.size + 1);
  }
  const fid = (label: string) => `${ctx.id}-fn-${nums.get(label)}`;
  const seen = new Set<string>();
  for (const s of root.querySelectorAll("sup[data-footnote]")) {
    const label = s.getAttribute("data-footnote") ?? "";
    const sup = el(doc, "sup", { class: "fn-ref" });
    // The note as tooltip, like the hover card in the editor.
    const note = defs.find((d) => d.getAttribute("data-footnote-def") === label)?.textContent?.replace(/\s+/g, " ").trim();
    const a = el(doc, "a", { href: `#${fid(label)}`, ...(note ? { title: note } : {}) }, String(nums.get(label)));
    if (!seen.has(label)) {
      a.id = `${fid(label)}-ref`;
      seen.add(label);
    }
    sup.append(a);
    s.replaceWith(sup);
  }
  if (defs.length) {
    const section = el(doc, "section", { class: "footnotes" });
    section.append(el(doc, "h2", {}, "Fußnoten"));
    const ol = el(doc, "ol");
    for (const d of defs.sort((x, y) => nums.get(x.getAttribute("data-footnote-def")!)! - nums.get(y.getAttribute("data-footnote-def")!)!)) {
      const label = d.getAttribute("data-footnote-def") ?? "";
      const li = el(doc, "li", { id: fid(label), value: String(nums.get(label)) });
      li.append(...d.childNodes);
      if (seen.has(label)) li.append(el(doc, "a", { class: "back", href: `#${fid(label)}-ref`, "aria-label": "Zurück zum Verweis" }, "↑"));
      ol.append(li);
      d.remove();
    }
    section.append(ol);
    root.append(section);
  }

  // Columns and code highlighting.
  for (const c of root.querySelectorAll("div[data-columns]")) c.removeAttribute("data-columns");
  for (const c of root.querySelectorAll("div[data-column]")) c.removeAttribute("data-column");
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    const lang = /language-([\w-]+)/.exec(code.className)?.[1];
    if (!lang || !lowlight.registered(lang)) continue;
    const tree = lowlight.highlight(lang, code.textContent ?? "");
    code.replaceChildren(hastToDom(doc, tree as never));
    code.classList.add("hljs");
  }

  // All attachments of the page, once more at its end.
  if (attachments.size) {
    const box = el(doc, "section", { class: "attachments" });
    box.append(el(doc, "h2", {}, "Anhänge"));
    const ul = el(doc, "ul");
    for (const [name, href] of attachments) {
      const li = el(doc, "li");
      li.append(href ? el(doc, "a", { class: "attachment", href, download: baseName(name) }, baseName(name)) : el(doc, "span", { class: "attachment" }, baseName(name)));
      ul.append(li);
    }
    box.append(ul);
    root.append(box);
  }
  return root.innerHTML;
}

// ------------------------------------------------------------------ export

/** The page and (with `withChildren`) its subpages in tree order, with their depth. */
function collectPages(pageId: number, withChildren: boolean): { id: number; depth: number }[] {
  const pages = useApp.getState().pages;
  const out: { id: number; depth: number }[] = [];
  const walk = (id: number, depth: number) => {
    out.push({ id, depth });
    if (withChildren) for (const c of pages.get(id)?.children ?? []) walk(c.id, depth + 1);
  };
  walk(pageId, 0);
  return out;
}

const appFiles: AttachmentSource = {
  read: async (name) => new Uint8Array(await api.readAttachment(name)),
  size: (name) => api.attachmentSize(name),
};

/** Builds the HTML file of a page (and its subpages). */
export async function exportPagesHtml(pageId: number, withChildren: boolean, files: AttachmentSource = appFiles): Promise<{ title: string; html: string }> {
  const list = collectPages(pageId, withChildren);
  const docs = await Promise.all(list.map((p) => api.page(p.id)));
  const anchors = new Map(docs.map((d) => [d.title.toLowerCase(), `page-${d.id}`]));
  const sections: ExportSection[] = [];
  for (const [i, d] of docs.entries()) {
    const id = `page-${d.id}`;
    sections.push({ id, title: d.title, date: fmtDate(d.updated_at), depth: list[i].depth, body: await renderPageHtml(d.content, { id, files, anchors }) });
  }
  return { title: docs[0].title, html: buildHtmlDocument(sections, { created: fmtDate(new Date()) }) };
}

/** Asks for „Als HTML-Datei teilen“ of a page (`detail: { id, withChildren, path? }`); without a path the save dialog asks. */
export const SHARE_HTML_EVENT = "annalo:share-html";

/** Page menu „Als HTML-Datei teilen…“: save dialog (unless `path` is given), then one self-contained file. */
export async function sharePageAsHtml(pageId: number, withChildren: boolean, path?: string) {
  const s = useApp.getState();
  try {
    await flushAllEditors().catch(() => {});
    const title = s.pages.get(pageId)?.title ?? "Seite";
    const chosen = path ?? (await saveDialog({ defaultPath: htmlFileName(title), filters: [{ name: "HTML", extensions: ["html"] }] }));
    if (!chosen) return;
    const file = /\.html?$/i.test(chosen) ? chosen : `${chosen}.html`;
    const { html } = await exportPagesHtml(pageId, withChildren);
    await api.writeHtmlFile(file, html);
    s.toast({ tone: "success", title: "HTML-Datei gespeichert", detail: file });
  } catch (e) {
    s.error("HTML-Datei konnte nicht gespeichert werden", e);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener(SHARE_HTML_EVENT, (e) => {
    const d = (e as CustomEvent<{ id: number; withChildren?: boolean; path?: string }>).detail;
    if (d?.id != null) void sharePageAsHtml(d.id, !!d.withChildren, d.path);
  });
}
