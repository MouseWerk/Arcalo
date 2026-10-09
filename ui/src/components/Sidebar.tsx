// Left sidebar: navigation, favorites, page tree (drag & drop), tags, timer.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, CornerDownRight, FilePlus2, FolderTree, Hash, MoreHorizontal, PencilLine, Plus, Search, Square, Star, StarOff, Timer, Trash2, X,
  ArrowDown, ArrowUp, ArrowUpToLine, ClipboardCopy, Copy, CornerLeftUp, FileText, LayoutTemplate, Link2, MoveVertical, Shapes, Type,
  ArrowDownUp, FolderInput, Palette, SlidersHorizontal, Undo2, Wand2, LayoutList,
  LayoutDashboard, Pause, Play,
} from "lucide-react";
import { api, errorParts } from "../lib/api";
import { cleanTitleChars } from "../lib/links";
import { flushAllEditors } from "../editor/saves";
import { reloadEditors } from "../editor/NoteEditor";
import { useApp } from "../store/app";
import { PAGE_ICONS, PageIcon, iconLabel } from "./icons";
import { Button, IconButton, useMenu, type MenuEntry, type MenuItem } from "./ui";
import type { LucideIcon } from "lucide-react";
import { useTimeTracking } from "../lib/timetracking";
import { clock, fmtDayMonth, fmtMinutes, longTimerHours, weekdayShort } from "../lib/format";
import { createSubpage, deletePage } from "../views/PageView";
import { createCanvas, isCanvas } from "../views/canvas/create";
import { COLLAPSED_EVENT, readCollapsed, writeCollapsed } from "../lib/collapsed";
import type { PageNode, SearchHit, TimerStatus } from "../lib/types";
import { t as tStatic, useT } from "../lib/i18n";
import { withHint } from "../lib/keymap";
import { keys } from "../lib/shortcut";
import { newPageFromTemplate } from "./Templates";
import { stripMarkdown } from "../lib/plaintext";
import { setExactOnly, useExactOnly, useMeaningSearch, type PageHit } from "../lib/meaningSearch";
import { treeWindow } from "../lib/treeWindow";
import { DEFAULT_STYLE, FOLDER_COLORS, FOLDER_SORTS, filingApi, filterIds, isWithin, rangeIds, renameProblem, sortNodes, topSelected, type FolderStyle } from "../lib/filing";
import { movePages, openMoveTo, openTidyUp, undoLastMove } from "./FilingDialogs";
import { SMART_EVENT, SmartFolders, setSmartHidden, smartHidden } from "./SmartFolders";
import type { TKey } from "../lib/i18n";

type SideTab = "files" | "search" | "bookmarks" | "tags";

/** Title of the daily notes' folder (Settings → Notizen). */
const journalTitle = () => useApp.getState().settings?.settings.notes?.daily_folder || "Journal";
/** Id of the Journal folder that was already collapsed once by default. */
const JOURNAL_SEEN_KEY = "arcalo.journal-collapsed";

export function Sidebar() {
  const t = useT();
  const tree = useApp((s) => s.tree);
  const onboarding = useApp((s) => s.onboarding);
  const pages = useApp((s) => s.pages);
  const active = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
  const [tab, setTabState] = useState<SideTab>(() => (localStorage.getItem("arcalo.sidetab") as SideTab) || "files");
  const [collapsed, setCollapsed] = useState<Set<number>>(readCollapsed);
  const setTab = (t: SideTab) => {
    setTabState(t);
    localStorage.setItem("arcalo.sidetab", t);
  };
  const saveCollapsed = (next: Set<number>) => {
    setCollapsed(next);
    writeCollapsed(next);
  };
  useEffect(() => {
    const onFocusSearch = () => setTab("search");
    const onCollapsed = () => setCollapsed(readCollapsed());
    window.addEventListener("arcalo:sidebar-search", onFocusSearch);
    window.addEventListener(COLLAPSED_EVENT, onCollapsed);
    return () => {
      window.removeEventListener("arcalo:sidebar-search", onFocusSearch);
      window.removeEventListener(COLLAPSED_EVENT, onCollapsed);
    };
  }, []);
  // The Journal grows by a page a day: it starts collapsed (once per Journal folder).
  const activePageId = active?.kind === "page" ? active.pageId : undefined;
  useEffect(() => {
    const journal = tree.find((n) => n.parent_id == null && n.title === journalTitle() && n.children.length > 0);
    if (!journal) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(JOURNAL_SEEN_KEY);
      localStorage.setItem(JOURNAL_SEEN_KEY, String(journal.id));
    } catch {
      return;
    }
    const within = (list: PageNode[]): boolean => list.some((c) => c.id === activePageId || within(c.children));
    const showsDaily = activePageId != null && within(journal.children);
    if (seen !== String(journal.id) && !showsDaily && !collapsed.has(journal.id)) saveCollapsed(new Set(collapsed).add(journal.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);

  const tabs: { id: SideTab; label: string; icon: typeof Search }[] = [
    { id: "files", label: t("sidebar.files"), icon: FolderTree },
    { id: "search", label: withHint(t("sidebar.search"), "search"), icon: Search },
    { id: "bookmarks", label: t("sidebar.bookmarks"), icon: Star },
    { id: "tags", label: t("sidebar.tags"), icon: Hash },
  ];
  const withChildren = useMemo(() => [...pages.values()].filter((p) => p.children.length).map((p) => p.id), [pages]);
  // Ordner & Ablage: the filter, the top level's sort and whether the smart folders show.
  const [filter, setFilter] = useState("");
  const [rootStyle, setRootStyle] = useState<FolderStyle>(DEFAULT_STYLE);
  const [smartShown, setSmartShown] = useState(() => !smartHidden());
  const [treeMenu, , openTreeMenuAt] = useMenu();
  useEffect(() => {
    filingApi.folderStyle(0).then(setRootStyle, () => {});
    const on = () => setSmartShown(!smartHidden());
    window.addEventListener(SMART_EVENT, on);
    return () => window.removeEventListener(SMART_EVENT, on);
  }, []);
  const setRoot = (style: FolderStyle) => {
    setRootStyle(style);
    filingApi.setFolderStyle(0, style).catch((e) => useApp.getState().error(t("fl.styleFailed"), e));
  };
  const treeMenuItems = (): MenuEntry[] => [
    { label: t("fl.sortTop"), icon: ArrowDownUp, submenu: sortMenu(rootStyle, setRoot) },
    "separator",
    { label: t("fl.tidy"), icon: Wand2, onSelect: () => openTidyUp(null) },
    { label: t("fl.undoLast"), icon: Undo2, onSelect: () => void undoLastMove() },
    "separator",
    { label: smartShown ? t("fl.smartHide") : t("fl.smartShow"), icon: LayoutList, checked: smartShown, onSelect: () => setSmartHidden(smartShown) },
  ];
  const allCollapsed = withChildren.length > 0 && withChildren.every((id) => collapsed.has(id));

  return (
    <aside className="sidebar" aria-label={t("sidebar.label")}>
      <div className="side-tabs" role="tablist" aria-label={t("sidebar.label")} data-tauri-drag-region>
        {tabs.map((st, i) => (
          <IconButton
            key={st.id}
            icon={st.icon}
            label={st.label}
            active={tab === st.id}
            // The same size as the ribbon's buttons next to them.
            size="lg"
            onClick={() => setTab(st.id)}
            role="tab"
            aria-selected={tab === st.id}
            // One Tab stop for the row; the arrows switch between the panes.
            tabIndex={tab === st.id ? 0 : -1}
            onKeyDown={(e) => {
              const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
              if (to == null) return;
              e.preventDefault();
              const next = tabs[(to + tabs.length) % tabs.length];
              setTab(next.id);
              const row = e.currentTarget.parentElement;
              requestAnimationFrame(() => row?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
            }}
          />
        ))}
      </div>

      {tab === "files" && (
        <>
          <div className="side-toolbar">
            <span className="side-title">{t("sidebar.files")}</span>
            <IconButton icon={FilePlus2} label={t("sidebar.newPage")} size="md" onClick={() => createSubpage(null)} />
            <IconButton icon={LayoutDashboard} label={t("sidebar.newCanvas")} size="md" data-new-canvas onClick={() => void createCanvas(null)} />
            <IconButton
              icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
              label={allCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
              size="md"
              onClick={() => saveCollapsed(allCollapsed ? new Set() : new Set(withChildren))}
            />
            <IconButton icon={SlidersHorizontal} label={t("fl.treeMenu")} size="md" className="tree-options" onClick={(e) => openTreeMenuAt(e, treeMenuItems())} />
            {treeMenu}
          </div>
          {tree.length > 0 && (
            <div className="tree-filter">
              <Search size={13} aria-hidden />
              <input
                value={filter}
                placeholder={t("fl.filter")}
                aria-label={t("fl.filter")}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && filter) (e.preventDefault(), e.stopPropagation(), setFilter(""));
                  else if (e.key === "ArrowDown") (e.preventDefault(), document.querySelector<HTMLElement>(".sidebar .tree .tree-row")?.focus());
                }}
              />
              {filter && <IconButton icon={X} label={t("fl.filterClear")} size="sm" onClick={() => setFilter("")} />}
            </div>
          )}
          <div className="sidebar-scroll">
            {tree.length > 0 && !filter && <SmartFolders />}
            {tree.length === 0 ? (
              // During onboarding the welcome choice explains the empty workspace.
              !onboarding && <div className="side-empty">
                {t("sidebar.noPages")}
                <Button size="sm" icon={FilePlus2} onClick={() => createSubpage(null)}>
                  {t("sidebar.newPage")}
                </Button>
              </div>
            ) : (
              <PageTree nodes={tree} activePageId={activePageId} collapsed={collapsed} setCollapsed={saveCollapsed} filter={filter} rootStyle={rootStyle} />
            )}
          </div>
        </>
      )}
      {tab === "search" && <SearchPane />}
      {tab === "bookmarks" && <Bookmarks activePageId={active?.kind === "page" ? active.pageId : undefined} />}
      {tab === "tags" && <TagsPane activeTag={active?.kind === "tag" ? active.tag : undefined} />}

      <TimerDock />
      <SidebarFooter />
    </aside>
  );
}

function SidebarFooter() {
  const t = useT();
  const s = useApp.getState;
  const pages = useApp((st) => st.pages);
  const timeOn = useTimeTracking();
  const [trashed, setTrashed] = useState(0);
  // The tree reloads after every delete/restore, so its identity is a good refresh signal.
  useEffect(() => {
    api.trash().then((t) => setTrashed(t.length)).catch(() => {});
  }, [pages]);
  return (
    <div className="sidebar-foot">
      {timeOn ? (
        <button type="button" className="side-foot-btn" onClick={() => s().openTab({ kind: "timesheet" })} title={t("sidebar.openTimesheet")}>
          <Timer size={14} strokeWidth={1.75} />
          <span>{t("sidebar.today")}</span>
          <TodayHours />
        </button>
      ) : (
        <span style={{ flex: 1 }} />
      )}
      <IconButton
        icon={Trash2}
        label={trashed ? `${t("sidebar.trash")} (${trashed})` : t("sidebar.trash")}
        tooltipSide="top"
        size="sm"
        onClick={() => s().openTab({ kind: "trash" })}
      />
    </div>
  );
}

// ------------------------------------------------------------- search pane

function SearchPane() {
  const tr = useT();
  const [q, setQ] = useState(() => sessionStorage.getItem("arcalo.sidesearch") ?? "");
  const exactOnly = useExactOnly();
  const { hits, meaning } = useMeaningSearch(q, 60, { enabled: q.trim().length >= 2, exact: exactOnly, delay: 120 });
  const input = useRef<HTMLInputElement>(null);
  const s = useApp.getState;
  useEffect(() => {
    // Not while the arrows walk the pane tabs (the focus stays on the tab row then).
    setTimeout(() => !document.activeElement?.closest(".side-tabs") && input.current?.focus(), 30);
    const onFocus = () => input.current?.select();
    window.addEventListener("arcalo:sidebar-search", onFocus);
    return () => window.removeEventListener("arcalo:sidebar-search", onFocus);
  }, []);
  useEffect(() => {
    sessionStorage.setItem("arcalo.sidesearch", q);
  }, [q]);
  const pageHits = (hits ?? []).filter((h) => h.kind !== "time_entry") as PageHit[];
  // Pages in the order of the hits; a page found by meaning carries the passage that matched.
  const byPage = new Map<number, { title: string; icon: string | null; snippets: string[]; passage?: string }>();
  for (const h of pageHits) {
    const e = byPage.get(h.page_id) ?? { title: h.title, icon: h.icon, snippets: [] };
    if (h.kind === "note") e.snippets.push(h.snippet);
    if (h.kind === "similar") e.passage = h.passage;
    byPage.set(h.page_id, e);
  }
  const similar = [...byPage.values()].filter((p) => p.passage != null).length;
  const timeOn = useTimeTracking();
  const entries = (timeOn ? (hits ?? []) : []).filter((h) => h.kind === "time_entry") as Extract<SearchHit, { kind: "time_entry" }>[];
  return (
    <div className="side-pane">
      <div className="side-search">
        <Search size={14} className="faint" />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={tr("sidebar.searchPlaceholder")}
          aria-label={tr("sidebar.fulltext")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              const first = [...byPage.keys()][0];
              if (first) s().openPage(first, { newTab: e.ctrlKey || e.metaKey });
            }
            if (e.key === "Escape") setQ("");
          }}
        />
        {q && <IconButton icon={X} label={tr("common.clear")} size="sm" onClick={() => setQ("")} />}
      </div>
      <div className="sidebar-scroll">
        {hits && (
          <div className="side-result-head">
            <div className="side-result-count" role="status">
              {byPage.size} {byPage.size === 1 ? tr("sidebar.page") : tr("sidebar.pages")}
              {entries.length > 0 && `, ${entries.length} ${tr("sidebar.timeEntries")}`}
              {similar > 0 && ` · ${tr("search.similarCount", { n: similar })}`}
            </div>
            {/* Only where search by meaning took part (or was switched off here). */}
            {(meaning || exactOnly) && (
              <button
                type="button"
                className={`side-filter ${exactOnly ? "on" : ""}`}
                aria-pressed={exactOnly}
                title={tr("search.exactOnlyHint")}
                onClick={() => setExactOnly(!exactOnly)}
              >
                {tr("search.exactOnly")}
              </button>
            )}
          </div>
        )}
        {[...byPage.entries()].map(([id, p]) => (
          <button
            key={id}
            type="button"
            className={`side-result ${p.passage != null ? "similar" : ""}`}
            onClick={(e) => s().openPage(id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey })}
          >
            <span className="side-result-title">
              <PageIcon name={p.icon} size={14} /> <span className="side-result-name">{p.title}</span>
              {p.passage != null && (
                <span className="hit-similar" title={tr("search.similarHint")}>
                  {tr("search.similar")}
                </span>
              )}
            </span>
            {p.snippets.slice(0, 2).map((sn, i) => (
              <span key={i} className="side-result-snippet" dangerouslySetInnerHTML={{ __html: markHits(sn) }} />
            ))}
            {p.passage != null && p.snippets.length === 0 && <span className="side-result-snippet">{stripMarkdown(p.passage)}</span>}
          </button>
        ))}
        {entries.map((h) => (
          <button key={h.id} type="button" className="side-result" onClick={() => s().openTab({ kind: "timesheet" })}>
            <span className="side-result-title">
              <Timer size={14} /> {h.netzplan_nr}
              {h.vorgang_nr ? `/${h.vorgang_nr}` : ""}
            </span>
            <span className="side-result-snippet" dangerouslySetInnerHTML={{ __html: markHits(h.snippet) }} />
          </button>
        ))}
        {hits && byPage.size + entries.length === 0 && <div className="side-empty">{tr("sidebar.noHits", { q })}</div>}
        {!hits && <div className="side-empty faint">{tr("sidebar.searchHint")}</div>}
      </div>
    </div>
  );
}

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const markHits = (sn: string) => escHtml(stripMarkdown(sn)).replace(/\u0002([^\u0003]*)\u0003/g, "<mark>$1</mark>");

function Bookmarks({ activePageId }: { activePageId?: number }) {
  const t = useT();
  const pages = useApp((s) => s.pages);
  const favorites = [...pages.values()].filter((p) => p.favorite).sort((a, b) => a.title.localeCompare(b.title, "de"));
  const s = useApp.getState;
  return (
    <div className="side-pane">
      <div className="side-toolbar">
        <span className="side-title">{t("sidebar.bookmarks")}</span>
      </div>
      <div className="sidebar-scroll">
        {favorites.length === 0 && <div className="side-empty faint">{t("sidebar.bookmarksEmpty")}</div>}
        {favorites.map((p) => (
          <button key={p.id} type="button" className={`tree-row ${activePageId === p.id ? "active" : ""}`} onClick={(e) => s().openPage(p.id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey })}>
            <span className="tree-twisty leaf" />
            <PageIcon name={p.icon} size={15} className="tree-icon" />
            <span className="tree-label">{p.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TagsPane({ activeTag }: { activeTag?: string }) {
  const t = useT();
  const pages = useApp((s) => s.pages);
  const [tags, setTags] = useState<[string, number][]>([]);
  useEffect(() => {
    api.tags().then(setTags).catch(() => {});
  }, [pages]);
  const s = useApp.getState;
  return (
    <div className="side-pane">
      <div className="side-toolbar">
        <span className="side-title">{t("sidebar.tags")}</span>
      </div>
      <div className="sidebar-scroll">
        {tags.length === 0 && <div className="side-empty faint">{t("sidebar.tagsEmpty")}</div>}
        {tags.map(([tag, n]) => (
          <button key={tag} type="button" className={`tree-row ${activeTag === tag ? "active" : ""}`} onClick={() => s().openTab({ kind: "tag", tag })}>
            <span className="tree-twisty leaf" />
            <Hash size={14} className="tree-icon" />
            <span className="tree-label">{tag}</span>
            <span className="tree-count">{n}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TodayHours() {
  const version = useApp((s) => s.entriesVersion);
  const [min, setMin] = useState(0);
  useEffect(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    api.entries(start.toISOString()).then((rows) => setMin(rows.reduce((a, r) => a + (r.duration_minutes ?? 0), 0))).catch(() => {});
  }, [version]);
  return min > 0 ? <span className="nav-badge num">{fmtMinutes(min)} h</span> : null;
}

// --------------------------------------------------------------- page tree

/** Renames a page with its links rewritten; the toast undoes it. */
async function renameInTree(n: PageNode, title: string) {
  const s = useApp.getState;
  const old = n.title;
  // All editors: a pending autosave elsewhere would write the old [[links]] back.
  await flushAllEditors();
  const count = await api.renamePage(n.id, title, true);
  reloadEditors();
  await s().refreshTree();
  s().toast({
    tone: "success",
    title: tStatic("sb.renamed", { title }),
    detail: count > 0 ? tStatic("page.linksUpdated", { n: count }) : undefined,
    action: {
      label: tStatic("common.undo"),
      run: async () => {
        try {
          await flushAllEditors();
          await api.renamePage(n.id, old, true);
          reloadEditors();
          await s().refreshTree();
          s().toast({ tone: "info", title: tStatic("sb.renameUndone"), detail: tStatic("common.quoted", { text: old }) });
        } catch (e) {
          s().error(tStatic("page.renameFailed"), e);
        }
      },
    },
  });
}

type DropPos = "before" | "inside" | "after";

/** Trees with this many visible rows render only the rows in view (plus a margin). */
const VIRTUAL_ROWS = 150;

/** „Sortieren“: the order of a folder's children and „Ordner zuerst“. */
function sortMenu(style: FolderStyle, set: (s: FolderStyle) => void): MenuItem[] {
  return [
    ...FOLDER_SORTS.map((sort) => ({ label: tStatic(`fl.sort.${sort}` as TKey), checked: style.sort === sort, onSelect: () => set({ ...style, sort }) })),
    { label: tStatic("fl.foldersFirst"), icon: FolderTree, checked: style.folders_first, onSelect: () => set({ ...style, folders_first: !style.folders_first }) },
  ];
}

/** Color dots for the „Farbe“ menu (theme tokens, so they follow light and dark). */
const SWATCHES = Object.fromEntries(
  FOLDER_COLORS.map((c) => [c, (({ size = 14 }: { size?: number }) => <span className={`tree-swatch tint-${c}`} style={{ width: size - 4, height: size - 4 }} aria-hidden />) as unknown as LucideIcon]),
) as Record<string, LucideIcon>;

/** Handlers of a tree row; one stable object, so rows can skip re-rendering. */
interface RowActions {
  toggle: (id: number) => void;
  open: (n: PageNode, e: React.MouseEvent) => void;
  menu: (n: PageNode, e: React.MouseEvent) => void;
  menuAt: (n: PageNode, e: React.MouseEvent) => void;
  key: (n: PageNode, e: React.KeyboardEvent<HTMLDivElement>) => void;
  focus: (n: PageNode) => void;
  dragStart: (n: PageNode, e: DragEvent) => void;
  dragEnd: () => void;
  dragOver: (n: PageNode, e: DragEvent<HTMLDivElement>) => void;
  dragLeave: (n: PageNode) => void;
  drop: (n: PageNode, e: DragEvent<HTMLDivElement>) => void;
  /** Starts renaming the row in place (F2, double click on the title). */
  rename: (n: PageNode) => void;
  /** Ends renaming; `refocus` puts the focus back on the row (Enter, Escape). */
  renameDone: (n: PageNode, refocus: boolean) => void;
}

/**
 * The visible rows are rendered flat (with `aria-level`), each memoized: switching tabs only
 * re-renders the old and the new active row, collapsing one folder only that row. A large tree
 * renders only the rows in view, positioned in a box of the full height.
 */
function PageTree({
  nodes,
  activePageId,
  collapsed,
  setCollapsed,
  filter = "",
  rootStyle = DEFAULT_STYLE,
}: {
  nodes: PageNode[];
  activePageId?: number;
  collapsed: Set<number>;
  setCollapsed: (s: Set<number>) => void;
  /** Shows the matching pages and their ancestors. */
  filter?: string;
  /** Sort of the top level. */
  rootStyle?: FolderStyle;
}) {
  const [drag, setDrag] = useState<{ id: number; over?: number; pos?: DropPos; many?: boolean } | null>(null);
  // Multi-select: Shift-click (range), Ctrl-click once a selection exists, Shift+arrows, Ctrl+Space.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  // The row renamed in place (its title is an input until Enter, Escape or leaving it).
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menu, openMenu, openMenuAt] = useMenu();
  const s = useApp.getState;

  const toggle = (id: number) => {
    const next = new Set(collapsed);
    next.has(id) ? next.delete(id) : next.add(id);
    setCollapsed(next);
  };

  // Keep the active page visible: expand its ancestors.
  useEffect(() => {
    if (activePageId == null) return;
    const pages = s().pages;
    let p = pages.get(activePageId);
    let changed = false;
    const next = new Set(collapsed);
    while (p?.parent_id != null) {
      if (next.delete(p.parent_id)) changed = true;
      p = pages.get(p.parent_id);
    }
    if (changed) setCollapsed(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId]);

  const parentOf = (id: number) => s().pages.get(id)?.parent_id;
  const selection = () => topSelected(selected, parentOf);
  const onDrop = async (target: PageNode, pos: DropPos) => {
    const id = drag?.id;
    const many = drag?.many;
    setDrag(null);
    if (id == null || id === target.id) return;
    if (many) {
      const ids = selection().filter((x) => x !== target.id);
      setSelected(new Set());
      // Before or after a page: there, among the pages that stay (not at the folder's end).
      let position: number | null = null;
      if (pos !== "inside") {
        const siblings = target.parent_id == null ? s().tree : (s().pages.get(target.parent_id)?.children ?? []);
        const staying = siblings.filter((x) => !ids.includes(x.id));
        position = staying.findIndex((x) => x.id === target.id) + (pos === "after" ? 1 : 0);
      }
      const out = await movePages(ids, pos === "inside" ? target.id : target.parent_id, position);
      if (out && pos === "inside") {
        const next = new Set(collapsed);
        next.delete(target.id);
        setCollapsed(next);
      }
      return;
    }
    const pages = s().pages;
    try {
      if (pos === "inside") {
        await api.movePage(id, target.id, target.children.length);
        const next = new Set(collapsed);
        next.delete(target.id);
        setCollapsed(next);
      } else {
        const siblings = target.parent_id == null ? s().tree : (pages.get(target.parent_id)?.children ?? []);
        const without = siblings.filter((x) => x.id !== id);
        const idx = without.findIndex((x) => x.id === target.id) + (pos === "after" ? 1 : 0);
        await api.movePage(id, target.parent_id, idx);
      }
      await s().refreshTree();
    } catch (e) {
      s().error(tStatic("sb.moveFailed"), e);
    }
  };

  const siblingsOf = (n: PageNode) => (n.parent_id == null ? s().tree : (s().pages.get(n.parent_id)?.children ?? []));
  const move = async (n: PageNode, parentId: number | null, position: number) => {
    try {
      await api.movePage(n.id, parentId, position);
      await s().refreshTree();
    } catch (e) {
      s().error(tStatic("sb.moveFailed"), e);
    }
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => s().toast({ tone: "success", title: tStatic("sb.copied", { what }) }),
      (e) => s().error(tStatic("sb.copyFailed"), e),
    );
  const descendants = (n: PageNode): number[] => n.children.flatMap((c) => (c.children.length ? [c.id, ...descendants(c)] : []));

  const setStyle = async (n: PageNode, style: FolderStyle) => {
    try {
      await filingApi.setFolderStyle(n.id, style);
      await s().refreshTree();
    } catch (e) {
      s().error(tStatic("fl.styleFailed"), e);
    }
  };
  const menuItems = (n: PageNode): MenuEntry[] => {
    if (selected.size > 1 && selected.has(n.id)) {
      const ids = selection();
      return [
        { label: tStatic("fl.moveN", { n: ids.length }), icon: FolderInput, onSelect: () => openMoveTo(ids) },
        { label: tStatic("fl.clearSelection"), icon: X, onSelect: () => setSelected(new Set()) },
        "separator",
        { label: tStatic("sb.deleteMany", { n: ids.length }), icon: Trash2, danger: true, shortcut: tStatic("sb.keyDelete"), onSelect: () => void deleteSelection() },
      ];
    }
    const style = n.style ?? DEFAULT_STYLE;
    const sibs = siblingsOf(n);
    const i = sibs.findIndex((x) => x.id === n.id);
    const parent = n.parent_id != null ? s().pages.get(n.parent_id) : undefined;
    return [
    { label: tStatic("sb.openNewTab"), icon: CornerDownRight, shortcut: tStatic("sb.middleClick"), onSelect: () => s().openPage(n.id, { newTab: true }) },
    { label: tStatic("sb.openRight"), icon: Columns2, shortcut: keys(`Alt ${tStatic("sb.click")}`), onSelect: () => s().openPage(n.id, { split: true }) },
    "separator",
    {
      label: tStatic("qs.new"),
      icon: FilePlus2,
      submenu: [
        { label: tStatic("sb.subpage"), icon: CornerDownRight, onSelect: () => createSubpage(n.id) },
        { label: tStatic("sidebar.newCanvas"), icon: LayoutDashboard, onSelect: () => void createCanvas(n.id) },
        {
          label: tStatic("sb.sibling"),
          icon: FilePlus2,
          onSelect: async () => {
            try {
              const p = await api.createPage(tStatic("page.untitled"), n.parent_id, s().settings?.settings.editor?.default_icon ?? "file-text");
              await api.movePage(p.id, n.parent_id, i + 1);
              await s().refreshTree();
              s().openPage(p.id);
              setTimeout(() => document.querySelector<HTMLTextAreaElement>(".pane.active .page-title")?.select(), 120);
            } catch (e) {
              s().error(tStatic("sb.createFailed"), e);
            }
          },
        },
        { label: tStatic("sb.fromTemplate"), icon: LayoutTemplate, onSelect: () => newPageFromTemplate(n.id) },
      ],
    },
    {
      label: tStatic("dash.duplicate"),
      icon: Copy,
      onSelect: async () => {
        try {
          const doc = await api.page(n.id);
          const copy = tStatic("sb.copyTitle", { title: n.title });
          const p = isCanvas(n) ? await api.createCanvas(copy, n.parent_id) : await api.createPage(copy, n.parent_id, n.icon, doc.content);
          if (isCanvas(n)) await api.savePage(p.id, doc.content);
          await api.movePage(p.id, n.parent_id, i + 1);
          await s().refreshTree();
          s().openPage(p.id);
        } catch (e) {
          s().error(tStatic("sb.duplicateFailed"), e);
        }
      },
    },
    {
      label: tStatic("sb.changeIcon"),
      icon: Shapes,
      submenu: Object.entries(PAGE_ICONS).map(([name, Icon]) => ({
        label: iconLabel(name),
        icon: Icon,
        checked: n.icon === name,
        onSelect: async () => {
          try {
            await api.setIcon(n.id, name);
            await s().refreshTree();
          } catch (e) {
            s().error(tStatic("sb.iconFailed"), e);
          }
        },
      })),
    },
    {
      label: tStatic("fl.color"),
      icon: Palette,
      submenu: [
        { label: tStatic("fl.color.none"), checked: !style.color, onSelect: () => setStyle(n, { ...style, color: null }) },
        ...FOLDER_COLORS.map((c) => ({ label: tStatic(`fl.color.${c}` as TKey), icon: SWATCHES[c], checked: style.color === c, onSelect: () => setStyle(n, { ...style, color: c }) })),
      ],
    },
    ...(n.children.length ? [{ label: tStatic("fl.sort"), icon: ArrowDownUp, submenu: sortMenu(style, (st) => setStyle(n, st)) }] : []),
    {
      label: tStatic("sb.move"),
      icon: MoveVertical,
      submenu: [
        { label: tStatic("fl.moveTo"), icon: FolderInput, onSelect: () => openMoveTo([n.id]) },
        { label: tStatic("sb.moveUp"), icon: ArrowUp, disabled: i <= 0, onSelect: () => move(n, n.parent_id, i - 1) },
        { label: tStatic("sb.moveDown"), icon: ArrowDown, disabled: i < 0 || i >= sibs.length - 1, onSelect: () => move(n, n.parent_id, i + 1) },
        {
          label: tStatic("sb.levelUp"),
          icon: CornerLeftUp,
          disabled: !parent,
          onSelect: () => {
            if (!parent) return;
            const up = siblingsOf(parent).filter((x) => x.id !== n.id);
            move(n, parent.parent_id, up.findIndex((x) => x.id === parent.id) + 1);
          },
        },
        { label: tStatic("sb.toTop"), icon: ArrowUpToLine, disabled: n.parent_id == null, onSelect: () => move(n, null, s().tree.length) },
      ],
    },
    {
      label: tStatic("common.copy"),
      icon: ClipboardCopy,
      submenu: [
        { label: tStatic("sb.copyLink"), icon: Link2, onSelect: () => copy(`[[${n.title}]]`, tStatic("sb.what.link")) },
        { label: tStatic("sb.what.title"), icon: Type, onSelect: () => copy(n.title, tStatic("sb.what.title")) },
        { label: tStatic("sb.copyMarkdown"), icon: FileText, onSelect: () => api.page(n.id).then((d) => copy(d.content, tStatic("sb.what.content")), (e) => s().error(tStatic("sb.copyFailed"), e)) },
      ],
    },
    ...(n.children.length
      ? [
          { label: tStatic("fl.tidy"), icon: Wand2, onSelect: () => openTidyUp(n.id, n.title) },
          { label: tStatic("sb.expandAll"), icon: ChevronsUpDown, onSelect: () => setCollapsed(new Set([...collapsed].filter((id) => id !== n.id && !descendants(n).includes(id)))) },
          { label: tStatic("sb.collapseAll"), icon: ChevronsDownUp, onSelect: () => setCollapsed(new Set([...collapsed, ...descendants(n)])) },
        ]
      : []),
    "separator",
    {
      label: n.favorite ? tStatic("sb.unfavorite") : tStatic("sb.favorite"),
      icon: n.favorite ? StarOff : Star,
      onSelect: async () => {
        try {
          await api.setFavorite(n.id, !n.favorite);
          s().refreshTree();
        } catch (e) {
          s().error(tStatic("sb.favoriteFailed"), e);
        }
      },
    },
    { label: tStatic("att.renameButton"), icon: PencilLine, shortcut: "F2", onSelect: () => setRenaming(n.id) },
    "separator" as const,
    { label: tStatic("common.delete"), icon: Trash2, danger: true, shortcut: tStatic("sb.keyDelete"), onSelect: () => deletePage(n) },
    ];
  };

  /** Several pages to the trash at once (their subpages go with them); one toast undoes all. */
  const deleteSelection = async () => {
    const ids = selection();
    const pages = s().pages;
    const list = ids.map((id) => pages.get(id)).filter((p): p is PageNode => !!p);
    if (!list.length) return;
    const days = s().settings?.settings.notes?.trash_retention_days ?? 30;
    if (!(await s().confirm({ title: tStatic("sb.deleteManyTitle", { n: list.length }), message: tStatic("sb.deleteManyText", { n: list.length, days }), confirmLabel: tStatic("common.delete"), danger: true })))
      return;
    const done: PageNode[] = [];
    for (const p of list) {
      try {
        await api.deletePage(p.id);
        done.push(p);
      } catch (e) {
        s().error(tStatic("pv.deleteFailed"), e);
      }
    }
    setSelected(new Set());
    await s().refreshTree();
    if (!done.length) return;
    s().toast({
      tone: "info",
      title: tStatic("sb.deletedMany", { n: done.length }),
      action: {
        label: tStatic("common.undo"),
        run: async () => {
          for (const p of done) await api.restorePage(p.id).catch((e) => s().error(tStatic("trash.restoreFailed"), e));
          await s().refreshTree();
        },
      },
    });
  };

  // Keyboard: arrows move between visible rows, Left/Right collapse/expand, Enter opens.
  const treeRef = useRef<HTMLDivElement>(null);
  // A row to focus once it is rendered (a large tree renders only the rows in view).
  const pendingFocus = useRef<number | null>(null);
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const focusRow = (id: number | null | undefined) => {
    if (id == null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`.tree-row[data-id="${id}"]`);
    if (el) {
      el.focus();
      if (virtual) el.scrollIntoView({ block: "nearest" });
      return;
    }
    pendingFocus.current = id;
    setFocusedId(id);
  };
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>, n: PageNode) => {
    if (menu || e.target !== e.currentTarget) return;
    const i = rows.findIndex((r) => r.node.id === n.id);
    const at = (k: number) => rows[k]?.node.id;
    const open = n.children.length > 0 && !collapsed.has(n.id);
    const key = e.key;
    if ((e.shiftKey && key === "F10") || key === "ContextMenu") {
      openMenuAt(e, menuItems(n));
      return;
    }
    const handled = () => e.preventDefault();
    if (key === "Escape" && selected.size) return (handled(), setSelected(new Set()));
    if (key === " " && (e.ctrlKey || e.metaKey)) return (handled(), toggleSelected(n.id));
    if (e.shiftKey && (key === "ArrowDown" || key === "ArrowUp")) {
      handled();
      const next = at(i + (key === "ArrowDown" ? 1 : -1));
      if (next == null) return;
      // A range from the anchor, as in the file managers: going back shrinks it again.
      if (!selected.size || anchor.current == null || !rows.some((r) => r.node.id === anchor.current)) anchor.current = n.id;
      setSelected(new Set(rangeIds(rows.map((r) => r.node.id), anchor.current, next)));
      focusRow(next);
      return;
    }
    if (key === "a" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      handled();
      setSelected(new Set(rows.map((r) => r.node.id)));
      return;
    }
    if (key === "F2" && !selected.size) return (handled(), setRenaming(n.id));
    if (key === "Delete" || (key === "Backspace" && e.metaKey)) {
      handled();
      if (selected.size > 1 && selected.has(n.id)) void deleteSelection();
      else void deletePage(n);
      return;
    }
    if (key === "Enter" || key === " ") (handled(), s().openPage(n.id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey }));
    else if (key === "ArrowDown") (handled(), focusRow(at(i + 1)));
    else if (key === "ArrowUp") (handled(), focusRow(at(i - 1)));
    else if (key === "Home") (handled(), focusRow(at(0)));
    else if (key === "End") (handled(), focusRow(at(rows.length - 1)));
    else if (key === "ArrowRight") {
      handled();
      if (n.children.length && !open) toggle(n.id);
      else if (open) focusRow(n.children[0].id);
    } else if (key === "ArrowLeft") {
      handled();
      if (open) toggle(n.id);
      else focusRow(n.parent_id);
    }
  };

  const toggleSelected = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
    anchor.current = id;
  };
  const click = (n: PageNode, e: React.MouseEvent) => {
    if (e.shiftKey) {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      setSelected(new Set(rangeIds(rows.map((r) => r.node.id), anchor.current ?? activePageId ?? null, n.id)));
      return;
    }
    // Ctrl/Cmd+click selects, as in the file managers; the open page joins a new selection.
    // A new tab is the middle click or the context menu.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (!selected.size && activePageId != null && activePageId !== n.id) {
        setSelected(new Set([activePageId, n.id]));
        anchor.current = n.id;
        return;
      }
      return toggleSelected(n.id);
    }
    if (selected.size) setSelected(new Set());
    anchor.current = n.id;
    s().openPage(n.id, { split: e.altKey });
  };

  // The latest closures, reached through one stable object.
  const latest = useRef({ toggle, onDrop, onRowKey, menuItems, openMenu, openMenuAt, drag, setDrag, setFocusedId, click, selected, focusRow });
  latest.current = { toggle, onDrop, onRowKey, menuItems, openMenu, openMenuAt, drag, setDrag, setFocusedId, click, selected, focusRow };
  const actions = useMemo<RowActions>(
    () => ({
      toggle: (id) => latest.current.toggle(id),
      open: (n, e) => latest.current.click(n, e),
      menu: (n, e) => latest.current.openMenu(e, latest.current.menuItems(n)),
      menuAt: (n, e) => latest.current.openMenuAt(e, latest.current.menuItems(n)),
      key: (n, e) => latest.current.onRowKey(e, n),
      focus: (n) => latest.current.setFocusedId(n.id),
      dragStart: (n, e) => {
        e.dataTransfer.effectAllowed = "move";
        // Own type, so dropping into the editor does not paste the id as text.
        e.dataTransfer.setData("application/x-arcalo-page", String(n.id));
        const sel = latest.current.selected;
        latest.current.setDrag({ id: n.id, many: sel.size > 1 && sel.has(n.id) });
      },
      dragEnd: () => latest.current.setDrag(null),
      dragOver: (n, e) => {
        const d = latest.current.drag;
        if (!d || d.id === n.id || (d.many && latest.current.selected.has(n.id))) return;
        // Not into the dragged page's own subtree (the move would be refused).
        const parentOf = (id: number) => useApp.getState().pages.get(id)?.parent_id;
        const moving = d.many ? [...latest.current.selected] : [d.id];
        if (moving.some((m) => isWithin(n.id, m, parentOf))) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        const pos: DropPos = y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
        if (d.over !== n.id || d.pos !== pos) latest.current.setDrag({ ...d, over: n.id, pos });
      },
      dragLeave: (n) => {
        const d = latest.current.drag;
        if (d?.over === n.id) latest.current.setDrag({ id: d.id, many: d.many });
      },
      drop: (n, e) => {
        e.preventDefault();
        latest.current.onDrop(n, latest.current.drag?.pos ?? "inside");
      },
      rename: (n) => {
        if (latest.current.selected.size > 1) return;
        setRenaming(n.id);
      },
      renameDone: (n, refocus) => {
        setRenaming((id) => (id === n.id ? null : id));
        if (refocus) requestAnimationFrame(() => latest.current.focusRow(n.id));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Visible rows in document order, each folder in its own sort; recomputed only when the tree,
  // the collapsed set or the filter changes. A filter shows the hits with their ancestors open.
  const filtered = useMemo(() => filterIds(nodes, filter), [nodes, filter]);
  const rows = useMemo(() => {
    const out: { node: PageNode; depth: number }[] = [];
    const walk = (list: PageNode[], depth: number, style: FolderStyle | null | undefined) => {
      for (const n of sortNodes(list, style)) {
        if (filtered && !filtered.shown.has(n.id)) continue;
        out.push({ node: n, depth });
        if (n.children.length && (filtered ? true : !collapsed.has(n.id))) walk(n.children, depth + 1, n.style);
      }
    };
    walk(nodes, 0, rootStyle);
    return out;
  }, [nodes, collapsed, filtered, rootStyle]);
  // A selection keeps only pages that still exist.
  useEffect(() => {
    if (selected.size && [...selected].some((id) => !s().pages.has(id))) setSelected(new Set([...selected].filter((id) => s().pages.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  const focusable = activePageId != null && s().pages.has(activePageId) ? activePageId : nodes[0]?.id;

  // Large trees: the scroll position of the sidebar decides which rows exist.
  const virtual = rows.length >= VIRTUAL_ROWS;
  const [view, setView] = useState({ top: 0, height: 900, rowH: 28 });
  useLayoutEffect(() => {
    const tree = treeRef.current;
    const scroller = tree?.closest<HTMLElement>(".sidebar-scroll");
    if (!virtual || !tree || !scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const offset = tree.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const rowH = parseFloat(getComputedStyle(tree).getPropertyValue("--tree-row-h")) || 28;
      const next = { top: scroller.scrollTop - offset, height: scroller.clientHeight, rowH };
      setView((v) => (v.top === next.top && v.height === next.height && v.rowH === next.rowH ? v : next));
    };
    const schedule = () => (frame ||= requestAnimationFrame(update));
    update();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(scroller);
    // Density (Settings → Darstellung) changes the row height.
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      ro.disconnect();
      mo.disconnect();
    };
  }, [virtual]);

  // WebKit anchors the scroll position to a row when the rendered rows change (overflow-anchor
  // is not supported there): the position before the commit is the one to keep.
  const beforeCommit = useRef<number | null>(null);
  beforeCommit.current = virtual ? (treeRef.current?.closest(".sidebar-scroll")?.scrollTop ?? null) : null;
  useLayoutEffect(() => {
    const scroller = treeRef.current?.closest(".sidebar-scroll");
    if (scroller && beforeCommit.current != null && scroller.scrollTop !== beforeCommit.current) scroller.scrollTop = beforeCommit.current;
  });

  // A row to be focused that is out of view: scroll it in (it is rendered then, see below).
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (id == null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`.tree-row[data-id="${id}"]`);
    if (!el) return;
    pendingFocus.current = null;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  });

  // Shared by all rows (one store subscription instead of one per row).
  const conflicts = useApp((st) => st.conflicts);
  const conflictIds = useMemo(() => new Set(conflicts.map((c) => c.page_id)), [conflicts]);

  // The dragged, the focused and the tab-reachable row stay rendered when scrolled away.
  const shown = virtual
    ? treeWindow(rows.length, view, [drag?.id, focusedId, focusable, renaming].map((id) => (id == null ? -1 : rows.findIndex((r) => r.node.id === id))))
    : null;
  const row = (i: number) => {
    const { node, depth } = rows[i];
    return (
      <TreeRow
        key={node.id}
        node={node}
        depth={depth}
        top={shown ? i * view.rowH : undefined}
        active={activePageId === node.id}
        open={filtered ? node.children.some((c) => filtered.shown.has(c.id)) : !collapsed.has(node.id)}
        selected={selected.has(node.id)}
        hit={!!filtered?.hits.has(node.id)}
        drop={drag?.over === node.id ? drag.pos : undefined}
        focusable={focusable === node.id}
        conflict={conflictIds.has(node.id)}
        renaming={renaming === node.id}
        act={actions}
      />
    );
  };

  return (
    <>
      {selected.size > 1 && (
        <div className="tree-selection" role="status">
          <span>{tStatic("fl.selected", { n: selected.size })}</span>
          <Button size="sm" variant="ghost" icon={FolderInput} onClick={() => openMoveTo(selection())}>
            {tStatic("fl.moveTo")}
          </Button>
          <IconButton icon={X} size="sm" label={tStatic("fl.clearSelection")} onClick={() => setSelected(new Set())} />
        </div>
      )}
      {filtered && rows.length === 0 && <div className="side-empty tree-filter-empty">{tStatic("fl.filterEmpty", { q: filter.trim() })}</div>}
      <div
        className={`tree ${shown ? "is-virtual" : ""}`}
        role="tree"
        aria-label={tStatic("sb.pages")}
        aria-multiselectable
        ref={treeRef}
        style={shown ? { height: rows.length * view.rowH } : undefined}
      >
        {shown ? shown.map(row) : rows.map((_, i) => row(i))}
        {menu}
      </div>
    </>
  );
}

const TreeRow = memo(function TreeRow({
  node: n,
  depth,
  top,
  active,
  open,
  selected,
  hit,
  drop,
  focusable,
  conflict,
  renaming,
  act,
}: {
  node: PageNode;
  depth: number;
  /** Position in a virtualized tree. */
  top?: number;
  active: boolean;
  open: boolean;
  /** Part of the multi-selection. */
  selected: boolean;
  /** Matches the tree filter. */
  hit: boolean;
  drop?: DropPos;
  focusable: boolean;
  conflict: boolean;
  renaming: boolean;
  act: RowActions;
}) {
  // The action buttons exist only while the row is hovered or has the focus.
  const [hot, setHot] = useState(false);
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={n.children.length ? open : undefined}
      className={`tree-row ${active ? "active" : ""} ${selected ? "selected" : ""} ${hit ? "hit" : ""} ${drop ? `drop-${drop}` : ""} ${renaming ? "renaming" : ""}`}
      aria-selected={selected}
      style={top == null ? { paddingLeft: 6 + depth * 14 } : { paddingLeft: 6 + depth * 14, position: "absolute", top, left: 0, right: 0 }}
      data-id={n.id}
      tabIndex={focusable ? 0 : -1}
      aria-current={active ? "page" : undefined}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && setHot(false)}
      onFocus={(e) => {
        setHot(true);
        if (e.target === e.currentTarget) act.focus(n);
      }}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover") && setHot(false)}
      draggable={!renaming}
      onDragStart={(e) => act.dragStart(n, e)}
      onDragEnd={act.dragEnd}
      onDragOver={(e) => act.dragOver(n, e)}
      onDragLeave={() => act.dragLeave(n)}
      onDrop={(e) => act.drop(n, e)}
      onClick={(e) => act.open(n, e)}
      onAuxClick={(e) => e.button === 1 && useApp.getState().openPage(n.id, { newTab: true })}
      onContextMenu={(e) => act.menu(n, e)}
      onKeyDown={(e) => act.key(n, e)}
    >
      <span
        className={`tree-twisty ${n.children.length ? "" : "leaf"}`}
        onClick={(e) => {
          e.stopPropagation();
          act.toggle(n.id);
        }}
      >
        {n.children.length > 0 && <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />}
      </span>
      <PageIcon name={n.icon} size={15} className={`tree-icon ${n.style?.color ? `tint-${n.style.color}` : ""}`} />
      {renaming ? (
        <TreeRename node={n} onDone={(refocus) => act.renameDone(n, refocus)} />
      ) : (
        <span
          className="tree-label"
          onDoubleClick={(e) => {
            // Renames in place; the first click already opened the page as a single click does.
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            e.stopPropagation();
            act.rename(n);
          }}
        >
          {n.title}
        </span>
      )}
      {conflict && <span className="tree-conflict" title={tStatic("sb.conflictTip")} aria-label={tStatic("cf.conflict")} />}
      {hot && !renaming && <span className="tree-row-actions">
        <IconButton
          icon={MoreHorizontal}
          label={tStatic("sidebar.pageActions")}
          size="sm"
          tooltipSide="right"
          onClick={(e) => {
            e.stopPropagation();
            act.menuAt(n, e);
          }}
        />
        <IconButton
          icon={Plus}
          label={tStatic("sidebar.subpage")}
          size="sm"
          tooltipSide="right"
          onClick={(e) => {
            e.stopPropagation();
            createSubpage(n.id);
          }}
        />
      </span>}
    </div>
  );
});

/** The title of a tree row as an input: Enter saves (links rewritten), Escape cancels. */
function TreeRename({ node, onDone }: { node: PageNode; onDone: (refocus: boolean) => void }) {
  const [value, setValue] = useState(node.title);
  // `[ ] | # ^` were typed and replaced (they belong to the link syntax).
  const [charsHint, setCharsHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(refocus);
  };
  const commit = async (fromBlur: boolean) => {
    if (busy.current || done.current) return;
    const name = value.trim();
    if (name === node.title) return finish(!fromBlur);
    const problem = renameProblem(node.id, name, useApp.getState().pages);
    if (problem) {
      // Leaving the field with a name that cannot be used keeps the old one.
      if (fromBlur) return finish(false);
      setError(problem);
      return;
    }
    busy.current = true;
    try {
      await renameInTree(node, name);
      finish(!fromBlur);
    } catch (e) {
      busy.current = false;
      if (fromBlur) {
        finish(false);
        useApp.getState().error(tStatic("page.renameFailed"), e);
      } else setError(errorParts(e).text);
    }
  };
  const message = error ?? (charsHint ? tStatic("pv.titleHint") : null);
  const msgId = `tree-rename-msg-${node.id}`;
  return (
    <>
      <input
        ref={input}
        className="tree-rename"
        value={value}
        spellCheck={false}
        aria-label={tStatic("sb.renameAria", { title: node.title })}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? msgId : undefined}
        onChange={(e) => {
          const typed = e.target.value;
          const clean = cleanTitleChars(typed);
          setValue(clean);
          if (clean !== typed) setCharsHint(true);
          setError(null);
        }}
        onKeyDown={(e) => {
          // The row's keys (arrows, Delete, F2, Ctrl+A) stay with the text field.
          e.stopPropagation();
          if (e.key === "Enter") (e.preventDefault(), void commit(false));
          else if (e.key === "Escape") (e.preventDefault(), finish(true));
        }}
        onBlur={() => void commit(true)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
      {message && (
        <span id={msgId} className={`tree-rename-msg ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
          {message}
        </span>
      )}
    </>
  );
}

// ------------------------------------------------------------- timer dock

export function useTimerSeconds() {
  const timer = useApp((s) => s.timer);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timer) return;
    setNow(Date.now());
    // Paused: the clock stands still.
    if (timer.paused_since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer]);
  return timer ? timerSeconds(timer, now) : 0;
}

/** Worked seconds of a running timer at `now`: the pauses are left out, a paused one stands still. */
export function timerSeconds(timer: TimerStatus, now: number): number {
  const until = timer.paused_since ? Math.min(now, new Date(timer.paused_since).getTime()) : now;
  return Math.max(0, (until - new Date(timer.entry.start_time).getTime()) / 1000 - (timer.paused_seconds ?? 0));
}

/** „Timer pausieren“ / „Fortsetzen“ (widgets, tray, shortcut). */
export async function toggleTimerPause() {
  const s = useApp.getState();
  const t = s.timer;
  if (!t) return;
  try {
    await api.timerPause(!t.paused_since);
    await s.refreshTimer();
    s.bumpEntries();
  } catch (e) {
    s.error(tStatic(t.paused_since ? "timer.resumeFailed" : "timer.pauseFailed"), e);
  }
}

function TimerDock() {
  const t = useT();
  const timer = useApp((s) => s.timer);
  const seconds = useTimerSeconds();
  // A timer left running stays in the data, but is not shown while time tracking is off.
  const timeOn = useTimeTracking();
  if (!timer || !timeOn) return null;
  const e = timer.entry;
  const paused = !!timer.paused_since;
  return (
    <div className={`timer-dock${paused ? " paused" : ""}`} role="status">
      <span className={paused ? "pause-dot" : "rec-dot"} aria-hidden />
      <button type="button" className="timer-dock-main" onClick={() => useApp.getState().openTab({ kind: "timesheet" })}>
        <span className="timer-dock-time num">{clock(seconds)}</span>
        <span className="timer-dock-label">{paused ? t("timer.paused") : e.description || `${e.vorgang_nr ?? "Timer"}`}</span>
      </button>
      <IconButton icon={paused ? Play : Pause} label={paused ? t("timer.resume") : t("timer.pause")} size="md" onClick={() => void toggleTimerPause()} />
      <IconButton icon={Square} label={t("status.stopTimer")} size="md" onClick={() => stopTimer()} />
    </div>
  );
}

export async function stopTimer() {
  const s = useApp.getState();
  const t = s.timer;
  if (!t) return;
  try {
    let subtract = false;
    // Forgotten over night: ask before booking a whole day or more.
    // (Worked time: the pauses are not booked.)
    const long = longTimerHours(new Date(Date.now() - timerSeconds(t, Date.now()) * 1000).toISOString(), new Date());
    if (long != null) {
      const ok = await s.confirm({
        title: tStatic("timer.longTitle"),
        message: tStatic("timer.longMessage", { n: long }),
        confirmLabel: tStatic("timer.bookHours", { n: long }),
      });
      if (!ok) return; // timer keeps running
    }
    if (t.idle_minutes > 0) {
      const choice = await s.choose({
        title: tStatic("timer.idleTitle"),
        message: tStatic("timer.idleMessage", { n: t.idle_minutes }),
        confirmLabel: tStatic("timer.idleSubtract"),
        altLabel: tStatic("timer.bookFull"),
      });
      if (choice === "cancel") return; // timer keeps running
      subtract = choice === "confirm";
    }
    const out = await api.timerStop(subtract);
    const entries = out.entries?.length ? out.entries : [out.entry];
    if (out.clock_back) s.toast({ tone: "warning", persistent: true, title: tStatic("timer.clockBackTitle"), detail: tStatic("timer.clockBackDetail") });
    else if (out.discarded) s.toast({ tone: "info", title: tStatic("focus.notBooked"), detail: tStatic("timer.underMinute") });
    else if (entries.length > 1)
      // Over midnight: one booking per day.
      s.toast({
        tone: "success",
        title: tStatic("ne.booked", { h: fmtMinutes(entries.reduce((a, e) => a + (e.duration_minutes ?? 0), 0)) }),
        detail: tStatic("timer.splitDays", { days: entries.map((e) => `${weekdayShort(new Date(e.start_time))} ${fmtDayMonth(new Date(e.start_time))}: ${fmtMinutes(e.duration_minutes)} h`).join(", ") }),
      });
    else s.toast({ tone: "success", title: tStatic("ne.booked", { h: fmtMinutes(out.entry.duration_minutes) }), detail: out.entry.description || undefined });
    s.alerts(out.alerts);
    s.bumpEntries();
  } catch (e) {
    s.error(tStatic("timer.stopFailed"), e);
  }
}
