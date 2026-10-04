// Custom TipTap extensions: wiki links, [[ autocomplete, slash commands,
// /zeit booking, #tag and due-date highlighting, time-entry chips and image embeds.

import { Extension, InputRule, Node, mergeAttributes, type Editor, type Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import Image from "@tiptap/extension-image";
import {
  type LucideIcon, LayoutDashboard, ListCollapse, Columns2, Columns3, ListTree, Superscript, AlertTriangle, Info, CheckSquare, Code2, FilePlus2, Heading1, Heading2, Heading3, Link2, List, ListOrdered, Minus, Quote, Table2, Text, Timer, CalendarDays, CalendarClock, Highlighter, ImagePlus, LayoutTemplate, Sparkles, NotebookPen, PenTool, Paperclip, Ticket, Mic, Workflow, ListFilter, FileInput,
} from "lucide-react";
import { fmtDate, isoDay } from "../lib/format";
import { popupRenderer, type PopupItem } from "./suggestion-popup";
import { PageIcon } from "../components/icons";
import { zeitCommand, zeitToken } from "./zeit-suggest";
import { calloutType } from "../lib/callouts";
import { parseDue } from "../lib/capture";
import { timeTrackingEnabled } from "../lib/timetracking";
import { FIRST_LINE_RE } from "../lib/frontmatter";
import { TABLE_ACTIONS, tableActionEnabled } from "./table-actions";
import { keys } from "../lib/shortcut";
import { insertColumns, insertFootnote } from "./blocks";
import { blockDecorations, updateBlockDecorations } from "./incremental";
import { baseName, fileIcon, fileKind, isFileLinkTarget, isPdfName } from "./fileEmbed";
import { splitTarget } from "./embedSyntax";
import { inOtherLanguage, t, type TKey } from "../lib/i18n";
import { jiraReady, requestCreateIssue } from "./taskIssue";
import { useApp } from "../store/app";

// ------------------------------------------------------------- wiki links

export interface WikiLinkOptions {
  /** `anchor`: the heading or `^block` after `#` to show (`target` "" is the same page). */
  onOpen: (target: string, newTab: boolean, anchor: string | null) => void;
  isKnown: (target: string) => boolean;
  /** Size in bytes of an attachment (`null`: missing), for `[[Angebot.pdf]]` file links. */
  fileSize: (name: string) => Promise<number | null>;
  /** Opens the file of a file link (`anchor`: `page=3` of `[[a.pdf#page=3]]`). */
  onOpenFile: (name: string, anchor: string | null) => void;
}

/**
 * The link at the caret, for Alt+Enter: a selected wiki link or one right before/after the caret,
 * else a web link the caret is in.
 */
export function linkAtCaret(state: EditorState): { wiki: { target: string; anchor: string | null } } | { href: string } | null {
  const sel = state.selection as EditorState["selection"] & { node?: PMNode };
  const wikiOf = (n: PMNode | null | undefined) => (n?.type.name === "wikiLink" ? { wiki: { target: n.attrs.target as string, anchor: (n.attrs.anchor as string | null) ?? null } } : null);
  const selected = wikiOf(sel.node);
  if (selected) return selected;
  const { $from } = sel;
  const near = wikiOf($from.nodeAfter) ?? wikiOf($from.nodeBefore);
  if (near) return near;
  const link = [...$from.marks(), ...($from.nodeAfter?.marks ?? [])].find((m) => m.type.name === "link");
  return link?.attrs.href ? { href: link.attrs.href as string } : null;
}

/** What a wiki link shows: its alias, `Seite › Abschnitt`, or only the section on the same page. */
export function wikiLabel(node: { attrs: Record<string, unknown> }): string {
  const { target, anchor, alias } = node.attrs as { target: string; anchor: string | null; alias: string | null };
  if (alias) return alias;
  if (!anchor) return target;
  return target ? `${target} › ${anchor}` : anchor;
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { onOpen: () => {}, isKnown: () => true, fileSize: async () => null, onOpenFile: () => {} };
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
    const label = wikiLabel(node);
    return ["a", mergeAttributes(HTMLAttributes, { "data-wikilink": "", "data-target": node.attrs.target, class: "wikilink" }), label];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("a");
      dom.dataset.wikilink = "";
      dom.dataset.target = node.attrs.target;
      // `[[Angebot.pdf]]` with no page of that title: a link to the attachment, never a page to create.
      if (!this.options.isKnown(node.attrs.target) && isFileLinkTarget(node.attrs.target)) return fileLinkView(dom, node, this.options);
      const known = !node.attrs.target || this.options.isKnown(node.attrs.target);
      dom.className = `wikilink${known ? "" : " unresolved"}`;
      dom.textContent = wikiLabel(node);
      dom.title = known ? (node.attrs.target ? node.attrs.target + (node.attrs.anchor ? ` › ${node.attrs.anchor}` : "") : node.attrs.anchor) : t("ed.unresolved", { target: node.attrs.target });
      dom.addEventListener("mousedown", (e) => {
        if (e.button !== 0 && e.button !== 1) return;
        e.preventDefault();
        this.options.onOpen(node.attrs.target, e.ctrlKey || e.metaKey || e.button === 1, node.attrs.anchor ?? null);
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
      // `[[#Abschnitt]]`: a heading (or `#^id` block) of the same page.
      const m = /^\[\[([^\]|#\n]*)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/.exec(src);
      if (!m || (!m[1].trim() && !m[2]?.trim())) return undefined;
      return { type: "wikiLink", raw: m[0], target: m[1].trim(), anchor: m[2]?.trim() ?? null, alias: m[3]?.trim() ?? null };
    },
  },
  parseMarkdown: (token) => ({ type: "wikiLink", attrs: { target: token.target, anchor: token.anchor, alias: token.alias } }),
  // Inside a table cell (marked by schema.ts) the alias pipe must be `\|`.
  renderMarkdown: (node, _h, ctx) =>
    `[[${node.attrs?.target}${node.attrs?.anchor ? "#" + node.attrs.anchor : ""}${node.attrs?.alias ? (ctx?.meta?.parentAttrs?.__inTableCell ? "\\|" : "|") + node.attrs.alias : ""}]]`,
});

/** The node view of a wiki link to a file: type icon and name, marked when the file is missing. */
function fileLinkView(dom: HTMLAnchorElement, node: PMNode, o: WikiLinkOptions) {
  const target: string = node.attrs.target;
  const name = baseName(target.trim());
  const pdf = isPdfName(name);
  dom.dataset.fileLink = name;
  dom.className = "wikilink file-link";
  const icon = document.createElement("span");
  icon.className = "file-link-icon";
  icon.append(fileIcon(fileKind(name), 14));
  const label = document.createElement("span");
  label.textContent = node.attrs.alias || name;
  dom.append(icon, label);
  const hint = pdf ? t("ed.clickView") : t("ed.clickOpen");
  dom.title = `${name} – ${hint}`;
  let alive = true;
  o.fileSize(name).then(
    (n) => {
      if (!alive) return;
      dom.classList.toggle("is-missing", n == null);
      dom.title = n == null ? `${name} – ${t("ed.fileMissing")}` : `${name} – ${hint}`;
    },
    () => {},
  );
  dom.addEventListener("mousedown", (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    o.onOpenFile(name, node.attrs.anchor ?? null);
  });
  return { dom, destroy: () => void (alive = false) };
}

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
        // `![[` (page embed) completes like a link.
        allowedPrefixes: [" ", "!"],
        items: ({ query }) => this.options.search(query),
        command: ({ editor, range, props }) => {
          // Swallow an auto-closed "]]" right after the caret.
          const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size), "");
          const to = after === "]]" ? range.to + 2 : range.to;
          // `![[`: a page embed; `Seite#Überschrift` from the heading list keeps its anchor.
          const embed = range.from > 1 && editor.state.doc.textBetween(range.from - 1, range.from, "") === "!";
          const { target, anchor } = props.create ? { target: props.target, anchor: null } : splitTarget(props.target);
          editor
            .chain()
            .focus()
            .insertContentAt({ from: embed ? range.from - 1 : range.from, to }, [
              { type: embed ? "pageEmbed" : "wikiLink", attrs: { target, anchor: anchor || null } },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: popupRenderer<LinkSuggestItem>(() => t("ed.typePage")),
      }),
    ];
  },
});

export function pageSuggestItem(p: { id: number; title: string; icon: string | null }, subtitle?: string): LinkSuggestItem {
  return { id: `p${p.id}`, title: p.title, target: p.title, subtitle, icon: <PageIcon name={p.icon} size={15} /> };
}

// ----------------------------------------------------------- slash menu

export interface SlashItem extends PopupItem {
  keywords: string;
  run: (editor: Editor, range: Range) => void;
  /** The icon as a component (menus of the editor toolbar). */
  Icon?: LucideIcon;
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
  /** Opens the file dialog and embeds the chosen files (`![[Angebot.pdf]]`). */
  onFile: ((editor: Editor) => void) | null;
  /** `/voice` (`/sprache`): records a voice note whose transcript goes into this page. */
  onVoice?: ((editor: Editor) => void) | null;
}

/** The slash menu; `/zeit` (`/time`) only while time tracking is on. */
export function slashItems(o: SlashOptions, time = timeTrackingEnabled()): SlashItem[] {
  return allSlashItems(o).filter((i) => time || i.id !== "zeit");
}

function allSlashItems(o: SlashOptions): SlashItem[] {
  const today = fmtDate(new Date());
  const isoToday = isoDay(new Date());
  const basics = t("slash.sec.basics");
  const lists = t("slash.sec.lists");
  const blocks = t("slash.sec.blocks");
  const insert = t("slash.sec.insert");
  return [
    { id: "text", title: t("slash.text"), icon: ic(Text), Icon: Text, section: basics, keywords: "absatz paragraph text", run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
    { id: "h1", title: t("slash.h1"), icon: ic(Heading1), Icon: Heading1, hint: "#", section: basics, keywords: "heading titel title überschrift h1", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
    { id: "h2", title: t("slash.h2"), icon: ic(Heading2), Icon: Heading2, hint: "##", section: basics, keywords: "heading überschrift h2", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
    { id: "h3", title: t("slash.h3"), icon: ic(Heading3), Icon: Heading3, hint: "###", section: basics, keywords: "heading überschrift h3", run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
    { id: "todo", title: t("slash.todo"), icon: ic(CheckSquare), Icon: CheckSquare, hint: "[ ]", section: lists, keywords: "todo task checkbox aufgabe aufgabenliste", run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { id: "ul", title: t("slash.ul"), icon: ic(List), Icon: List, hint: "-", section: lists, keywords: "bullet liste list aufzählung", run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { id: "ol", title: t("slash.ol"), icon: ic(ListOrdered), Icon: ListOrdered, hint: "1.", section: lists, keywords: "ordered nummer numbered nummerierte", run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { id: "quote", title: t("slash.quote"), icon: ic(Quote), Icon: Quote, hint: ">", section: blocks, keywords: "quote zitat", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { id: "callout", title: t("slash.callout"), subtitle: t("slash.callout.sub"), icon: ic(Info), Icon: Info, section: blocks, keywords: "callout hinweis hinweisbox info note", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().insertContent("[!note] ").run() },
    { id: "warn", title: t("slash.warn"), icon: ic(AlertTriangle), Icon: AlertTriangle, section: blocks, keywords: "callout warnung warnbox warning", run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().insertContent("[!warning] ").run() },
    { id: "fold", title: t("slash.fold"), subtitle: t("slash.fold.sub"), icon: ic(ListCollapse), Icon: ListCollapse, section: blocks, keywords: "aufklappbar einklappen toggle details collapsible falten callout fold", run: (e, r) => insertFoldable(e, r) },
    { id: "columns2", title: t("slash.columns2"), subtitle: t("slash.columns.sub"), icon: ic(Columns2), Icon: Columns2, section: blocks, keywords: "spalten columns layout nebeneinander zwei two", run: (e, r) => (e.chain().focus().deleteRange(r).run(), insertColumns(e, 2)) },
    { id: "columns3", title: t("slash.columns3"), subtitle: t("slash.columns.sub"), icon: ic(Columns3), Icon: Columns3, section: blocks, keywords: "spalten columns layout nebeneinander drei three", run: (e, r) => (e.chain().focus().deleteRange(r).run(), insertColumns(e, 3)) },
    { id: "toc", title: t("slash.toc"), subtitle: t("slash.toc.sub"), icon: ic(ListTree), Icon: ListTree, section: blocks, keywords: "inhaltsverzeichnis toc inhalt gliederung überschriften contents outline", run: (e, r) => e.chain().focus().deleteRange(r).insertContent({ type: "tableOfContents" }).run() },
    { id: "code", title: t("slash.code"), icon: ic(Code2), Icon: Code2, hint: "```", section: blocks, keywords: "code snippet codeblock", run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { id: "mermaid", title: t("slash.mermaid"), subtitle: t("slash.mermaid.sub"), icon: ic(Workflow), Icon: Workflow, hint: "```mermaid", section: blocks, keywords: "mermaid diagramm diagram flowchart flussdiagramm sequenz sequence gantt mindmap klassen class state er", run: (e, r) => e.chain().focus().deleteRange(r).setNode("codeBlock", { language: "mermaid" }).insertContent(t("slash.mermaid.starter")).run() },
    { id: "query", title: t("slash.query"), subtitle: t("slash.query.sub"), icon: ic(ListFilter), Icon: ListFilter, hint: "```query", section: blocks, keywords: "abfrage query filter aufgaben tasks seiten pages liste tabelle table dataview", run: (e, r) => e.chain().focus().deleteRange(r).setNode("codeBlock", { language: "query" }).insertContent(t("slash.query.starter")).run() },
    { id: "embed", title: t("slash.embed"), subtitle: t("slash.embed.sub"), icon: ic(FileInput), Icon: FileInput, hint: "![[", section: insert, keywords: "einbetten embed transclude seite page abschnitt section block", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("![[").run() },
    { id: "table", title: t("slash.table"), icon: ic(Table2), Icon: Table2, section: blocks, keywords: "table tabelle", run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: "hr", title: t("slash.hr"), icon: ic(Minus), Icon: Minus, hint: "---", section: blocks, keywords: "divider linie trennlinie hr line", run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
    { id: "mark", title: t("slash.mark"), icon: ic(Highlighter), Icon: Highlighter, hint: "==", section: blocks, keywords: "highlight markieren hervorheben", run: (e, r) => e.chain().focus().deleteRange(r).toggleHighlight().run() },
    { id: "link", title: t("slash.link"), icon: ic(Link2), Icon: Link2, hint: "[[", section: insert, keywords: "link verknüpfung wiki seitenlink page", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
    { id: "date", title: t("slash.date"), icon: ic(CalendarDays), Icon: CalendarDays, hint: today, section: insert, keywords: "datum date heute today", run: (e, r) => e.chain().focus().deleteRange(r).insertContent(today + " ").run() },
    { id: "due", title: t("slash.due"), subtitle: t("slash.due.sub"), icon: ic(CalendarClock), Icon: CalendarClock, hint: `due:${isoToday}`, section: insert, keywords: "fällig due termin deadline aufgabe task", run: (e, r) => {
      // Separate from preceding text, but no double space.
      const before = r.from > 1 ? e.state.doc.textBetween(r.from - 1, r.from) : "";
      e.chain().focus().deleteRange(r).insertContent(`${before && !/\s/.test(before) ? " " : ""}due:${isoToday} `).run();
    } },
    { id: "footnote", title: t("slash.footnote"), subtitle: t("slash.footnote.sub"), icon: ic(Superscript), Icon: Superscript, hint: "[^1]", section: insert, keywords: "fußnote footnote anmerkung quelle note source", run: (e, r) => (e.chain().focus().deleteRange(r).run(), insertFootnote(e)) },
    { id: "zeit", title: t("slash.zeit"), subtitle: t("slash.zeit.sub"), icon: ic(Timer), Icon: Timer, hint: zeitCommand(), section: t("ribbon.timesheet"), keywords: "zeit time buchen stunden book hours log", run: (e, r) => e.chain().focus().deleteRange(r).insertContent(`${zeitCommand()} `).run() },
    ...(jiraReady()
      ? [{ id: "jira", title: t("slash.jira"), subtitle: t("slash.jira.sub"), icon: ic(Ticket), Icon: Ticket, section: insert, keywords: "jira issue ticket vorgang anlegen create", run: (e: Editor, r: Range) => {
          e.chain().focus().deleteRange(r).run();
          const st = useApp.getState();
          const pageId = st.tabs.find((x) => x.id === st.activeTabId)?.pageId ?? null;
          if (!requestCreateIssue(e, e.state.selection.from, pageId)) st.toast({ tone: "info", title: t("jira.notATask") });
        } }]
      : []),
    { id: "canvas", title: t("slash.canvas"), subtitle: t("slash.canvas.sub"), icon: ic(LayoutDashboard), Icon: LayoutDashboard, section: insert, keywords: "canvas board whiteboard tafel karten cards mindmap brainstorming planung planning", run: (e, r) => {
      e.chain().focus().deleteRange(r).run();
      const st = useApp.getState();
      const pageId = st.tabs.find((x) => x.id === st.activeTabId)?.pageId ?? null;
      const at = e.state.selection.from;
      void import("../views/canvas/create").then(({ createCanvas }) =>
        createCanvas(pageId, { open: false }).then((page) => {
          if (!page || e.isDestroyed) return;
          e.chain().focus().insertContentAt(at, [{ type: "wikiLink", attrs: { target: page.title } }, { type: "text", text: " " }]).run();
          useApp.getState().openPage(page.id, { split: true });
        }),
      );
    } },
    { id: "subpage", title: t("slash.subpage"), icon: ic(FilePlus2), Icon: FilePlus2, section: insert, keywords: "seite page unterseite subpage", run: (e, r) => e.chain().focus().deleteRange(r).insertContent("[[").run() },
    ...(o.onImage
      ? [{ id: "image", title: t("slash.image"), subtitle: t("slash.image.sub", { keys: keys("Mod V") }), icon: ic(ImagePlus), Icon: ImagePlus, section: insert, keywords: "bild image foto photo screenshot anhang", run: (e: Editor, r: Range) => (e.chain().deleteRange(r).run(), o.onImage!(e)) }]
      : []),
    ...(o.onFile
      ? [{ id: "file", title: t("slash.file"), subtitle: t("slash.file.sub"), icon: ic(Paperclip), Icon: Paperclip, section: insert, keywords: "datei file anhang pdf dokument document word excel anhängen attachment", run: (e: Editor, r: Range) => (e.chain().deleteRange(r).run(), o.onFile!(e)) }]
      : []),
    ...(o.onDrawing
      ? [{ id: "drawing", title: t("slash.drawing"), subtitle: t("slash.drawing.sub"), icon: ic(PenTool), Icon: PenTool, section: insert, keywords: "zeichnung drawing excalidraw diagramm diagram skizze sketch whiteboard", run: (e: Editor, r: Range) => (e.chain().focus().deleteRange(r).run(), o.onDrawing!(e)) }]
      : []),
    ...(o.onVoice
      ? [{ id: "voice", title: t("slash.voice"), subtitle: t("slash.voice.sub"), icon: ic(Mic), Icon: Mic, section: insert, keywords: "voice sprache sprachnotiz aufnahme aufnehmen record recording diktat dictate transkript transcript mikrofon microphone meeting", run: (e: Editor, r: Range) => (e.chain().focus().deleteRange(r).run(), o.onVoice!(e)) }]
      : []),
    ...(o.onTemplate
      ? [{ id: "template", title: t("slash.template"), subtitle: t("slash.template.sub"), icon: ic(LayoutTemplate), Icon: LayoutTemplate, section: insert, keywords: "vorlage template muster", run: (e: Editor, r: Range) => (e.chain().deleteRange(r).run(), o.onTemplate!(e)) }]
      : []),
    ...(o.onAi
      ? [{ id: "ki", title: t("slash.ai"), subtitle: t("slash.ai.sub"), hint: keys("Mod J"), icon: ic(Sparkles), Icon: Sparkles, section: t("slash.sec.ai"), keywords: "ki ai assistent assistant umschreiben rewrite verbessern improve kürzen shorten übersetzen translate", run: (e: Editor, r: Range) => (e.chain().focus().deleteRange(r).run(), o.onAi!(e)) }]
      : []),
    ...(o.onSummary
      ? [{ id: "summary", title: t("slash.summary"), subtitle: t("slash.summary.sub"), icon: ic(NotebookPen), Icon: NotebookPen, section: t("slash.sec.ai"), keywords: "besprechung meeting protokoll minutes summary zusammenfassung ki ai aufgaben tasks entscheidungen decisions", run: (e: Editor, r: Range) => (e.chain().focus().deleteRange(r).run(), o.onSummary!(e)) }]
      : []),
  ];
}

/** Row/column commands, offered while the cursor is in a table. */
function tableSlashItems(editor: Editor): SlashItem[] {
  return TABLE_ACTIONS.filter((a) => tableActionEnabled(editor.state, a)).map((a) => ({
    id: `table-${a.id}`,
    title: t(a.title),
    icon: ic(a.icon),
    Icon: a.icon,
    section: t("slash.table"),
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

/** A word of `text` starts with `query` (umlaut-tolerant like `fuzzyIncludes`). */
export function wordStarts(text: string, query: string) {
  const q = query.toLowerCase();
  const qAscii = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return text.split(/\s+/).some((w) => fold(w).split(" ").some((f) => f.startsWith(q) || f.startsWith(qAscii)));
}

export const SlashCommand = Extension.create<SlashOptions>({
  name: "slashCommand",
  addOptions() {
    return { onTemplate: null, onImage: null, onAi: null, onSummary: null, onDrawing: null, onFile: null };
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
          const hits = all.filter((i) => !q || fuzzyIncludes(`${i.title} ${inOtherLanguage(i.title, "slash.")} ${i.keywords}`, q) || i.id.startsWith(q));
          // A title word starting with the query first („/zeichn“: Zeichnung before Inhaltsverzeichnis).
          const rank = (i: SlashItem) => (!q || i.id.startsWith(q) || wordStarts(i.title, q) ? 0 : 1);
          return hits.map((i, n) => ({ i, n, r: rank(i) })).sort((a, b) => a.r - b.r || a.n - b.n).map((x) => x.i);
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: popupRenderer<SlashItem>(() => t("ed.noCommand")),
      }),
    ];
  },
});

// ---------------------------------------------------------------- images

export interface ImageOptions {
  /** URL for an attachment name (`bild.png`). */
  resolve: (name: string) => string;
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
    return { resolve: (name) => `attachments/${encodeURIComponent(name)}` };
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
  // Dropped and pasted images are stored by `AttachmentDrop` (fileEmbed.ts), together with other files.
});

/** Standard Markdown images `![alt](src)`; relative paths (`attachments/x.png`) show the stored attachment. */
export const MarkdownImage = Image.extend<ImageOptions & { inline: boolean; allowBase64: boolean; HTMLAttributes: Record<string, unknown> }>({
  addOptions() {
    return { ...this.parent!(), inline: true, resolve: (name: string) => name };
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

// The chip itself and its link to the booking: timeChip.ts.
export { TimeEntryChip } from "./timeChip";

export interface ZeitResult {
  entryId: number;
  hours: string;
  target: string;
  text: string;
  /** Leistungsart and local day (`YYYY-MM-DD`) of the booking (1.12). */
  la?: string;
  date?: string;
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
        // Time tracking off: a `/zeit` line is just text.
        if (!timeTrackingEnabled()) return false;
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
          if ($position.parent.type.name !== "paragraph" || !timeTrackingEnabled()) return null;
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
// `due:` and the calendar marker of Obsidian Tasks (imported notes).
const DUE_RE = /(?:\u{1F4C5}\s?|(?<![\p{L}\p{N}_])(?:due|fällig):)\d{4}-\d{2}-\d{2}\b/giu;

/**
 * `due:tomorrow`, `due:fri`, `fällig:morgen` or `due:next-week`: the word becomes the date
 * (`due:2026-10-02`) once a space follows it. Words in both languages, like quick capture.
 */
export const DueWords = Extension.create({
  name: "dueWords",
  addInputRules() {
    return [
      new InputRule({
        find: /(?<![\p{L}\p{N}_])((?:due|fällig):)([^\s\d+][^\s]*|\+\d{1,3}[dtw]?) $/iu,
        handler: ({ state, range, match }) => {
          const iso = parseDue(match[2].replace(/[-_]/g, " "));
          if (!iso) return null;
          state.tr.insertText(`${match[1]}${iso} `, range.from, range.to);
        },
      }),
    ];
  },
});

export const TagHighlight = Extension.create<{ onOpen: (tag: string) => void }>({
  name: "tagHighlight",
  addOptions() {
    return { onOpen: () => {} };
  },
  addProseMirrorPlugins() {
    const onOpen = this.options.onOpen;
    // Decorations of one top-level block; an edit rebuilds only the blocks it touched.
    const build = (block: PMNode, at: number) => {
      const decos: Decoration[] = [];
      block.descendants((node, offset, parent) => {
        if (!node.isText || parent?.type.spec.code || node.marks.some((m) => m.type.name === "code")) return;
        const pos = at + 1 + offset;
        const text = node.text ?? "";
        for (const m of text.matchAll(TAG_RE)) {
          const from = pos + (m.index ?? 0) + m[1].length;
          decos.push(Decoration.inline(from, from + m[2].length + 1, { class: "tag", "data-tag": m[2].toLowerCase(), nodeName: "span" }));
        }
        // Task due dates (due:2026-09-30).
        for (const m of text.matchAll(DUE_RE)) {
          const from = pos + (m.index ?? 0);
          decos.push(Decoration.inline(from, from + m[0].length, { class: "due-date", nodeName: "span" }));
        }
      });
      return decos;
    };
    return [
      new Plugin({
        key: new PluginKey("tagHighlight"),
        state: {
          init: (_, { doc }) => blockDecorations(doc, build),
          apply: (tr, old) => updateBlockDecorations(old, tr, build),
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
export function splitFrontmatter(md: string): { frontmatter: string; body: string; gap: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  // A leading horizontal rule is not frontmatter: the first line must be a `key:`.
  if (!m || !FIRST_LINE_RE.test(m[1].split(/\r?\n/)[0])) return { frontmatter: "", body: md, gap: "" };
  const rest = md.slice(m[0].length);
  // The blank line between block and text (as written): put back on save, so a save does not change it.
  const gap = /^\r?\n/.exec(rest)?.[0] ?? "";
  return { frontmatter: m[0].endsWith("\n") ? m[0] : m[0] + "\n", body: rest.slice(gap.length), gap };
}

/** Frontmatter, the blank line under it (only with a block) and the text: the inverse of `splitFrontmatter`. */
export function joinFrontmatter(frontmatter: string, gap: string, body: string): string {
  return frontmatter ? frontmatter + gap + body : body;
}

// ------------------------------------------------------------- callouts

const CALLOUT_RE = /^\[!(\w+)\]([+-]?)[ \t]*/;
/** Callout types (as typed after `[!`, English as in Obsidian, German speaker-note aliases) and their labels. */
const CALLOUT_KEYS: Record<string, TKey> = {
  note: "callout.note",
  info: "callout.info",
  tip: "callout.tip",
  hint: "callout.tip",
  important: "callout.important",
  warning: "callout.warning",
  caution: "callout.caution",
  danger: "callout.danger",
  error: "callout.error",
  success: "callout.success",
  question: "callout.question",
  quote: "callout.quote",
  example: "callout.example",
  todo: "callout.todo",
  abstract: "callout.summary",
  summary: "callout.summary",
  bug: "callout.error",
  failure: "callout.failure",
  // Speaker notes of the presentation mode (hidden on the slides).
  notiz: "callout.speaker",
  notizen: "callout.speaker",
  notes: "callout.speaker",
  speaker: "callout.speaker",
  sprecher: "callout.speaker",
};
/** The label of a callout type in the display language (unknown types show as typed). */
export const calloutLabel = (typed: string) => {
  const type = calloutType(typed);
  return CALLOUT_KEYS[type] ? t(CALLOUT_KEYS[type]) : typed;
};

const CHEVRON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/**
 * Toggles a foldable callout (`> [!note]- Titel` collapsed, `+` expanded) at `pos` (the
 * blockquote) by rewriting its marker; a caret inside the hidden part moves to the title.
 */
export function toggleCalloutFold(view: EditorView, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  const first = node?.type.name === "blockquote" ? node.firstChild : null;
  const m = first?.isTextblock ? CALLOUT_RE.exec(first.textContent) : null;
  if (!m || !m[2]) return false;
  const at = pos + 2 + 2 + m[1].length + 1; // blockquote + paragraph open, "[!", type, "]"
  const folding = m[2] === "+";
  const tr = view.state.tr.insertText(folding ? "-" : "+", at, at + 1);
  if (folding) {
    const titleEnd = pos + 2 + first!.content.size;
    const nl = first!.textContent.indexOf("\n");
    const end = nl >= 0 ? pos + 2 + nl : titleEnd;
    const { from } = tr.selection;
    if (from > end && from < pos + node!.nodeSize) tr.setSelection(TextSelection.create(tr.doc, end));
  }
  view.dispatch(tr);
  return true;
}

/** `/Aufklappbar`: an expanded foldable callout with a selected title and an empty line for the content. */
export function insertFoldable(editor: Editor, range: Range) {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent({
      type: "blockquote",
      content: [
        { type: "paragraph", content: [{ type: "text", text: `[!note]+ ${t("slash.fold")}` }] },
        { type: "paragraph" },
      ],
    })
    .run();
  // Select the title so typing replaces it.
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name !== "blockquote") continue;
    const start = $from.before(d) + 2;
    const marker = "[!note]+ ".length;
    editor.commands.setTextSelection({ from: start + marker, to: start + $from.node(d).firstChild!.content.size });
    return;
  }
}

/** Styles Obsidian callouts (`> [!note] Title`) without changing the Markdown; `[!x]-`/`[!x]+` fold. */
export const Callouts = Extension.create({
  name: "callouts",
  addProseMirrorPlugins() {
    // Decorations of the callouts in one top-level block (the outermost quotes only).
    const build = (block: PMNode, at: number) => {
      const decos: Decoration[] = [];
      const visit = (node: PMNode, pos: number) => {
        if (node.type.name !== "blockquote") return true;
        const first = node.firstChild;
        const m = first?.isTextblock ? CALLOUT_RE.exec(first.textContent) : null;
        if (m) {
          const type = calloutType(m[1]);
          const fold = m[2];
          const folded = fold === "-";
          decos.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: `callout callout-${type}${fold ? " is-foldable" : ""}${folded ? " is-folded" : ""}`,
              "data-callout": type,
            }),
          );
          const start = pos + 2; // blockquote open + paragraph open
          if (fold) {
            decos.push(
              Decoration.widget(
                start,
                () => {
                  const b = document.createElement("button");
                  b.type = "button";
                  b.className = "callout-fold";
                  b.contentEditable = "false";
                  b.setAttribute("aria-label", folded ? t("ed.expand") : t("ed.collapse"));
                  b.setAttribute("aria-expanded", String(!folded));
                  b.innerHTML = CHEVRON;
                  return b;
                },
                { side: -1, key: `fold-${folded ? "-" : "+"}`, ignoreSelection: true },
              ),
            );
          }
          // A custom title replaces the type label (Obsidian shows one or the other).
          // Only the first line counts: `> [!question]\n> Text` has no title, the body follows.
          const hasTitle = first!.firstChild?.isText === true && (first!.firstChild.text ?? "").slice(m[0].length).split("\n")[0].trim() !== "";
          const label = hasTitle ? "" : calloutLabel(type);
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
          if (folded) {
            // Hide everything after the title: the rest of the first paragraph and the other blocks.
            const firstEnd = start + first!.content.size;
            if (firstEnd > end) decos.push(Decoration.inline(end, firstEnd, { class: "callout-folded-rest" }));
            node.forEach((child, offset, i) => {
              if (i > 0) decos.push(Decoration.node(pos + 1 + offset, pos + 1 + offset + child.nodeSize, { class: "callout-folded-rest" }));
            });
          }
        }
        return false;
      };
      if (visit(block, at)) block.descendants((node, offset) => visit(node, at + 1 + offset));
      return decos;
    };
    return [
      new Plugin({
        key: new PluginKey("callouts"),
        state: {
          init: (_, { doc }) => blockDecorations(doc, build),
          apply: (tr, old) => updateBlockDecorations(old, tr, build),
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleDOMEvents: {
            mousedown(view, event) {
              const b = (event.target as HTMLElement).closest?.<HTMLElement>(".callout-fold");
              if (!b || event.button !== 0) return false;
              event.preventDefault();
              const quote = b.closest("blockquote");
              if (!quote) return true;
              let pos: number;
              try {
                pos = view.posAtDOM(quote, 0) - 1;
              } catch {
                return true;
              }
              toggleCalloutFold(view, pos);
              return true;
            },
          },
        },
      }),
    ];
  },
});
