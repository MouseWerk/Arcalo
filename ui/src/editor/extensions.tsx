// Custom TipTap extensions: wiki links, [[ autocomplete, slash commands,
// /zeit booking, #tag and due-date highlighting, time-entry chips and image embeds.

import { Extension, Node, mergeAttributes, type Editor, type Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import Image from "@tiptap/extension-image";
import {
  AlertTriangle, Info, CheckSquare, Code2, FilePlus2, Heading1, Heading2, Heading3, Link2, List, ListOrdered, Minus, Quote, Table2, Text, Timer, CalendarDays, CalendarClock, Highlighter, ImagePlus, LayoutTemplate, Sparkles, NotebookPen, PenTool,
} from "lucide-react";
import { isoDay } from "../lib/format";
import { popupRenderer, type PopupItem } from "./suggestion-popup";
import { PageIcon } from "../components/icons";
import { zeitToken } from "./zeit-suggest";
import { FIRST_LINE_RE } from "../lib/frontmatter";
import { TABLE_ACTIONS, tableActionEnabled } from "./table-actions";
import { keys } from "../lib/shortcut";

// ------------------------------------------------------------- wiki links

export interface WikiLinkOptions {
  onOpen: (target: string, newTab: boolean) => void;
  isKnown: (target: string) => boolean;
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { onOpen: () => {}, isKnown: () => true };
  },

  addAttributes() {
    return {
      target: { default: "" },
      anchor: { default: null },
      alias: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "a[data-wikilink]", getAttrs: (el) => ({ target: (el as HTMLElement).dataset.target, alias: (el as HTMLElement).dataset.alias ?? null }) }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = node.attrs.alias || (node.attrs.anchor ? `${node.attrs.target} › ${node.attrs.anchor}` : node.attrs.target);
    return ["a", mergeAttributes(HTMLAttributes, { "data-wikilink": "", "data-target": node.attrs.target, class: "wikilink" }), label];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("a");
      dom.dataset.wikilink = "";
      dom.dataset.target = node.attrs.target;
      dom.className = `wikilink${this.options.isKnown(node.attrs.target) ? "" : " unresolved"}`;
      dom.textContent = node.attrs.alias || (node.attrs.anchor ? `${node.attrs.target} › ${node.attrs.anchor}` : node.attrs.target);
      dom.title = this.options.isKnown(node.attrs.target) ? node.attrs.target : `${node.attrs.target} (noch nicht angelegt, Klick erstellt die Seite)`;
      dom.addEventListener("mousedown", (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        e.preventDefault();
        this.options.onOpen(node.attrs.target, e.ctrlKey || e.metaKey || e.button === 1);
      });
      return { dom };
    };
  },

  renderText({ node }) {
    return `[[${node.attrs.target}${node.attrs.anchor ? "#" + node.attrs.anchor : ""}${node.attrs.alias ? "|" + node.attrs.alias : ""}]]`;
  },

  markdownTokenizer: {
    name: "wikiLink",
    level: "inline",
    start: (src: string) => src.indexOf("[["),
    tokenize(src: string) {
      const m = /^\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/.exec(src);
      if (!m) return undefined;
      return { type: "wikiLink", raw: m[0], target: m[1].trim(), anchor: m[2]?.trim() ?? null, alias: m[3]?.trim() ?? null };
    },
  },
  parseMarkdown: (token) => ({ type: "wikiLink", attrs: { target: token.target, anchor: token.anchor, alias: token.alias } }),
  // Inside a table cell (marked by schema.ts) the alias pipe must be `\|`.
  renderMarkdown: (node, _h, ctx) =>
    `[[${node.attrs?.target}${node.attrs?.anchor ? "#" + node.attrs.anchor : ""}${node.attrs?.alias ? (ctx?.meta?.parentAttrs?.__inTableCell ? "\\|" : "|") + node.attrs.alias : ""}]]`,
});

export interface LinkSuggestItem extends PopupItem {
  target: string;
  create?: boolean;
}

export const WikiLinkSuggest = Extension.create<{ search: (q: string) => Promise<LinkSuggestItem[]> }>({
  name: "wikiLinkSuggest",
  addOptions() {
    return { search: async () => [] };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion<LinkSuggestItem>({
        editor: this.editor,
        pluginKey: new PluginKey("wikiLinkSuggest"),
        char: "[[",
        allowSpaces: true,
        startOfLine: false,
        items: ({ query }) => this.options.search(query),
        command: ({ editor, range, props }) => {
          // Swallow an auto-closed "]]" right after the caret.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size), "");
          const to = after === "]]" ? range.to + 2 : range.to;
          editor
            .chain()
            .focus()
            .insertContentAt({ from: range.from, to }, [
              { type: "wikiLink", attrs: { target: props.target } },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: popupRenderer<LinkSuggestItem>("Tippe einen Seitennamen"),
      }),
    ];
  },
});

export function pageSuggestItem(p: { id: number; title: string; icon: string | null }, subtitle?: string): LinkSuggestItem {
  return { id: `p${p.id}`, title: p.title, target: p.title, subtitle, icon: <PageIcon name={p.icon} size={15} /> };
}

// ----------------------------------------------------------- slash menu

interface SlashItem extends PopupItem {
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

const ic = (C: typeof Text) => <C size={15} strokeWidth={1.75} />;

export interface SlashOptions {
  /** Opens the template picker; the `/…` text is already removed. */
  onTemplate: ((editor: Editor) => void) | null;
  /** Opens a file chooser and inserts the chosen images. */
  onImage: ((editor: Editor) => void) | null;
  /** Opens the inline AI bar on the current block. */
  onAi: ((editor: Editor) => void) | null;
  /** „Besprechung zusammenfassen“ for the page. */
  onSummary: ((editor: Editor) => void) | null;
  /** Creates a drawing, embeds it and opens the drawing editor. */
  onDrawing: ((editor: Editor) => void) | null;
}

function slashItems(o: SlashOptions): SlashItem[] {
  const today = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const isoToday = isoDay(new Date());
  return [
    { id: "text", title: "Text", icon: ic(Text), section: "Grundlagen", keywords: "absatz paragraph text", run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
    { id: "h1", title: "Überschrift 1", icon: ic(Heading1), hint: "#", section: "Grundlagen", keywords: "heading titel h1", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
    { id: "h2", title: "Überschrift 2", icon: ic(Heading2), hint: "##", section: "Grundlagen", keywords: "heading h2", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
    { id: "h3", title: "Überschrift 3", icon: ic(Heading3), hint: "###", section: "Grundlagen", keywords: "heading h3", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
    { id: "todo", title: "Aufgabenliste", icon: ic(CheckSquare), hint: "[ ]", section: "Listen", keywords: "todo task checkbox aufgabe", run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { id: "ul", title: "Aufzählung", icon: ic(List), hint: "-", section: "Listen", keywords: "bullet liste", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { id: "ol", title: "Nummerierte Liste", icon: ic(ListOrdered), hint: "1.", section: "Listen", keywords: "ordered nummer", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { id: "quote", title: "Zitat", icon: ic(Quote), hint: ">", section: "Blöcke", keywords: "quote zitat", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { id: "callout", title: "Hinweisbox", subtitle: "Obsidian-Callout", icon: ic(Info), section: "Blöcke", keywords: "callout hinweis info note", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().insertContent("[!note] ").run() },
    { id: "warn", title: "Warnbox", icon: ic(AlertTriangle), section: "Blöcke", keywords: "callout warnung warning", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().insertContent("[!warning] ").run() },
    { id: "code", title: "Codeblock", icon: ic(Code2), hint: "```", section: "Blöcke", keywords: "code snippet", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { id: "table", title: "Tabelle", icon: ic(Table2), section: "Blöcke", keywords: "table tabelle", run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: "hr", title: "Trennlinie", icon: ic(Minus), hint: "---", section: "Blöcke", keywords: "divider linie hr", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    { id: "mark", title: "Hervorheben", icon: ic(Highlighter), hint: "==", section: "Blöcke", keywords: "highlight markieren", run: (e, r) => e.chain().focus().deleteRange(r).toggleHighlight().run() },
    { id: "link", title: "Seitenlink", icon: ic(Link2), hint: "[[", section: "Einfügen", keywords: "link verknüpfung wiki", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
    { id: "date", title: "Heutiges Datum", icon: ic(CalendarDays), hint: today, section: "Einfügen", keywords: "datum date heute", run: (e, r) => e.chain().focus().deleteRange(r).insertContent(today + " ").run() },
    { id: "due", title: "Fälligkeitsdatum", subtitle: "Für Aufgaben: 📅 JJJJ-MM-TT", icon: ic(CalendarClock), hint: `📅 ${isoToday}`, section: "Einfügen", keywords: "fällig due termin deadline aufgabe", run: (e, r) => {
      // Separate from preceding text, but no double space.
      const before = r.from > 1 ? e.state.doc.textBetween(r.from - 1, r.from) : "";
      e.chain().focus().deleteRange(r).insertContent(`${before && !/\s/.test(before) ? " " : ""}📅 ${isoToday} `).run();
    } },
    { id: "zeit", title: "Zeit buchen", subtitle: "NP-8801/1020 2.5h Beschreibung", icon: ic(Timer), hint: "/zeit", section: "Zeiterfassung", keywords: "zeit time buchen stunden", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("/zeit ").run() },
    { id: "subpage", title: "Unterseite", icon: ic(FilePlus2), section: "Einfügen", keywords: "seite page unterseite", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
    ...(o.onImage
      ? [{ id: "image", title: "Bild", subtitle: `Datei wählen, oder einfügen mit ${keys("Mod V")}`, icon: ic(ImagePlus), section: "Einfügen", keywords: "bild image foto screenshot anhang", run: (e: Editor, r: Range) => (e.chain().deleteRange(r).run(), o.onImage!(e)) }]
      : []),
    ...(o.onDrawing
      ? [{ id: "drawing", title: "Zeichnung", subtitle: "Skizze oder Diagramm (Excalidraw)", icon: ic(PenTool), section: "Einfügen", keywords: "zeichnung drawing excalidraw diagramm skizze whiteboard", run: (e: Editor, r: Range) => (e.chain().focus().deleteRange(r).run(), o.onDrawing!(e)) }]
      : []),
    ...(o.onTemplate
      ? [{ id: "template", title: "Vorlage einfügen", subtitle: "Seite aus „Vorlagen“", icon: ic(LayoutTemplate), section: "Einfügen", keywords: "vorlage template muster", run: (e: Editor, r: Range) => (e.chain().deleteRange(r).run(), o.onTemplate!(e)) }]
      : []),
    ...(o.onAi
      ? [{ id: "ki", title: "KI bearbeiten", subtitle: "Absatz verbessern, kürzen, übersetzen …", hint: keys("Mod J"), icon: ic(Sparkles), section: "KI", keywords: "ki ai assistent umschreiben verbessern kürzen übersetzen", run: (e: Editor, r: Range) => (e.chain().focus().deleteRange(r).run(), o.onAi!(e)) }]
      : []),
    ...(o.onSummary
      ? [{ id: "summary", title: "Zusammenfassung", subtitle: "Besprechung zusammenfassen: Entscheidungen, Aufgaben", icon: ic(NotebookPen), section: "KI", keywords: "besprechung meeting protokoll summary ki aufgaben entscheidungen", run: (e: Editor, r: Range) => (e.chain().focus().deleteRange(r).run(), o.onSummary!(e)) }]
      : []),
  ];
}

/** Row/column commands, offered while the cursor is in a table. */
function tableSlashItems(editor: Editor): SlashItem[] {
  return TABLE_ACTIONS.filter((a) => tableActionEnabled(editor.state, a)).map((a) => ({
    id: `table-${a.id}`,
    title: a.title,
    icon: ic(a.icon),
    section: "Tabelle",
    keywords: a.keywords,
    run: (e: Editor, r: Range) => a.run(e.chain().focus().deleteRange(r)).run(),
  }));
}

/** Lower-case, umlaut-tolerant form for matching ("Überschrift" ~ "ueberschrift" ~ "uberschrift"). */
export function fold(s: string) {
  const lower = s.toLowerCase();
  const ascii = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const expanded = lower.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
  return `${ascii} ${expanded}`;
}

/** Umlaut-tolerant substring match: "ueber" and "uber" both find "Überschrift". */
export function fuzzyIncludes(text: string, query: string) {
  const hay = fold(text);
  const q = query.toLowerCase();
  const qAscii = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return hay.includes(q) || hay.includes(qAscii);
}

export const SlashCommand = Extension.create<SlashOptions>({
  name: "slashCommand",
  addOptions() {
    return { onTemplate: null, onImage: null, onAi: null, onSummary: null, onDrawing: null };
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey("slashCommand"),
        char: "/",
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          // Only at the start of a block or after whitespace, never inside code.
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return false;
          const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
          return before === "" || /\s$/.test(before);
        },
        items: ({ query, editor }) => {
          const q = query.toLowerCase().trim();
          const all = editor.isActive("table") ? [...tableSlashItems(editor), ...slashItems(opts)] : slashItems(opts);
          return all.filter((i) => !q || fuzzyIncludes(`${i.title} ${i.keywords}`, q) || i.id.startsWith(q));
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: popupRenderer<SlashItem>("Kein Befehl gefunden"),
      }),
    ];
  },
});

// ---------------------------------------------------------------- images

export interface ImageOptions {
  /** URL for an attachment name (`bild.png`). */
  resolve: (name: string) => string;
  /** Stores a pasted or dropped file; returns its attachment name. */
  upload: ((file: File) => Promise<string | null>) | null;
}

const IMAGE_EXT = "png|jpe?g|gif|webp|svg";
const EMBED_RE = new RegExp(`^!\\[\\[([^\\]|\\n]+?\\.(?:${IMAGE_EXT}))(?:\\|([^\\]\\n]*))?\\]\\]`, "i");

/** `300` or `300x200` after the `|` is a size (Obsidian), anything else the alt text. */
function embedSize(alt: string | null): { width?: string; height?: string } {
  const m = /^(\d+)(?:x(\d+))?$/.exec(alt?.trim() ?? "");
  return m ? { width: m[1], height: m[2] } : {};
}

/** Obsidian embed `![[bild.png]]` / `![[bild.png|300]]` of a stored attachment. */
export const ImageEmbed = Node.create<ImageOptions>({
  name: "imageEmbed",
  group: "inline",
  inline: true,
  atom: true,
  draggable: true,

  addOptions() {
    return { resolve: (name) => `attachments/${encodeURIComponent(name)}`, upload: null };
  },
  addAttributes() {
    return { name: { default: "" }, alt: { default: null } };
  },
  parseHTML() {
    return [{ tag: "img[data-embed]", getAttrs: (el) => ({ name: (el as HTMLElement).dataset.embed, alt: (el as HTMLElement).dataset.alt ?? null }) }];
  },
  renderHTML({ node }) {
    const { name, alt } = node.attrs;
    const size = embedSize(alt);
    return [
      "img",
      {
        "data-embed": name,
        ...(alt != null ? { "data-alt": alt } : {}),
        src: this.options.resolve(name),
        alt: size.width ? name : (alt ?? name),
        title: name,
        class: "embed-image",
        loading: "lazy",
        draggable: "true",
        ...size,
      },
    ];
  },
  renderText: ({ node }) => `![[${node.attrs.name}${node.attrs.alt != null ? "|" + node.attrs.alt : ""}]]`,

  markdownTokenizer: {
    name: "imageEmbed",
    level: "inline",
    start: (src: string) => src.indexOf("![["),
    tokenize(src: string) {
      const m = EMBED_RE.exec(src);
      if (!m) return undefined;
      return { type: "imageEmbed", raw: m[0], name: m[1].trim(), alt: m[2] ?? null };
    },
  },
  parseMarkdown: (token) => ({ type: "imageEmbed", attrs: { name: token.name, alt: token.alt } }),
  renderMarkdown: (node, _h, ctx) =>
    `![[${node.attrs?.name}${node.attrs?.alt != null ? (ctx?.meta?.parentAttrs?.__inTableCell ? "\\|" : "|") + node.attrs.alt : ""}]]`,

  addProseMirrorPlugins() {
    const upload = this.options.upload;
    if (!upload) return [];
    const type = this.type;
    const imageFiles = (list?: FileList | null) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    const insert = async (view: EditorView, files: File[], at?: number) => {
      for (const file of files) {
        const name = await upload(file);
        if (!name || view.isDestroyed) continue;
        const pos = at ?? view.state.selection.from;
        view.dispatch(view.state.tr.insert(Math.min(pos, view.state.doc.content.size), type.create({ name })).scrollIntoView());
        if (at != null) at += 1;
      }
    };
    return [
      new Plugin({
        key: new PluginKey("imagePaste"),
        props: {
          handlePaste(view, event) {
            const files = imageFiles(event.clipboardData?.files);
            if (!files.length) return false;
            event.preventDefault();
            insert(view, files);
            return true;
          },
          handleDrop(view, event, _slice, moved) {
            if (moved) return false;
            const files = imageFiles(event.dataTransfer?.files);
            if (!files.length) return false;
            event.preventDefault();
            insert(view, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
            return true;
          },
        },
      }),
    ];
  },
});

/** Standard Markdown images `![alt](src)`; relative paths (`attachments/x.png`) show the stored attachment. */
export const MarkdownImage = Image.extend<ImageOptions & { inline: boolean; allowBase64: boolean; HTMLAttributes: Record<string, unknown> }>({
  addOptions() {
    return { ...this.parent!(), inline: true, resolve: (name: string) => name, upload: null };
  },
  renderHTML({ HTMLAttributes }) {
    const src = String(HTMLAttributes.src ?? "");
    const local = src && !/^(https?:|data:|blob:|annalo-asset:)/i.test(src);
    let path = src;
    try {
      path = decodeURI(src);
    } catch {
      /* keep as is */
    }
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: local ? this.options.resolve(path) : src, class: "embed-image", loading: "lazy" })];
  },
});

// ------------------------------------------------------------ /zeit + chips

export const TimeEntryChip = Node.create({
  name: "timeEntry",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return { entryId: { default: null }, hours: { default: "" }, target: { default: "" }, text: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "time-entry" }];
  },
  renderHTML({ node }) {
    return ["time-entry", { id: node.attrs.entryId, class: "time-chip" }, `${node.attrs.hours} h · ${node.attrs.target}${node.attrs.text ? " · " + node.attrs.text : ""}`];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "time-chip";
      dom.contentEditable = "false";
      dom.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';
      const label = document.createElement("span");
      label.textContent = `${node.attrs.hours} h`;
      const target = document.createElement("span");
      target.className = "time-chip-target";
      target.textContent = node.attrs.target;
      dom.append(label, target);
      if (node.attrs.text) {
        const t = document.createElement("span");
        t.className = "time-chip-text";
        t.textContent = node.attrs.text;
        dom.append(t);
      }
      dom.title = "Gebuchter Zeiteintrag";
      return { dom };
    };
  },
  markdownTokenizer: {
    name: "timeEntry",
    level: "inline",
    start: (src: string) => src.indexOf("<time-entry"),
    tokenize(src: string) {
      const m = /^<time-entry\s+([^>]*)>([^<]*)<\/time-entry>/.exec(src);
      if (!m) return undefined;
      const attrs: Record<string, string> = {};
      const entities: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" };
      for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&(quot|amp|lt|gt|#39);/g, (_e, n: string) => entities[n]);
      return { type: "timeEntry", raw: m[0], attrs, text: m[2] };
    },
  },
  parseMarkdown: (token) => ({
    type: "timeEntry",
    attrs: { entryId: token.attrs.id ?? null, hours: token.attrs.hours ?? "", target: token.attrs.target ?? "", text: unescapeHtml(token.text ?? "") },
  }),
  renderMarkdown: (node) =>
    `<time-entry id="${node.attrs?.entryId ?? ""}" hours="${escapeAttr(node.attrs?.hours)}" target="${escapeAttr(node.attrs?.target)}">${escapeHtml(node.attrs?.text ?? "")}</time-entry>`,
});

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: unknown) => escapeHtml(String(s ?? "")).replace(/"/g, "&quot;");
const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

export interface ZeitResult {
  entryId: number;
  hours: string;
  target: string;
  text: string;
}

/** Enter on a paragraph that starts with `/zeit …` books the time and turns the line into a chip. */
export const ZeitCommand = Extension.create<
  { book: (line: string) => Promise<ZeitResult | null>; onLost: (res: ZeitResult) => void },
  { pending: Set<string> }
>({
  name: "zeitCommand",
  addOptions() {
    return { book: async () => null, onLost: () => {} };
  },
  addStorage() {
    return { pending: new Set<string>() };
  },
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "paragraph") return false;
        const text = $from.parent.textContent.trim();
        // `/zeit NP-8801/1020 2h …`, or `/zeit 2h …` on a page linked to a Vorgang.
        if (!/^\/(zeit|time)\s+(\S+\s+\S+|\d\S*$)/i.test(text)) return false;
        // A second Enter while the booking is in flight must not book twice.
        const pending = this.storage.pending;
        if (pending.has(text)) return true;
        pending.add(text);
        const start = $from.start();
        this.options
          .book(text)
          .then((res) => {
            if (!res || editor.isDestroyed) return;
            // Find the line again: at its old position, else anywhere (the doc may have changed).
            let from = -1;
            const at = editor.state.doc.nodeAt(start - 1);
            if (at?.type.name === "paragraph" && at.textContent.trim() === text) from = start;
            else
              editor.state.doc.descendants((node, pos) => {
                if (from >= 0) return false;
                if (node.type.name === "paragraph" && node.textContent.trim() === text) {
                  from = pos + 1;
                  return false;
                }
                return true;
              });
            if (from < 0) return this.options.onLost(res);
            const to = from + editor.state.doc.nodeAt(from - 1)!.content.size;
            editor
              .chain()
              .insertContentAt({ from, to }, [{ type: "timeEntry", attrs: res }])
              .insertContentAt(from + 1, { type: "paragraph" })
              .run();
            // Caret into the paragraph after the chip's line (not behind the chip).
            const after = editor.state.doc.resolve(from).after();
            editor.commands.focus(Math.min(after + 1, editor.state.doc.content.size));
          })
          .finally(() => pending.delete(text));
        return true;
      },
    };
  },
});

/** An option of the `/zeit` autocomplete; `insert` replaces the token under the caret. */
export interface ZeitSuggestItem extends PopupItem {
  insert: string;
}

export const zeitSuggestKey = new PluginKey("zeitSuggest");

/**
 * Autocomplete inside a `/zeit …` paragraph: Netzplan/Vorgang for the first argument,
 * Leistungsarten after `#`. Runs before the Enter shortcut of ZeitCommand (higher
 * priority), so Enter picks an item while the popup shows one and books otherwise.
 */
export const ZeitSuggest = Extension.create<{
  refs: (query: string) => Promise<ZeitSuggestItem[]>;
  leistungsarten: (query: string) => Promise<ZeitSuggestItem[]>;
}>({
  name: "zeitSuggest",
  priority: 1000,
  addOptions() {
    return { refs: async () => [], leistungsarten: async () => [] };
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [
      Suggestion<ZeitSuggestItem>({
        editor: this.editor,
        pluginKey: zeitSuggestKey,
        char: "/zeit",
        findSuggestionMatch: ({ $position }) => {
          if ($position.parent.type.name !== "paragraph") return null;
          const before = $position.parent.textBetween(0, $position.parentOffset, undefined, "\ufffc");
          const tok = zeitToken(before);
          if (!tok) return null;
          const from = $position.start() + tok.from;
          return { range: { from, to: $position.pos }, query: (tok.kind === "la" ? "#" : "") + tok.query, text: before.slice(tok.from) };
        },
        items: ({ query }) => (query.startsWith("#") ? opts.leistungsarten(query.slice(1)) : opts.refs(query)),
        command: ({ editor, range, props }) => {
          // Replace the whole word, also the part after the caret.
          const $to = editor.state.doc.resolve(range.to);
          const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, "\ufffc");
          const rest = /^\S*/.exec(after)![0].length;
          const spaceFollows = /^\s/.test(after.slice(rest));
          const to = range.to + rest;
          editor
            .chain()
            .focus()
            .insertContentAt({ from: range.from, to }, { type: "text", text: props.insert + (spaceFollows ? "" : " ") })
            .setTextSelection(range.from + props.insert.length + 1)
            .run();
        },
        render: popupRenderer<ZeitSuggestItem>(null, "zeit"),
      }),
    ];
  },
});

// ---------------------------------------------------------------- #tags

const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gu;
const DUE_RE = /(?:📅\s?|\bdue:)\d{4}-\d{2}-\d{2}\b/gu;

export const TagHighlight = Extension.create<{ onOpen: (tag: string) => void }>({
  name: "tagHighlight",
  addOptions() {
    return { onOpen: () => {} };
  },
  addProseMirrorPlugins() {
    const onOpen = this.options.onOpen;
    const build = (doc: PMNode) => {
      const decos: Decoration[] = [];
      doc.descendants((node, pos, parent) => {
        if (!node.isText || parent?.type.spec.code || node.marks.some((m) => m.type.name === "code")) return;
        const text = node.text ?? "";
        for (const m of text.matchAll(TAG_RE)) {
          const from = pos + (m.index ?? 0) + m[1].length;
          decos.push(Decoration.inline(from, from + m[2].length + 1, { class: "tag", "data-tag": m[2].toLowerCase(), nodeName: "span" }));
        }
        // Task due dates (📅 2026-09-30, due:2026-09-30).
        for (const m of text.matchAll(DUE_RE)) {
          const from = pos + (m.index ?? 0);
          decos.push(Decoration.inline(from, from + m[0].length, { class: "due-date", nodeName: "span" }));
        }
      });
      return DecorationSet.create(doc, decos);
    };
    return [
      new Plugin({
        key: new PluginKey("tagHighlight"),
        state: {
          init: (_, { doc }) => build(doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest<HTMLElement>(".tag[data-tag]");
            if (!el) return false;
            onOpen(el.dataset.tag!);
            return true;
          },
        },
      }),
    ];
  },
});

// ---------------------------------------------------------- frontmatter

/** Splits YAML frontmatter off so the editor never mangles it. */
export function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  // A leading horizontal rule is not frontmatter: the first line must be a `key:`.
  if (!m || !FIRST_LINE_RE.test(m[1].split(/\r?\n/)[0])) return { frontmatter: "", body: md };
  return { frontmatter: m[0].endsWith("\n") ? m[0] : m[0] + "\n", body: md.slice(m[0].length).replace(/^\r?\n/, "") };
}

// ------------------------------------------------------------- callouts

const CALLOUT_RE = /^\[!(\w+)\][+-]?[ \t]*/;
const CALLOUT_LABELS: Record<string, string> = {
  note: "Notiz",
  info: "Info",
  tip: "Tipp",
  hint: "Tipp",
  important: "Wichtig",
  warning: "Warnung",
  caution: "Vorsicht",
  danger: "Gefahr",
  error: "Fehler",
  success: "Erledigt",
  question: "Frage",
  quote: "Zitat",
  example: "Beispiel",
  todo: "Aufgabe",
  abstract: "Zusammenfassung",
  summary: "Zusammenfassung",
  bug: "Fehler",
  failure: "Fehlschlag",
};

/** Styles Obsidian callouts (`> [!note] Title`) without changing the Markdown. */
export const Callouts = Extension.create({
  name: "callouts",
  addProseMirrorPlugins() {
    const build = (doc: PMNode) => {
      const decos: Decoration[] = [];
      doc.descendants((node, pos) => {
        if (node.type.name !== "blockquote") return true;
        const first = node.firstChild;
        const m = first?.isTextblock ? CALLOUT_RE.exec(first.textContent) : null;
        if (m) {
          const type = m[1].toLowerCase();
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: `callout callout-${type}`, "data-callout": type }));
          const start = pos + 2; // blockquote open + paragraph open
          // A custom title replaces the type label (Obsidian shows one or the other).
          const hasTitle = first!.firstChild?.isText === true && (first!.firstChild.text ?? "").slice(m[0].length).trim() !== "";
          const label = hasTitle ? "" : (CALLOUT_LABELS[type] ?? type);
          // Covers the trailing space too, so the hidden marker leaves no gap before the title.
          decos.push(Decoration.inline(start, start + m[0].length, { class: "callout-marker", "data-label": label }));
          // Title = rest of the first line (up to a line break).
          let end = start;
          let stop = false;
          first!.forEach((child, offset) => {
            if (stop) return;
            if (child.type.name === "hardBreak") {
              stop = true;
              return;
            }
            const text = child.isText ? child.text! : "";
            const nl = text.indexOf("\n");
            end = start + offset + (nl >= 0 ? nl : child.nodeSize);
            if (nl >= 0) stop = true;
          });
          const titleFrom = start + m[0].length;
          if (end > titleFrom) decos.push(Decoration.inline(titleFrom, end, { class: "callout-title" }));
        }
        return false;
      });
      return DecorationSet.create(doc, decos);
    };
    return [
      new Plugin({
        key: new PluginKey("callouts"),
        state: {
          init: (_, { doc }) => build(doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});
