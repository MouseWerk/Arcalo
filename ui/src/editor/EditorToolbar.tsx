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
import { IconButton, Select, useMenu, type MenuEntry } from "../components/ui";
import { keys } from "../lib/shortcut";
import { slashItems, type SlashOptions } from "./extensions";
import { changeSelectionCase, clearFormatting, dedupeSelectedLines, moveBlock, sortSelectedLines, statsText, textStats } from "./tools";
import { useApp } from "../store/app";
import { fmtDate, int, time } from "../lib/format";
import { useT, withLabel } from "../lib/i18n";

type Block = "paragraph" | "h1" | "h2" | "h3" | "h4";
const BLOCKS: { value: Block; readonly label: string }[] = [
  withLabel({ value: "paragraph" as Block }, "slash.text"),
  withLabel({ value: "h1" as Block }, "slash.h1"),
  withLabel({ value: "h2" as Block }, "slash.h2"),
  withLabel({ value: "h3" as Block }, "slash.h3"),
  withLabel({ value: "h4" as Block }, "tb.h4"),
];

/** Width of the „Weitere Formatierung“ button with its group separator. */
const MORE_W = 38;
const MAX_LEVEL = 6;

export function EditorToolbar({ editor, onFind, onAi }: { editor: Editor; onFind: (replace: boolean) => void; onAi: () => void }) {
  const t = useT();
  const [menu, , openMenuAt] = useMenu();
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
    const items = slashItems({ onTemplate: opts.onTemplate ?? null, onImage: opts.onImage ?? null, onAi: opts.onAi ?? null, onSummary: opts.onSummary ?? null, onDrawing: opts.onDrawing ?? null, onFile: opts.onFile ?? null, onVoice: opts.onVoice ?? null });
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
    const needLines = () => toast({ tone: "info", title: t("tb.needLines") });
    const now = new Date();
    return [
      { label: t("tb.find"), icon: Replace, shortcut: keys("Mod F"), onSelect: () => onFind(false) },
      { label: t("tb.replace"), icon: Replace, shortcut: keys("Mod H"), onSelect: () => onFind(true) },
      "separator",
      {
        label: t("tb.case"),
        icon: CaseSensitive,
        disabled: st.empty,
        submenu: [
          { label: t("tb.upper"), onSelect: () => changeSelectionCase(editor, "upper") },
          { label: t("tb.lower"), onSelect: () => changeSelectionCase(editor, "lower") },
          { label: t("tb.title"), onSelect: () => changeSelectionCase(editor, "title") },
        ],
      },
      { label: t("tb.sortAz"), icon: ArrowDownAZ, onSelect: () => sortSelectedLines(editor) || needLines() },
      { label: t("tb.sortZa"), icon: ArrowUpAZ, onSelect: () => sortSelectedLines(editor, true) || needLines() },
      { label: t("tb.dedupe"), icon: ListX, onSelect: () => dedupeSelectedLines(editor) || needLines() },
      "separator",
      { label: t("tb.blockUp"), icon: MoveUp, shortcut: keys("Alt ArrowUp"), onSelect: () => moveBlock(editor, -1) },
      { label: t("tb.blockDown"), icon: MoveDown, shortcut: keys("Alt ArrowDown"), onSelect: () => moveBlock(editor, 1) },
      { label: t("tb.dateTime"), icon: Clock, onSelect: () => c().insertContent(`${fmtDate(now)} ${time(now.toISOString())} `).run() },
      { label: t("tb.clearFormat"), icon: Eraser, onSelect: () => clearFormatting(editor) },
      "separator",
      {
        label: t("tb.stats"),
        icon: BarChart3,
        onSelect: () => {
          const { text, selection } = statsText(editor);
          const s = textStats(text);
          toast({
            tone: "info",
            title: selection ? t("tb.wordsSelected", { n: s.words, count: int(s.words) }) : t("tb.words", { n: s.words, count: int(s.words) }),
            detail: t("tb.statsDetail", { chars: int(s.chars), noSpaces: int(s.charsNoSpaces), paragraphs: s.paragraphs, minutes: s.readingMinutes }),
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
      group([{ label: t("tb.blockFormat"), icon: Heading, submenu: BLOCKS.map((b) => ({ label: b.label, checked: st.block === b.value, onSelect: () => setBlock(b.value) })) }]);
    if (!shown(6))
      group([
        { label: t("tb.bold"), icon: Bold, shortcut: keys("Mod B"), checked: st.bold, onSelect: () => c().toggleBold().run() },
        { label: t("tb.italic"), icon: Italic, shortcut: keys("Mod I"), checked: st.italic, onSelect: () => c().toggleItalic().run() },
      ]);
    if (!shown(4))
      group([
        { label: t("tb.undo"), icon: Undo2, shortcut: keys("Mod Z"), disabled: !st.canUndo, onSelect: () => c().undo().run() },
        { label: t("tb.redo"), icon: Redo2, shortcut: keys("Mod Shift Z"), disabled: !st.canRedo, onSelect: () => c().redo().run() },
      ]);
    if (!shown(3))
      group([
        { label: t("tb.strike"), icon: Strikethrough, checked: st.strike, onSelect: () => c().toggleStrike().run() },
        { label: t("slash.mark"), icon: Highlighter, checked: st.highlight, onSelect: () => c().toggleHighlight().run() },
        { label: t("tb.code"), icon: Code, shortcut: keys("Mod E"), checked: st.code, onSelect: () => c().toggleCode().run() },
        { label: st.link ? t("tb.unlink") : t("tb.weblink"), icon: SquareArrowOutUpRight, onSelect: () => (st.link ? c().unsetLink().run() : setUrl("https://")) },
        { label: t("tb.pageLink"), icon: Link2, onSelect: () => c().insertContent("[[").run() },
      ]);
    if (!shown(2))
      group([
        { label: t("slash.quote"), icon: Quote, checked: st.quote, onSelect: () => c().toggleBlockquote().run() },
        { label: t("slash.code"), icon: SquareCode, checked: st.codeBlock, onSelect: () => c().toggleCodeBlock().run() },
      ]);
    if (!shown(1))
      group([
        { label: t("slash.ul"), icon: List, checked: st.bullet, onSelect: () => c().toggleBulletList().run() },
        { label: t("slash.ol"), icon: ListOrdered, checked: st.ordered, onSelect: () => c().toggleOrderedList().run() },
        { label: t("slash.todo"), icon: ListChecks, checked: st.task, onSelect: () => c().toggleTaskList().run() },
      ]);
    return out;
  };

  return (
    <div
      ref={bar}
      className="editor-toolbar"
      role="toolbar"
      aria-label={t("tb.formatting")}
      // Last resort when even the essentials do not fit: the wheel scrolls it sideways.
      onWheel={(e) => {
        const el = e.currentTarget;
        if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) el.scrollLeft += e.deltaY;
      }}
      onMouseDown={(e) => (e.target as HTMLElement).closest("button") && e.preventDefault()}>
      {shown(4) && <div className="tb-group" data-collapse={4}>
        <IconButton icon={Undo2} label={`${t("tb.undo")} (${keys("Mod Z")})`} disabled={!st.canUndo} onClick={() => c().undo().run()} size={28} iconSize={15} />
        <IconButton icon={Redo2} label={`${t("tb.redo")} (${keys("Mod Shift Z")})`} disabled={!st.canRedo} onClick={() => c().redo().run()} size={28} iconSize={15} />
      </div>}
      {shown(5) && <div className="tb-group" data-collapse={5}>
        <Select className="tb-select" aria-label={t("tb.blockFormat")} value={st.block} options={BLOCKS} onChange={(e) => setBlock(e.target.value as Block)} />
      </div>}
      {shown(6) && <div className="tb-group" data-collapse={6}>
        <IconButton icon={Bold} label={`${t("tb.bold")} (${keys("Mod B")})`} active={st.bold} onClick={() => c().toggleBold().run()} size={28} iconSize={15} />
        <IconButton icon={Italic} label={`${t("tb.italic")} (${keys("Mod I")})`} active={st.italic} onClick={() => c().toggleItalic().run()} size={28} iconSize={15} />
      </div>}
      {shown(3) && <div className="tb-group" data-collapse={3}>
        <IconButton icon={Strikethrough} label={t("tb.strike")} active={st.strike} onClick={() => c().toggleStrike().run()} size={28} iconSize={15} />
        <IconButton icon={Highlighter} label={t("slash.mark")} active={st.highlight} onClick={() => c().toggleHighlight().run()} size={28} iconSize={15} />
        <IconButton icon={Code} label={`${t("tb.code")} (${keys("Mod E")})`} active={st.code} onClick={() => c().toggleCode().run()} size={28} iconSize={15} />
        <IconButton icon={SquareArrowOutUpRight} label={st.link ? t("tb.unlink") : t("tb.weblink")} active={st.link} onClick={() => (st.link ? c().unsetLink().run() : setUrl("https://"))} size={28} iconSize={15} />
        <IconButton icon={Link2} label={t("tb.pageLink")} onClick={() => c().insertContent("[[").run()} size={28} iconSize={15} />
      </div>}
        {url !== null && (
          <input
            className="input tb-url"
            autoFocus
            value={url}
            aria-label={t("tb.weblinkUrl")}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => setUrl(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), applyLink());
              else if (e.key === "Escape") (e.preventDefault(), setUrl(null), editor.commands.focus());
            }}
          />
        )}
      {shown(1) && <div className="tb-group" data-collapse={1}>
        <IconButton icon={List} label={t("slash.ul")} active={st.bullet} onClick={() => c().toggleBulletList().run()} size={28} iconSize={15} />
        <IconButton icon={ListOrdered} label={t("slash.ol")} active={st.ordered} onClick={() => c().toggleOrderedList().run()} size={28} iconSize={15} />
        <IconButton icon={ListChecks} label={t("slash.todo")} active={st.task} onClick={() => c().toggleTaskList().run()} size={28} iconSize={15} />
      </div>}
      {shown(2) && <div className="tb-group" data-collapse={2}>
        <IconButton icon={Quote} label={t("slash.quote")} active={st.quote} onClick={() => c().toggleBlockquote().run()} size={28} iconSize={15} />
        <IconButton icon={SquareCode} label={t("slash.code")} active={st.codeBlock} onClick={() => c().toggleCodeBlock().run()} size={28} iconSize={15} />
      </div>}
      {level > 0 && (
        <div className="tb-group">
          <IconButton icon={MoreHorizontal} label={t("tb.more")} aria-haspopup="menu" onClick={(e) => openMenuAt(e, moreMenu())} size={28} iconSize={15} />
        </div>
      )}
      <div className="tb-group">
        <button type="button" className="tb-menu" aria-haspopup="menu" aria-label={t("slash.sec.insert")} data-tooltip={t("slash.sec.insert")} onClick={(e) => openMenuAt(e, insertMenu())}>
          <Plus size={15} strokeWidth={1.75} aria-hidden />
          <span className="tb-label">{t("slash.sec.insert")}</span>
          <ChevronDown size={13} className="tb-caret" aria-hidden />
        </button>
        <button type="button" className="tb-menu" aria-haspopup="menu" aria-label={t("tb.tools")} data-tooltip={t("tb.tools")} onClick={(e) => openMenuAt(e, toolsMenu())}>
          <Wrench size={15} strokeWidth={1.75} aria-hidden />
          <span className="tb-label">{t("tb.tools")}</span>
          <ChevronDown size={13} className="tb-caret" aria-hidden />
        </button>
        <button type="button" className="tb-menu tb-ai" onClick={onAi} data-tooltip={t("tb.aiEdit", { keys: keys("Mod J") })}>
          <Sparkles size={15} strokeWidth={1.75} aria-hidden />
          <span className="tb-label">{t("slash.sec.ai")}</span>
        </button>
      </div>
      {menu}
    </div>
  );
}
