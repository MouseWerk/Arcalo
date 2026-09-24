// Formatting toolbar above a note (Settings → Editor „Werkzeugleiste“): history, block type,
// text formatting, lists, and the menus „Einfügen“ (every slash command) and „Werkzeuge“
// (search & replace, case, sort, move, statistics). Scrolls sideways in narrow panes.

import { useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import {
  Bold, CaseSensitive, ChevronDown, Code, Eraser, Highlighter, Italic, Link2, List, ListChecks,
  ListOrdered, MoveDown, MoveUp, Plus, Quote, Redo2, Replace, SquareArrowOutUpRight, SquareCode, Strikethrough, Undo2, Wrench,
  ArrowDownAZ, ArrowUpAZ, ListX, Clock, BarChart3, Sparkles, MoreHorizontal, Heading,
} from "lucide-react";
import { IconButton, useMenu, type MenuEntry } from "../components/ui";
import { keys } from "../lib/shortcut";
import { slashItems, type SlashOptions } from "./extensions";
import { changeSelectionCase, clearFormatting, dedupeSelectedLines, moveBlock, sortSelectedLines, statsText, textStats } from "./tools";
import { useApp } from "../store/app";

type Block = "paragraph" | "h1" | "h2" | "h3" | "h4";
const BLOCKS: { value: Block; label: string }[] = [
  { value: "paragraph", label: "Text" },
  { value: "h1", label: "Überschrift 1" },
  { value: "h2", label: "Überschrift 2" },
  { value: "h3", label: "Überschrift 3" },
  { value: "h4", label: "Überschrift 4" },
];

/** Width of the „Weitere Formatierung“ button with its group separator. */
const MORE_W = 38;
const MAX_LEVEL = 6;

export function EditorToolbar({ editor, onFind, onAi }: { editor: Editor; onFind: (replace: boolean) => void; onAi: () => void }) {
  const [menu, openMenu] = useMenu();
  const [url, setUrl] = useState<string | null>(null);
  // In the header row: groups that do not fit move into „Weitere Formatierung“, the least used
  // first (lists, then quote and code block, then the rarer marks, then undo/redo).
  const bar = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(0);
  const widths = useRef<Record<number, number>>({});
  useLayoutEffect(() => {
    const el = bar.current;
    const host = el?.parentElement;
    if (!el || !host?.classList.contains("vh-toolbar")) return;
    const fit = () => {
      for (const g of el.querySelectorAll<HTMLElement>("[data-collapse]")) {
        if (g.offsetParent) widths.current[Number(g.dataset.collapse)] = g.getBoundingClientRect().width + 8;
      }
      const w = (k: number) => widths.current[k] ?? 0;
      let hidden = 0;
      for (let k = 1; k <= level; k++) hidden += w(k);
      const full = el.scrollWidth - (level > 0 ? MORE_W : 0) + hidden;
      const avail = host.clientWidth;
      let k = 0;
      let need = full;
      while (need > avail && k < MAX_LEVEL) {
        k++;
        need -= w(k);
        if (k === 1) need += MORE_W;
      }
      if (k !== level) setLevel(k);
    };
    fit();
    // On the next frame: changing the toolbar inside the observer's callback would loop.
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [level]);
  const shown = (k: number) => level < k;
  const applyLink = () => {
    const href = (url ?? "").trim();
    setUrl(null);
    if (!/^(https?:\/\/|mailto:)\S+/.test(href)) return editor.commands.focus();
    // Without a selection the address itself becomes the link text.
    if (editor.state.selection.empty) c().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).insertContent(" ").run();
    else c().setLink({ href }).run();
  };
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: ([1, 2, 3, 4].find((l) => e.isActive("heading", { level: l })) ? `h${[1, 2, 3, 4].find((l) => e.isActive("heading", { level: l }))}` : "paragraph") as Block,
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      highlight: e.isActive("highlight"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      empty: e.state.selection.empty,
    }),
  });
  if (!st) return null;
  const c = () => editor.chain().focus();

  const setBlock = (b: Block) => {
    if (b === "paragraph") c().setParagraph().run();
    else c().setHeading({ level: Number(b.slice(1)) as 1 | 2 | 3 | 4 }).run();
  };

  const insertMenu = (): MenuEntry[] => {
    const opts = (editor.extensionManager.extensions.find((x) => x.name === "slashCommand")?.options ?? {}) as SlashOptions;
    const at = editor.state.selection.from;
    const items = slashItems({ onTemplate: opts.onTemplate ?? null, onImage: opts.onImage ?? null, onAi: opts.onAi ?? null, onSummary: opts.onSummary ?? null, onDrawing: opts.onDrawing ?? null, onFile: opts.onFile ?? null });
    const out: MenuEntry[] = [];
    let section = "";
    for (const it of items) {
      if (it.section && it.section !== section && out.length) out.push("separator");
      section = it.section ?? section;
      out.push({ label: it.title, icon: it.Icon, shortcut: it.hint, onSelect: () => it.run(editor, { from: at, to: at }) });
    }
    return out;
  };

  const toolsMenu = (): MenuEntry[] => {
    const toast = useApp.getState().toast;
    return [
      { label: "Suchen", icon: Replace, shortcut: keys("Mod F"), onSelect: () => onFind(false) },
      { label: "Suchen und ersetzen", icon: Replace, shortcut: keys("Mod H"), onSelect: () => onFind(true) },
      "separator",
      {
        label: "Groß-/Kleinschreibung",
        icon: CaseSensitive,
        disabled: st.empty,
        submenu: [
          { label: "GROSSBUCHSTABEN", onSelect: () => changeSelectionCase(editor, "upper") },
          { label: "kleinbuchstaben", onSelect: () => changeSelectionCase(editor, "lower") },
          { label: "Jedes Wort Groß", onSelect: () => changeSelectionCase(editor, "title") },
        ],
      },
      { label: "Zeilen sortieren A–Z", icon: ArrowDownAZ, onSelect: () => sortSelectedLines(editor) || toast({ tone: "info", title: "Mehrere Zeilen oder Listenpunkte markieren" }) },
      { label: "Zeilen sortieren Z–A", icon: ArrowUpAZ, onSelect: () => sortSelectedLines(editor, true) || toast({ tone: "info", title: "Mehrere Zeilen oder Listenpunkte markieren" }) },
      { label: "Doppelte Zeilen entfernen", icon: ListX, onSelect: () => dedupeSelectedLines(editor) || toast({ tone: "info", title: "Mehrere Zeilen oder Listenpunkte markieren" }) },
      "separator",
      { label: "Block nach oben", icon: MoveUp, shortcut: keys("Alt ArrowUp"), onSelect: () => moveBlock(editor, -1) },
      { label: "Block nach unten", icon: MoveDown, shortcut: keys("Alt ArrowDown"), onSelect: () => moveBlock(editor, 1) },
      { label: "Datum und Uhrzeit einfügen", icon: Clock, onSelect: () => c().insertContent(new Date().toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).replace(",", "") + " ").run() },
      { label: "Formatierung entfernen", icon: Eraser, onSelect: () => clearFormatting(editor) },
      "separator",
      {
        label: "Statistik",
        icon: BarChart3,
        onSelect: () => {
          const { text, selection } = statsText(editor);
          const s = textStats(text);
          toast({
            tone: "info",
            title: `${s.words.toLocaleString("de-DE")} Wörter${selection ? " markiert" : ""}`,
            detail: `${s.chars.toLocaleString("de-DE")} Zeichen (${s.charsNoSpaces.toLocaleString("de-DE")} ohne Leerzeichen) · ${s.paragraphs} Absätze · Lesezeit ${s.readingMinutes} min`,
          });
        },
      },
    ];
  };

  const moreMenu = (): MenuEntry[] => {
    const out: MenuEntry[] = [];
    const group = (items: MenuEntry[]) => {
      if (out.length) out.push("separator");
      out.push(...items);
    };
    if (!shown(5))
      group([{ label: "Absatzformat", icon: Heading, submenu: BLOCKS.map((b) => ({ label: b.label, checked: st.block === b.value, onSelect: () => setBlock(b.value) })) }]);
    if (!shown(6))
      group([
        { label: "Fett", icon: Bold, shortcut: keys("Mod B"), checked: st.bold, onSelect: () => c().toggleBold().run() },
        { label: "Kursiv", icon: Italic, shortcut: keys("Mod I"), checked: st.italic, onSelect: () => c().toggleItalic().run() },
      ]);
    if (!shown(4))
      group([
        { label: "Rückgängig", icon: Undo2, shortcut: keys("Mod Z"), disabled: !st.canUndo, onSelect: () => c().undo().run() },
        { label: "Wiederholen", icon: Redo2, shortcut: keys("Mod Shift Z"), disabled: !st.canRedo, onSelect: () => c().redo().run() },
      ]);
    if (!shown(3))
      group([
        { label: "Durchgestrichen", icon: Strikethrough, checked: st.strike, onSelect: () => c().toggleStrike().run() },
        { label: "Hervorheben", icon: Highlighter, checked: st.highlight, onSelect: () => c().toggleHighlight().run() },
        { label: "Code", icon: Code, shortcut: keys("Mod E"), checked: st.code, onSelect: () => c().toggleCode().run() },
        { label: st.link ? "Weblink entfernen" : "Weblink", icon: SquareArrowOutUpRight, onSelect: () => (st.link ? c().unsetLink().run() : setUrl("https://")) },
        { label: "Seitenlink [[ ]]", icon: Link2, onSelect: () => c().insertContent("[[").run() },
      ]);
    if (!shown(2))
      group([
        { label: "Zitat", icon: Quote, checked: st.quote, onSelect: () => c().toggleBlockquote().run() },
        { label: "Codeblock", icon: SquareCode, checked: st.codeBlock, onSelect: () => c().toggleCodeBlock().run() },
      ]);
    if (!shown(1))
      group([
        { label: "Aufzählung", icon: List, checked: st.bullet, onSelect: () => c().toggleBulletList().run() },
        { label: "Nummerierte Liste", icon: ListOrdered, checked: st.ordered, onSelect: () => c().toggleOrderedList().run() },
        { label: "Aufgabenliste", icon: ListChecks, checked: st.task, onSelect: () => c().toggleTaskList().run() },
      ]);
    return out;
  };

  const at = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { clientX: r.left, clientY: r.bottom + 4, preventDefault: () => e.preventDefault() };
  };

  return (
    <div
      ref={bar}
      className="editor-toolbar"
      role="toolbar"
      aria-label="Formatierung"
      // Last resort when even the essentials do not fit: the wheel scrolls it sideways.
      onWheel={(e) => {
        const el = e.currentTarget;
        if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
      }}
      onMouseDown={(e) => (e.target as HTMLElement).closest("button") && e.preventDefault()}>
      {shown(4) && <div className="tb-group" data-collapse={4}>
        <IconButton icon={Undo2} label={`Rückgängig (${keys("Mod Z")})`} disabled={!st.canUndo} onClick={() => c().undo().run()} size={28} iconSize={15} />
        <IconButton icon={Redo2} label={`Wiederholen (${keys("Mod Shift Z")})`} disabled={!st.canRedo} onClick={() => c().redo().run()} size={28} iconSize={15} />
      </div>}
      {shown(5) && <div className="tb-group" data-collapse={5}>
        <select className="input select tb-select" aria-label="Absatzformat" value={st.block} onChange={(e) => setBlock(e.target.value as Block)}>
          {BLOCKS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </div>}
      {shown(6) && <div className="tb-group" data-collapse={6}>
        <IconButton icon={Bold} label={`Fett (${keys("Mod B")})`} active={st.bold} onClick={() => c().toggleBold().run()} size={28} iconSize={15} />
        <IconButton icon={Italic} label={`Kursiv (${keys("Mod I")})`} active={st.italic} onClick={() => c().toggleItalic().run()} size={28} iconSize={15} />
      </div>}
      {shown(3) && <div className="tb-group" data-collapse={3}>
        <IconButton icon={Strikethrough} label="Durchgestrichen" active={st.strike} onClick={() => c().toggleStrike().run()} size={28} iconSize={15} />
        <IconButton icon={Highlighter} label="Hervorheben" active={st.highlight} onClick={() => c().toggleHighlight().run()} size={28} iconSize={15} />
        <IconButton icon={Code} label={`Code (${keys("Mod E")})`} active={st.code} onClick={() => c().toggleCode().run()} size={28} iconSize={15} />
        <IconButton icon={SquareArrowOutUpRight} label={st.link ? "Weblink entfernen" : "Weblink"} active={st.link} onClick={() => (st.link ? c().unsetLink().run() : setUrl("https://"))} size={28} iconSize={15} />
        <IconButton icon={Link2} label="Seitenlink [[ ]]" onClick={() => c().insertContent("[[").run()} size={28} iconSize={15} />
      </div>}
        {url !== null && (
          <input
            className="input tb-url"
            autoFocus
            value={url}
            aria-label="Adresse des Weblinks"
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => setUrl(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), applyLink());
              else if (e.key === "Escape") (e.preventDefault(), setUrl(null), editor.commands.focus());
            }}
          />
        )}
      {shown(1) && <div className="tb-group" data-collapse={1}>
        <IconButton icon={List} label="Aufzählung" active={st.bullet} onClick={() => c().toggleBulletList().run()} size={28} iconSize={15} />
        <IconButton icon={ListOrdered} label="Nummerierte Liste" active={st.ordered} onClick={() => c().toggleOrderedList().run()} size={28} iconSize={15} />
        <IconButton icon={ListChecks} label="Aufgabenliste" active={st.task} onClick={() => c().toggleTaskList().run()} size={28} iconSize={15} />
      </div>}
      {shown(2) && <div className="tb-group" data-collapse={2}>
        <IconButton icon={Quote} label="Zitat" active={st.quote} onClick={() => c().toggleBlockquote().run()} size={28} iconSize={15} />
        <IconButton icon={SquareCode} label="Codeblock" active={st.codeBlock} onClick={() => c().toggleCodeBlock().run()} size={28} iconSize={15} />
      </div>}
      {level > 0 && (
        <div className="tb-group">
          <IconButton icon={MoreHorizontal} label="Weitere Formatierung" aria-haspopup="menu" onClick={(e) => openMenu(at(e), moreMenu())} size={28} iconSize={15} />
        </div>
      )}
      <div className="tb-group">
        <button type="button" className="tb-menu" aria-haspopup="menu" aria-label="Einfügen" data-tooltip="Einfügen" onClick={(e) => openMenu(at(e), insertMenu())}>
          <Plus size={15} strokeWidth={1.75} aria-hidden />
          <span className="tb-label">Einfügen</span>
          <ChevronDown size={13} className="tb-caret" aria-hidden />
        </button>
        <button type="button" className="tb-menu" aria-haspopup="menu" aria-label="Werkzeuge" data-tooltip="Werkzeuge" onClick={(e) => openMenu(at(e), toolsMenu())}>
          <Wrench size={15} strokeWidth={1.75} aria-hidden />
          <span className="tb-label">Werkzeuge</span>
          <ChevronDown size={13} className="tb-caret" aria-hidden />
        </button>
        <button type="button" className="tb-menu tb-ai" onClick={onAi} data-tooltip={`Mit KI bearbeiten (${keys("Mod J")})`}>
          <Sparkles size={15} strokeWidth={1.75} aria-hidden />
          <span className="tb-label">KI</span>
        </button>
      </div>
      {menu}
    </div>
  );
}
