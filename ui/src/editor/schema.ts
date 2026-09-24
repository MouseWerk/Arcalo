// The editor schema shared by the app and the Markdown round-trip tests.

import { Extension, type Editor, type Extensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Paragraph from "@tiptap/extension-paragraph";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableKit, renderTableToMarkdown } from "@tiptap/extension-table";
import Highlight from "@tiptap/extension-highlight";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import Link from "@tiptap/extension-link";
import { Callouts, ImageEmbed, MarkdownImage, SlashCommand, TagHighlight, TimeEntryChip, WikiLink, WikiLinkSuggest, ZeitCommand, ZeitSuggest, type LinkSuggestItem, type ZeitResult, type ZeitSuggestItem } from "./extensions";
import { FindInPage } from "./find";
import { DrawingEmbed } from "./drawing";
import { AttachmentDrop, FileEmbed } from "./fileEmbed";
import { CiteFlash } from "./reveal";
import { TYPING_DEFAULTS, TypingAids, type TypingPrefs } from "./typing";

const lowlight = createLowlight(common);

/**
 * Escapes only what would change meaning when the Markdown is parsed again.
 * The default serializer escapes every `[ ] _ * ~`, which litters files
 * (`a\_b`, `\[Entwurf\]`) that Obsidian users read and edit directly.
 */
export function escapeText(t: string, atLineStart = true): string {
  const s = t
    .replace(/\\(?=[\\`*_[\]~=#<>!|.)+-])/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/\[([^\]\n]*)\]\(/g, "\\[$1\\](")
    .replace(/(^|[^\p{L}\p{N}*\\])\*(?=\S)/gu, "$1\\*")
    .replace(/([^\s\\])\*(?=$|[^\p{L}\p{N}*])/gu, "$1\\*")
    .replace(/(^|[^\p{L}\p{N}_\\])_(?=\S)/gu, "$1\\_")
    .replace(/([^\s\\])_(?=$|[^\p{L}\p{N}_])/gu, "$1\\_")
    .replace(/~~/g, "\\~\\~")
    .replace(/==/g, "\\=\\=")
    .replace(/&(?=#?\w+;)/g, "&amp;")
    .replace(/<(?=[A-Za-z/!])/g, "&lt;");
  return s
    .split("\n")
    .map((line, i) => (i > 0 || atLineStart ? escapeLineStart(line) : line))
    .join("\n");
}

/** Escapes what would turn a line into a block (heading, list, quote, setext underline). */
function escapeLineStart(line: string): string {
  if (/^\s{0,3}(?:-+|=+)\s*$/.test(line)) return line.replace(/^(\s*)/, "$1\\");
  return line.replace(/^(\s{0,3})(#{1,6}(?=\s|$)|[-+*](?=\s|$)|>)/, "$1\\$2").replace(/^(\s{0,3}\d+)([.)])(?=\s|$)/, "$1\\$2");
}

/** Marks paragraphs rendered inside table cells, where `|` must be escaped. */
export const IN_TABLE_CELL = "__inTableCell";

interface JsonNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  marks?: (string | { type: string })[];
}

function markTableCells(node: JsonNode): JsonNode {
  const mark = (n: JsonNode): JsonNode => ({ ...n, attrs: { ...n.attrs, [IN_TABLE_CELL]: true }, content: n.content?.map(mark) });
  return {
    ...node,
    content: node.content?.map((row) => ({ ...row, content: row.content?.map((cell) => ({ ...cell, content: cell.content?.map(mark) })) })),
  };
}

const MarkdownTable = Table.extend({
  renderMarkdown: (node, h) => renderTableToMarkdown(markTableCells(node as JsonNode) as typeof node, h),
});

interface SerializerInternals {
  codeTypes: Set<string>;
  encodeTextForMarkdown: (text: string, node: JsonNode, parent?: JsonNode) => string;
}

/** Installs the minimal escaping on the editor's Markdown serializer. */
const MarkdownFidelity = Extension.create({
  name: "markdownFidelity",
  onBeforeCreate() {
    const manager = (this.editor as unknown as { markdown?: SerializerInternals }).markdown;
    if (!manager) return;
    manager.encodeTextForMarkdown = (text, node, parent) => {
      const inCode = (parent?.type != null && manager.codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => manager.codeTypes.has(typeof m === "string" ? m : m.type));
      if (inCode) return text;
      const siblings = parent?.content ?? [];
      const idx = siblings.indexOf(node);
      const atLineStart = !node.marks?.length && (idx === 0 || (idx > 0 && siblings[idx - 1].type === "hardBreak"));
      const out = escapeText(text, atLineStart);
      return parent?.attrs?.[IN_TABLE_CELL] ? out.replace(/\|/g, "\\|") : out;
    };
  },
});

/** Unescapes what `escapeText` added, to compare link text with its href. */
const unescapeText = (t: string) => t.replace(/\\([\\`*_[\]~=#<>!|().+-])/g, "$1").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

// Marks are serialized as opening/closing strings without seeing their text,
// so links are bracketed with sentinels and resolved in `cleanMarkdown`.
const LINK_OPEN = "\uE000";
const LINK_CLOSE = "\uE001";

/** Bare URLs and e-mail addresses stay bare instead of becoming `[x](x)`. */
export function linkMarkdown(text: string, href: string, title?: string | null): string {
  if (!title) {
    const plain = unescapeText(text);
    if (plain === href) return href;
    if (href === `mailto:${plain}`) return plain;
    if (plain.startsWith("www.") && href === `http://${plain}`) return plain;
  }
  return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`;
}

const MarkdownLink = Link.extend({
  renderMarkdown: (node, h) => {
    const href: string = node.attrs?.href ?? "";
    const title: string = node.attrs?.title ?? "";
    return `${LINK_OPEN}[${h.renderChildren(node)}](${href}${title ? ` "${title.replace(/[\\"]/g, "\\$&")}"` : ""})${LINK_CLOSE}`;
  },
});

const LINK_RE = new RegExp(`${LINK_OPEN}\\[([^${LINK_OPEN}${LINK_CLOSE}]*)\\]\\(((?:[^\\s()]|\\([^\\s()]*\\))*)(?: "((?:[^"\\\\]|\\\\.)*)")?\\)${LINK_CLOSE}`, "g");

export interface SchemaOptions {
  onOpenLink?: (target: string, newTab: boolean) => void;
  onOpenTag?: (tag: string) => void;
  isKnown?: (target: string) => boolean;
  searchPages?: (q: string) => Promise<LinkSuggestItem[]>;
  book?: (line: string) => Promise<ZeitResult | null>;
  /** Booked, but the `/zeit` line is gone from the document. */
  onZeitLost?: (res: ZeitResult) => void;
  /** URL of an attachment name. */
  attachmentUrl?: (name: string) => string;
  /** Stores a pasted/dropped image, returns the attachment name. */
  uploadImage?: (file: File) => Promise<string | null>;
  /** Stores any other pasted/dropped file under its name, returns the attachment name. */
  uploadFile?: (file: File) => Promise<string | null>;
  /** Slash „Datei einfügen“: file dialog, embeds the chosen files. */
  onPickFile?: (editor: Editor) => void;
  /** Size of an attachment in bytes (`null`: missing), for file chips. */
  attachmentSize?: (name: string) => Promise<number | null>;
  /** Click on a file chip: opens the file in its default app. */
  onOpenFile?: (name: string) => void;
  /** Click on a PDF card: opens the PDF viewer. */
  onOpenPdf?: (name: string, page: number | null) => void;
  /** Renders the first page of a PDF into a canvas; resolves to the page count. */
  renderPdfPreview?: (name: string, canvas: HTMLCanvasElement, width: number) => Promise<number>;
  onPickTemplate?: (editor: Editor) => void;
  onPickImage?: (editor: Editor) => void;
  /** Slash „KI bearbeiten“: inline AI bar on the current block. */
  onAi?: (editor: Editor) => void;
  /** Slash „Zusammenfassung“: meeting summary of the page. */
  onSummary?: (editor: Editor) => void;
  /** Slash „Zeichnung“: new drawing at the caret. */
  onInsertDrawing?: (editor: Editor) => void;
  /** Click on a drawing embed: opens the drawing editor. */
  onOpenDrawing?: (name: string) => void;
  /** `/zeit` autocomplete: Netzplan/Vorgang options for the typed query. */
  zeitRefs?: (query: string) => Promise<ZeitSuggestItem[]>;
  /** `/zeit` autocomplete: Leistungsarten after `#`. */
  zeitLeistungsarten?: (query: string) => Promise<ZeitSuggestItem[]>;
  /** Typing aids (Settings → Editor), read on every keystroke. */
  typing?: () => TypingPrefs;
}

/**
 * Paragraphs as in StarterKit, except that a line with only `![alt](src)` stays a paragraph:
 * Tiptap unwraps it for block images, but images are inline here (`MarkdownImage`), and an
 * image directly in the document is invalid content that breaks the first edit.
 */
const ImageParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens ?? [];
    if (tokens.length === 1 && tokens[0].type === "image") return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
    return Paragraph.config.parseMarkdown!(token, helpers);
  },
});

export function buildExtensions(o: SchemaOptions = {}): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      codeBlock: false,
      link: false,
      paragraph: false,
    }),
    ImageParagraph,
    MarkdownLink.configure({ openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: "noopener noreferrer", target: null } }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight,
    TableKit.configure({ table: false }),
    MarkdownTable.configure({ resizable: false }),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === "heading" ? "Überschrift" : "Schreibe etwas, / für Befehle, [[ für Links"),
      showOnlyCurrent: true,
    }),
    Markdown,
    MarkdownFidelity,
    WikiLink.configure({ onOpen: o.onOpenLink ?? (() => {}), isKnown: o.isKnown ?? (() => true) }),
    WikiLinkSuggest.configure({ search: o.searchPages ?? (async () => []) }),
    SlashCommand.configure({ onTemplate: o.onPickTemplate ?? null, onImage: o.onPickImage ?? null, onAi: o.onAi ?? null, onSummary: o.onSummary ?? null, onDrawing: o.onInsertDrawing ?? null, onFile: o.onPickFile ?? null }),
    ImageEmbed.configure({ resolve: o.attachmentUrl ?? ((n) => `attachments/${encodeURIComponent(n)}`) }),
    FileEmbed.configure({
      size: o.attachmentSize ?? (async () => null),
      onOpen: o.onOpenFile ?? (() => {}),
      onOpenPdf: o.onOpenPdf ?? (() => {}),
      renderPdfPreview: o.renderPdfPreview ?? null,
    }),
    AttachmentDrop.configure({ uploadImage: o.uploadImage ?? null, uploadFile: o.uploadFile ?? null }),
    MarkdownImage.configure({ resolve: o.attachmentUrl ?? ((n) => n) }),
    DrawingEmbed.configure({ resolve: o.attachmentUrl ?? ((n) => `attachments/${encodeURIComponent(n)}`), onOpen: o.onOpenDrawing ?? (() => {}) }),
    TimeEntryChip,
    ZeitCommand.configure({ book: o.book ?? (async () => null), onLost: o.onZeitLost ?? (() => {}) }),
    ZeitSuggest.configure({ refs: o.zeitRefs ?? (async () => []), leistungsarten: o.zeitLeistungsarten ?? (async () => []) }),
    TagHighlight.configure({ onOpen: o.onOpenTag ?? (() => {}) }),
    FindInPage,
    Callouts,
    CiteFlash,
    TypingAids.configure({ prefs: o.typing ?? (() => TYPING_DEFAULTS) }),
  ];
}

/**
 * Serializes the document and removes escapes the serializer adds but that
 * Obsidian-style Markdown does not need (callout markers, task brackets,
 * wiki-link brackets in plain text).
 */
export function toMarkdown(editor: Editor): string {
  return cleanMarkdown(editor.getMarkdown());
}

export function cleanMarkdown(md: string): string {
  return (
    md
      .replace(LINK_RE, (_m, text: string, href: string, title?: string) => linkMarkdown(text, href, title))
      .replace(new RegExp(`[${LINK_OPEN}${LINK_CLOSE}]`, "g"), "")
      .replace(/^((?:>\s?)+)\\\[!(\w+)\\\]/gm, "$1[!$2]")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+/, "")
      .trimEnd() + "\n"
  );
}
