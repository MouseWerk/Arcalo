// Left sidebar: navigation, favorites, page tree (drag & drop), tags, timer.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns2, CornerDownRight, FilePlus2, FolderTree, Hash, MoreHorizontal, PencilLine, Plus, Search, Square, Star, StarOff, Timer, Trash2, X,
  ArrowDown, ArrowUp, ArrowUpToLine, ClipboardCopy, Copy, CornerLeftUp, FileText, LayoutTemplate, Link2, MoveVertical, Shapes, Type,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { PAGE_ICONS, PageIcon, iconLabel } from "./icons";
import { Button, IconButton, useMenu, type MenuEntry } from "./ui";
import { clock, fmtMinutes } from "../lib/format";
import { createSubpage, deletePage } from "../views/PageView";
import { COLLAPSED_EVENT, readCollapsed, writeCollapsed } from "../lib/collapsed";
import type { PageNode, SearchHit } from "../lib/types";
import { t as tStatic, useT } from "../lib/i18n";
import { withHint } from "../lib/keymap";
import { keys } from "../lib/shortcut";
import { newPageFromTemplate } from "./Templates";
import { stripMarkdown } from "../lib/plaintext";
import { treeWindow } from "../lib/treeWindow";

type SideTab = "files" | "search" | "bookmarks" | "tags";

/** Title of the daily notes' folder (Settings → Notizen). */
const journalTitle = () => useApp.getState().settings?.settings.notes?.daily_folder || "Journal";
/** Id of the Journal folder that was already collapsed once by default. */
const JOURNAL_SEEN_KEY = "annalo.journal-collapsed";

export function Sidebar() {
  const t = useT();
  const tree = useApp((s) => s.tree);
  const onboarding = useApp((s) => s.onboarding);
  const pages = useApp((s) => s.pages);
  const active = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
  const [tab, setTabState] = useState<SideTab>(() => (localStorage.getItem("annalo.sidetab") as SideTab) || "files");
  const [collapsed, setCollapsed] = useState<Set<number>>(readCollapsed);
  const setTab = (t: SideTab) => {
    setTabState(t);
    localStorage.setItem("annalo.sidetab", t);
  };
  const saveCollapsed = (next: Set<number>) => {
    setCollapsed(next);
    writeCollapsed(next);
  };
  useEffect(() => {
    const onFocusSearch = () => setTab("search");
    const onCollapsed = () => setCollapsed(readCollapsed());
    window.addEventListener("annalo:sidebar-search", onFocusSearch);
    window.addEventListener(COLLAPSED_EVENT, onCollapsed);
    return () => {
      window.removeEventListener("annalo:sidebar-search", onFocusSearch);
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
    const showsDaily = activePageId != null && journal.children.some((c) => c.id === activePageId);
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
  const allCollapsed = withChildren.length > 0 && withChildren.every((id) => collapsed.has(id));

  return (
    <aside className="sidebar" aria-label={t("sidebar.label")}>
      <div className="side-tabs" role="tablist" data-tauri-drag-region>
        {tabs.map((t) => (
          <IconButton key={t.id} icon={t.icon} label={t.label} active={tab === t.id} size="md" onClick={() => setTab(t.id)} role="tab" aria-selected={tab === t.id} />
        ))}
      </div>

      {tab === "files" && (
        <>
          <div className="side-toolbar">
            <span className="side-title">{t("sidebar.files")}</span>
            <IconButton icon={FilePlus2} label={t("sidebar.newPage")} size="md" onClick={() => createSubpage(null)} />
            <IconButton
              icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
              label={allCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
              size="md"
              onClick={() => saveCollapsed(allCollapsed ? new Set() : new Set(withChildren))}
            />
          </div>
          <div className="sidebar-scroll">
            {tree.length === 0 ? (
              // During onboarding the welcome choice explains the empty workspace.
              !onboarding && <div className="side-empty">
                {t("sidebar.noPages")}
                <Button size="sm" icon={FilePlus2} onClick={() => createSubpage(null)}>
                  {t("sidebar.newPage")}
                </Button>
              </div>
            ) : (
              <PageTree nodes={tree} activePageId={activePageId} collapsed={collapsed} setCollapsed={saveCollapsed} />
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
  const [trashed, setTrashed] = useState(0);
  // The tree reloads after every delete/restore, so its identity is a good refresh signal.
  useEffect(() => {
    api.trash().then((t) => setTrashed(t.length)).catch(() => {});
  }, [pages]);
  return (
    <div className="sidebar-foot">
      <button type="button" className="side-foot-btn" onClick={() => s().openTab({ kind: "timesheet" })} title={t("sidebar.openTimesheet")}>
        <Timer size={14} strokeWidth={1.75} />
        <span>{t("sidebar.today")}</span>
        <TodayHours />
      </button>
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
  const [q, setQ] = useState(() => sessionStorage.getItem("annalo.sidesearch") ?? "");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const s = useApp.getState;
  useEffect(() => {
    setTimeout(() => input.current?.focus(), 30);
    const onFocus = () => input.current?.select();
    window.addEventListener("annalo:sidebar-search", onFocus);
    return () => window.removeEventListener("annalo:sidebar-search", onFocus);
  }, []);
  useEffect(() => {
    sessionStorage.setItem("annalo.sidesearch", q);
    if (q.trim().length < 2) return setHits(null);
    let alive = true;
    const t = setTimeout(() => api.search(q, 60).then((h) => alive && setHits(h)).catch(() => {}), 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);
  const pageHits = (hits ?? []).filter((h) => h.kind !== "time_entry") as Extract<SearchHit, { page_id: number }>[];
  const byPage = new Map<number, { title: string; icon: string | null; snippets: string[] }>();
  for (const h of pageHits) {
    const e = byPage.get(h.page_id) ?? { title: h.title, icon: h.icon, snippets: [] };
    if (h.kind === "note") e.snippets.push(h.snippet);
    byPage.set(h.page_id, e);
  }
  const entries = (hits ?? []).filter((h) => h.kind === "time_entry") as Extract<SearchHit, { kind: "time_entry" }>[];
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
          <div className="side-result-count">
            {byPage.size} {byPage.size === 1 ? tr("sidebar.page") : tr("sidebar.pages")}
            {entries.length > 0 && `, ${entries.length} ${tr("sidebar.timeEntries")}`}
          </div>
        )}
        {[...byPage.entries()].map(([id, p]) => (
          <button key={id} type="button" className="side-result" onClick={(e) => s().openPage(id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey })}>
            <span className="side-result-title">
              <PageIcon name={p.icon} size={14} /> {p.title}
            </span>
            {p.snippets.slice(0, 2).map((sn, i) => (
              <span key={i} className="side-result-snippet" dangerouslySetInnerHTML={{ __html: markHits(sn) }} />
            ))}
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
        {hits && hits.length === 0 && <div className="side-empty">{tr("sidebar.noHits", { q })}</div>}
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

type DropPos = "before" | "inside" | "after";

/** Trees with this many visible rows render only the rows in view (plus a margin). */
const VIRTUAL_ROWS = 150;

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
}: {
  nodes: PageNode[];
  activePageId?: number;
  collapsed: Set<number>;
  setCollapsed: (s: Set<number>) => void;
}) {
  const [drag, setDrag] = useState<{ id: number; over?: number; pos?: DropPos } | null>(null);
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

  const onDrop = async (target: PageNode, pos: DropPos) => {
    const id = drag?.id;
    setDrag(null);
    if (id == null || id === target.id) return;
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
      s().error("Verschieben nicht möglich", e);
    }
  };

  const siblingsOf = (n: PageNode) => (n.parent_id == null ? s().tree : (s().pages.get(n.parent_id)?.children ?? []));
  const move = async (n: PageNode, parentId: number | null, position: number) => {
    try {
      await api.movePage(n.id, parentId, position);
      await s().refreshTree();
    } catch (e) {
      s().error("Verschieben nicht möglich", e);
    }
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => s().toast({ tone: "success", title: `${what} kopiert` }),
      (e) => s().error("Kopieren nicht möglich", e),
    );
  const descendants = (n: PageNode): number[] => n.children.flatMap((c) => (c.children.length ? [c.id, ...descendants(c)] : []));

  const menuItems = (n: PageNode): MenuEntry[] => {
    const sibs = siblingsOf(n);
    const i = sibs.findIndex((x) => x.id === n.id);
    const parent = n.parent_id != null ? s().pages.get(n.parent_id) : undefined;
    return [
    { label: "In neuem Tab öffnen", icon: CornerDownRight, shortcut: keys("Mod Klick"), onSelect: () => s().openPage(n.id, { newTab: true }) },
    { label: "Rechts daneben öffnen", icon: Columns2, shortcut: keys("Alt Klick"), onSelect: () => s().openPage(n.id, { split: true }) },
    "separator",
    {
      label: "Neu",
      icon: FilePlus2,
      submenu: [
        { label: "Unterseite", icon: CornerDownRight, onSelect: () => createSubpage(n.id) },
        {
          label: "Seite daneben",
          icon: FilePlus2,
          onSelect: async () => {
            try {
              const p = await api.createPage("Unbenannt", n.parent_id, s().settings?.settings.editor?.default_icon ?? "file-text");
              await api.movePage(p.id, n.parent_id, i + 1);
              await s().refreshTree();
              s().openPage(p.id);
              setTimeout(() => document.querySelector<HTMLTextAreaElement>(".pane.active .page-title")?.select(), 120);
            } catch (e) {
              s().error("Seite konnte nicht angelegt werden", e);
            }
          },
        },
        { label: "Unterseite aus Vorlage…", icon: LayoutTemplate, onSelect: () => newPageFromTemplate(n.id) },
      ],
    },
    {
      label: "Duplizieren",
      icon: Copy,
      onSelect: async () => {
        try {
          const doc = await api.page(n.id);
          const p = await api.createPage(`${n.title} (Kopie)`, n.parent_id, n.icon, doc.content);
          await api.movePage(p.id, n.parent_id, i + 1);
          await s().refreshTree();
          s().openPage(p.id);
        } catch (e) {
          s().error("Duplizieren nicht möglich", e);
        }
      },
    },
    {
      label: "Symbol ändern",
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
            s().error("Symbol konnte nicht geändert werden", e);
          }
        },
      })),
    },
    {
      label: "Verschieben",
      icon: MoveVertical,
      submenu: [
        { label: "Nach oben", icon: ArrowUp, disabled: i <= 0, onSelect: () => move(n, n.parent_id, i - 1) },
        { label: "Nach unten", icon: ArrowDown, disabled: i < 0 || i >= sibs.length - 1, onSelect: () => move(n, n.parent_id, i + 1) },
        {
          label: "Eine Ebene höher",
          icon: CornerLeftUp,
          disabled: !parent,
          onSelect: () => {
            if (!parent) return;
            const up = siblingsOf(parent).filter((x) => x.id !== n.id);
            move(n, parent.parent_id, up.findIndex((x) => x.id === parent.id) + 1);
          },
        },
        { label: "Auf die oberste Ebene", icon: ArrowUpToLine, disabled: n.parent_id == null, onSelect: () => move(n, null, s().tree.length) },
      ],
    },
    {
      label: "Kopieren",
      icon: ClipboardCopy,
      submenu: [
        { label: "Link [[…]]", icon: Link2, onSelect: () => copy(`[[${n.title}]]`, "Link") },
        { label: "Titel", icon: Type, onSelect: () => copy(n.title, "Titel") },
        { label: "Inhalt als Markdown", icon: FileText, onSelect: () => api.page(n.id).then((d) => copy(d.content, "Inhalt"), (e) => s().error("Kopieren nicht möglich", e)) },
      ],
    },
    ...(n.children.length
      ? [
          { label: "Alle Unterseiten aufklappen", icon: ChevronsUpDown, onSelect: () => setCollapsed(new Set([...collapsed].filter((id) => id !== n.id && !descendants(n).includes(id)))) },
          { label: "Alle Unterseiten einklappen", icon: ChevronsDownUp, onSelect: () => setCollapsed(new Set([...collapsed, ...descendants(n)])) },
        ]
      : []),
    "separator",
    {
      label: n.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten",
      icon: n.favorite ? StarOff : Star,
      onSelect: async () => {
        try {
          await api.setFavorite(n.id, !n.favorite);
          s().refreshTree();
        } catch (e) {
          s().error("Lesezeichen konnte nicht gesetzt werden", e);
        }
      },
    },
    {
      label: "Umbenennen",
      icon: PencilLine,
      onSelect: () => {
        s().openPage(n.id);
        setTimeout(() => document.querySelector<HTMLTextAreaElement>(".pane.active .page-title")?.select(), 150);
      },
    },
    "separator" as const,
    { label: "Löschen", icon: Trash2, danger: true, onSelect: () => deletePage(n) },
    ];
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

  // The latest closures, reached through one stable object.
  const latest = useRef({ toggle, onDrop, onRowKey, menuItems, openMenu, openMenuAt, drag, setDrag, setFocusedId });
  latest.current = { toggle, onDrop, onRowKey, menuItems, openMenu, openMenuAt, drag, setDrag, setFocusedId };
  const actions = useMemo<RowActions>(
    () => ({
      toggle: (id) => latest.current.toggle(id),
      open: (n, e) => s().openPage(n.id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey }),
      menu: (n, e) => latest.current.openMenu(e, latest.current.menuItems(n)),
      menuAt: (n, e) => latest.current.openMenuAt(e, latest.current.menuItems(n)),
      key: (n, e) => latest.current.onRowKey(e, n),
      focus: (n) => latest.current.setFocusedId(n.id),
      dragStart: (n, e) => {
        e.dataTransfer.effectAllowed = "move";
        // Own type, so dropping into the editor does not paste the id as text.
        e.dataTransfer.setData("application/x-annalo-page", String(n.id));
        latest.current.setDrag({ id: n.id });
      },
      dragEnd: () => latest.current.setDrag(null),
      dragOver: (n, e) => {
        const d = latest.current.drag;
        if (!d || d.id === n.id) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        const pos: DropPos = y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
        if (d.over !== n.id || d.pos !== pos) latest.current.setDrag({ ...d, over: n.id, pos });
      },
      dragLeave: (n) => {
        const d = latest.current.drag;
        if (d?.over === n.id) latest.current.setDrag({ id: d.id });
      },
      drop: (n, e) => {
        e.preventDefault();
        latest.current.onDrop(n, latest.current.drag?.pos ?? "inside");
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Visible rows in document order; recomputed only when the tree or the collapsed set changes.
  const rows = useMemo(() => {
    const out: { node: PageNode; depth: number }[] = [];
    const walk = (list: PageNode[], depth: number) => {
      for (const n of list) {
        out.push({ node: n, depth });
        if (n.children.length && !collapsed.has(n.id)) walk(n.children, depth + 1);
      }
    };
    walk(nodes, 0);
    return out;
  }, [nodes, collapsed]);

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
    ? treeWindow(rows.length, view, [drag?.id, focusedId, focusable].map((id) => (id == null ? -1 : rows.findIndex((r) => r.node.id === id))))
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
        open={!collapsed.has(node.id)}
        drop={drag?.over === node.id ? drag.pos : undefined}
        focusable={focusable === node.id}
        conflict={conflictIds.has(node.id)}
        act={actions}
      />
    );
  };

  return (
    <div className={`tree ${shown ? "is-virtual" : ""}`} role="tree" aria-label="Seiten" ref={treeRef} style={shown ? { height: rows.length * view.rowH } : undefined}>
      {shown ? shown.map(row) : rows.map((_, i) => row(i))}
      {menu}
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  node: n,
  depth,
  top,
  active,
  open,
  drop,
  focusable,
  conflict,
  act,
}: {
  node: PageNode;
  depth: number;
  /** Position in a virtualized tree. */
  top?: number;
  active: boolean;
  open: boolean;
  drop?: DropPos;
  focusable: boolean;
  conflict: boolean;
  act: RowActions;
}) {
  // The action buttons exist only while the row is hovered or has the focus.
  const [hot, setHot] = useState(false);
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={n.children.length ? open : undefined}
      className={`tree-row ${active ? "active" : ""} ${drop ? `drop-${drop}` : ""}`}
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
      draggable
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
      <PageIcon name={n.icon} size={15} className="tree-icon" />
      <span className="tree-label">{n.title}</span>
      {conflict && <span className="tree-conflict" title="Konflikt: hier und auf dem Server geändert" aria-label="Konflikt" />}
      {hot && <span className="tree-row-actions">
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

// ------------------------------------------------------------- timer dock

export function useTimerSeconds() {
  const timer = useApp((s) => s.timer);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timer) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer]);
  return timer ? (now - new Date(timer.entry.start_time).getTime()) / 1000 : 0;
}

function TimerDock() {
  const t = useT();
  const timer = useApp((s) => s.timer);
  const seconds = useTimerSeconds();
  if (!timer) return null;
  const e = timer.entry;
  return (
    <div className="timer-dock" role="status">
      <span className="rec-dot" aria-hidden />
      <button type="button" className="timer-dock-main" onClick={() => useApp.getState().openTab({ kind: "timesheet" })}>
        <span className="timer-dock-time num">{clock(seconds)}</span>
        <span className="timer-dock-label">{e.description || `${e.vorgang_nr ?? "Timer"}`}</span>
      </button>
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
    if (t.idle_minutes > 0) {
      const choice = await s.choose({
        title: "Leerlauf erkannt",
        message: `Du warst ${t.idle_minutes} Minuten inaktiv. Soll diese Zeit von der Buchung abgezogen werden?`,
        confirmLabel: "Leerlauf abziehen",
        altLabel: "Voll buchen",
      });
      if (choice === "cancel") return; // timer keeps running
      subtract = choice === "confirm";
    }
    const out = await api.timerStop(subtract);
    if (out.discarded) s.toast({ tone: "info", title: "Nicht gebucht", detail: "Der Timer lief weniger als eine Minute." });
    else s.toast({ tone: "success", title: `${fmtMinutes(out.entry.duration_minutes)} h gebucht`, detail: out.entry.description || undefined });
    s.alerts(out.alerts);
    s.bumpEntries();
  } catch (e) {
    s.error("Timer konnte nicht gestoppt werden", e);
  }
}
