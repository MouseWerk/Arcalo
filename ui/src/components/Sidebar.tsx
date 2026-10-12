// Left sidebar: navigation, favorites, page tree (components/PageTree.tsx), tags, timer.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronsDownUp, ChevronsUpDown, FilePlus2, FolderTree, Hash, Search, SlidersHorizontal, Square, Star, Timer, Trash2, X,
  ArrowDownUp, Undo2, Wand2, LayoutList, Pause, Play,
} from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { PageIcon } from "./icons";
import { Button, IconButton, useMenu, type MenuEntry } from "./ui";
import { useTimeTracking } from "../lib/timetracking";
import { clock, fmtDayMonth, fmtMinutes, longTimerHours, weekdayShort } from "../lib/format";
import { createSubpage } from "../views/PageView";
import type { SearchHit, TimerStatus } from "../lib/types";
import { t as tStatic, useT } from "../lib/i18n";
import { withHint } from "../lib/keymap";
import { stripMarkdown } from "../lib/plaintext";
import { setExactOnly, useExactOnly, useMeaningSearch, type PageHit } from "../lib/meaningSearch";
import { DEFAULT_STYLE, filingApi, type FolderStyle, type LastMove } from "../lib/filing";
import { loadLastMove, openTidyUp, undoLastMove, useLastMove } from "./FilingDialogs";
import { SMART_EVENT, SmartFolders, setSmartHidden, smartHidden } from "./SmartFolders";
import { isComposing } from "../lib/ime";
import { PageTree, sortMenu, useTreeOpen, type TreeHandle } from "./PageTree";
import { newMenuItems } from "./newItems";
import { focusItem, titleIfCut, treeKeyDown } from "./treeKeys";

type SideTab = "files" | "search" | "bookmarks" | "tags";

/** Asks the sidebar to show the open page in the tree („Im Baum zeigen“). */
export const REVEAL_EVENT = "arcalo:reveal-in-tree";

export function Sidebar() {
  const t = useT();
  const tree = useApp((s) => s.tree);
  const onboarding = useApp((s) => s.onboarding);
  const pages = useApp((s) => s.pages);
  const active = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
  const panes = useApp((s) => s.panes);
  const activePaneId = useApp((s) => s.activePaneId);
  const [tab, setTabState] = useState<SideTab>(() => (localStorage.getItem("arcalo.sidetab") as SideTab) || "files");
  const treeOpen = useTreeOpen(tree);
  const treeHandle = useRef<TreeHandle | null>(null);
  const [selectionSlot, setSelectionSlot] = useState<HTMLDivElement | null>(null);
  const setTab = (t: SideTab) => {
    setTabState(t);
    localStorage.setItem("arcalo.sidetab", t);
  };
  const activePageId = active?.kind === "page" ? active.pageId : undefined;
  // Pages shown in the other panes are marked in the tree.
  const elsewhereKey = panes
    .filter((p) => p.id !== activePaneId)
    .map((p) => p.tabs.find((x) => x.id === p.activeTabId))
    .map((x) => (x?.kind === "page" ? x.pageId : null))
    .filter((id): id is number => id != null && id !== activePageId)
    .join(",");
  const elsewhere = useMemo(() => new Set(elsewhereKey ? elsewhereKey.split(",").map(Number) : []), [elsewhereKey]);
  // Ordner & Ablage: the filter, the top level's sort and whether the smart folders show.
  const [filter, setFilter] = useState("");
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    const onFocusSearch = () => setTab("search");
    const onReveal = () => {
      setTab("files");
      setFilter("");
      setRevealTick((n) => n + 1);
    };
    window.addEventListener("arcalo:sidebar-search", onFocusSearch);
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => {
      window.removeEventListener("arcalo:sidebar-search", onFocusSearch);
      window.removeEventListener(REVEAL_EVENT, onReveal);
    };
  }, []);
  // „Im Baum zeigen“ once the tree shows (unfiltered).
  useEffect(() => {
    if (revealTick) requestAnimationFrame(() => treeHandle.current?.revealActive());
  }, [revealTick]);

  const tabs: { id: SideTab; label: string; icon: typeof Search }[] = [
    { id: "files", label: t("sidebar.files"), icon: FolderTree },
    { id: "search", label: withHint(t("sidebar.search"), "search"), icon: Search },
    { id: "bookmarks", label: t("sidebar.bookmarks"), icon: Star },
    { id: "tags", label: t("sidebar.tags"), icon: Hash },
  ];
  const withChildren = useMemo(() => [...pages.values()].filter((p) => p.children.length).map((p) => p.id), [pages]);
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
  // „Rückgängig“ names what it takes back: the last tidy-up or the last move.
  const treeMenuItems = (last: LastMove | null): MenuEntry[] => [
    { label: t("fl.sortTop"), icon: ArrowDownUp, submenu: sortMenu(rootStyle, setRoot) },
    "separator",
    { label: t("fl.tidy"), icon: Wand2, onSelect: () => openTidyUp(null) },
    {
      label: last?.label === "tidy" ? t("fl.undoLast") : t("fl.undoLastMove"),
      icon: Undo2,
      disabled: !last,
      hint: last ? undefined : t("fl.nothingToUndo"),
      onSelect: () => void undoLastMove(),
    },
    "separator",
    { label: smartShown ? t("fl.smartHide") : t("fl.smartShow"), icon: LayoutList, checked: smartShown, onSelect: () => setSmartHidden(smartShown) },
  ];
  // Set by the moves themselves; the one kept from the last session is read when the window is idle
  // (not during the start), so the menu opens at once with the right label.
  const lastMove = useLastMove((st) => st.last) ?? null;
  useEffect(() => {
    const timer = setTimeout(loadLastMove, 2000);
    return () => clearTimeout(timer);
  }, []);
  const openTreeMenu = (e: React.MouseEvent<HTMLButtonElement>) => openTreeMenuAt(e, treeMenuItems(lastMove));
  const [newMenu, , openNewMenuAt] = useMenu();
  const allCollapsed = withChildren.length > 0 && withChildren.every((id) => !treeOpen.open.has(id));
  const empty = tree.length === 0;

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
            id={`side-tab-${st.id}`}
            aria-controls="sidebar-body"
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

      {/* The shown tab's content (files, search, favorites, tags). */}
      <div className="sidebar-body" id="sidebar-body" role="tabpanel" aria-labelledby={`side-tab-${tab}`}>
      {tab === "files" && (
        <>
          <div className="side-toolbar">
            <span className="side-title">{t("sidebar.files")}</span>
            <IconButton icon={FilePlus2} label={withHint(t("sidebar.newPage"), "new_page")} size="md" onClick={() => createSubpage(null)} />
            <IconButton
              icon={ChevronDown}
              label={t("new.menu")}
              size="md"
              aria-haspopup="menu"
              data-new-menu
              className="side-new-menu"
              onClick={(e) => openNewMenuAt(e, newMenuItems(undefined))}
            />
            {newMenu}
            {/* Nothing to collapse or sort in an empty workspace (during the first start, too). */}
            {!empty && (
              <>
                <IconButton
                  icon={allCollapsed ? ChevronsUpDown : ChevronsDownUp}
                  label={allCollapsed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
                  size="md"
                  onClick={() => treeOpen.setAll(allCollapsed ? withChildren : [])}
                />
                <IconButton aria-haspopup="menu" icon={SlidersHorizontal} label={t("fl.treeMenu")} size="md" className="tree-options" onClick={openTreeMenu} />
              </>
            )}
            {treeMenu}
          </div>
          {!empty && (
            <div className="tree-filter">
              <Search size={13} aria-hidden />
              <input
                value={filter}
                placeholder={t("fl.filter")}
                aria-label={t("fl.filter")}
                aria-description={t("fl.filterHint")}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (isComposing(e)) return;
                  if (e.key === "Escape" && filter) (e.preventDefault(), e.stopPropagation(), setFilter(""));
                  else if (e.key === "ArrowDown") (e.preventDefault(), document.querySelector<HTMLElement>(".sidebar .tree .tree-row")?.focus());
                  else if (e.key === "Enter" && filter.trim()) {
                    e.preventDefault();
                    treeHandle.current?.openFirstHit({ newTab: e.ctrlKey || e.metaKey, split: e.altKey });
                  }
                }}
              />
              {filter && <IconButton icon={X} label={t("fl.filterClear")} size="sm" onClick={() => setFilter("")} />}
            </div>
          )}
          <div className="sidebar-scroll sidebar-files">
            {!empty && !filter && <SmartFolders />}
            {empty ? (
              // During onboarding the welcome choice explains the empty workspace.
              !onboarding && <div className="side-empty">
                {t("sidebar.noPages")}
                <Button size="sm" icon={FilePlus2} onClick={() => createSubpage(null)}>
                  {t("sidebar.newPage")}
                </Button>
              </div>
            ) : (
              <PageTree
                nodes={tree}
                activePageId={activePageId}
                elsewhere={elsewhere}
                tree={treeOpen}
                filter={filter}
                rootStyle={rootStyle}
                selectionSlot={selectionSlot}
                handle={treeHandle}
              />
            )}
          </div>
          <div className="tree-selection-slot" ref={setSelectionSlot} />
        </>
      )}
      {tab === "search" && <SearchPane />}
      {tab === "bookmarks" && <Bookmarks activePageId={active?.kind === "page" ? active.pageId : undefined} />}
      {tab === "tags" && <TagsPane activeTag={active?.kind === "tag" ? active.tag : undefined} />}
      </div>

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
  const { hits, meaning, answered } = useMeaningSearch(q, 60, { enabled: q.trim().length >= 2, exact: exactOnly, delay: 120 });
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
            if (isComposing(e)) return;
            if (e.key === "Enter") {
              const newTab = e.ctrlKey || e.metaKey;
              // The hits shown may still be those of the text before the last keystroke: then
              // the first hit of what is typed now.
              if (answered === q) {
                const first = [...byPage.keys()][0];
                if (first) s().openPage(first, { newTab });
              } else if (q.trim().length >= 2) {
                const typed = q;
                void api.search(typed, 5).then((h) => {
                  const first = h.find((x) => x.kind === "note" || x.kind === "similar");
                  if (first && (first.kind === "note" || first.kind === "similar")) s().openPage(first.page_id, { newTab });
                }, () => {});
              }
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
  const tabStop = favorites.some((p) => p.id === activePageId) ? activePageId : favorites[0]?.id;
  return (
    <div className="side-pane">
      <div className="side-toolbar">
        <span className="side-title">{t("sidebar.bookmarks")}</span>
      </div>
      <div className="sidebar-scroll">
        {favorites.length === 0 && <div className="side-empty faint">{t("sidebar.bookmarksEmpty")}</div>}
        {favorites.length > 0 && (
          <div className="tree" role="tree" aria-label={t("sidebar.bookmarks")} onKeyDown={treeKeyDown}>
            {favorites.map((p, i) => (
              <div
                key={p.id}
                role="treeitem"
                aria-level={1}
                aria-setsize={favorites.length}
                aria-posinset={i + 1}
                aria-current={activePageId === p.id ? "page" : undefined}
                tabIndex={tabStop === p.id ? 0 : -1}
                className={`tree-row ${activePageId === p.id ? "active" : ""}`}
                onMouseEnter={titleIfCut}
                onFocus={(e) => focusItem([...(e.currentTarget.parentElement?.children ?? [])] as HTMLElement[], e.currentTarget)}
                onClick={(e) => s().openPage(p.id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey })}
              >
                <span className="tree-twisty leaf" />
                <PageIcon name={p.icon} size={15} className="tree-icon" />
                <span className="tree-label">{p.title}</span>
              </div>
            ))}
          </div>
        )}
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
  const tabStop = tags.some(([tag]) => tag === activeTag) ? activeTag : tags[0]?.[0];
  return (
    <div className="side-pane">
      <div className="side-toolbar">
        <span className="side-title">{t("sidebar.tags")}</span>
      </div>
      <div className="sidebar-scroll">
        {tags.length === 0 && <div className="side-empty faint">{t("sidebar.tagsEmpty")}</div>}
        {tags.length > 0 && (
          <div className="tree" role="tree" aria-label={t("sidebar.tags")} onKeyDown={treeKeyDown}>
            {tags.map(([tag, n], i) => (
              <div
                key={tag}
                role="treeitem"
                aria-level={1}
                aria-setsize={tags.length}
                aria-posinset={i + 1}
                aria-current={activeTag === tag ? "page" : undefined}
                tabIndex={tabStop === tag ? 0 : -1}
                className={`tree-row ${activeTag === tag ? "active" : ""}`}
                onMouseEnter={titleIfCut}
                onFocus={(e) => focusItem([...(e.currentTarget.parentElement?.children ?? [])] as HTMLElement[], e.currentTarget)}
                onClick={() => s().openTab({ kind: "tag", tag })}
              >
                <span className="tree-twisty leaf" />
                <Hash size={14} className="tree-icon" />
                <span className="tree-label">{tag}</span>
                <span className="tree-count">{n}</span>
              </div>
            ))}
          </div>
        )}
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

// ------------------------------------------------------------- timer dock

// One second tick for every timer display: a single interval for all of them, none while no running timer is
// shown or the window is hidden (on return it ticks at once).
const tickers = new Set<() => void>();
let tickId: ReturnType<typeof setInterval> | null = null;
let tickWatch = false;
function syncTicker() {
  const want = tickers.size > 0 && document.visibilityState !== "hidden";
  if (want && tickId == null) {
    tickId = setInterval(() => tickers.forEach((f) => f()), 1000);
    tickers.forEach((f) => f());
  } else if (!want && tickId != null) {
    clearInterval(tickId);
    tickId = null;
  }
}
/** Calls `f` once a second while the window is visible; returns the unsubscribe. */
export function onSecondTick(f: () => void): () => void {
  if (!tickWatch) {
    tickWatch = true;
    document.addEventListener("visibilitychange", syncTicker);
  }
  tickers.add(f);
  syncTicker();
  return () => {
    tickers.delete(f);
    syncTicker();
  };
}
/** Whether the shared second tick runs (tests). */
export const secondTickRunning = () => tickId != null;

export function useTimerSeconds() {
  const timer = useApp((s) => s.timer);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!timer) return;
    setNow(Date.now());
    // Paused: the clock stands still.
    if (timer.paused_since) return;
    return onSecondTick(() => setNow(Date.now()));
  }, [timer]);
  return timer ? timerSeconds(timer, now) : 0;
}

/** The running timer as „01:23:45“. Only this text re-renders each second, not the panel around it. */
export function TimerClock() {
  return <>{clock(useTimerSeconds())}</>;
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
  // A timer left running stays in the data, but is not shown while time tracking is off.
  const timeOn = useTimeTracking();
  if (!timer || !timeOn) return null;
  const e = timer.entry;
  const paused = !!timer.paused_since;
  return (
    <div className={`timer-dock${paused ? " paused" : ""}`} role="status">
      <span className={paused ? "pause-dot" : "rec-dot"} aria-hidden />
      <button type="button" className="timer-dock-main" onClick={() => useApp.getState().openTab({ kind: "timesheet" })}>
        <span className="timer-dock-time num">
          <TimerClock />
        </span>
        <span className="timer-dock-label">{paused ? t("timer.paused") : e.description || e.vorgang_nr || t("dash.w.timer")}</span>
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
    if (out.clock_back)
      s.toast({
        tone: "warning",
        persistent: true,
        title: tStatic("timer.clockBackTitle"),
        detail: tStatic("timer.clockBackDetail"),
        action: { label: tStatic("timer.clockBackOpen"), run: () => useApp.getState().openTab({ kind: "timesheet" }) },
      });
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
