// The editor area: one or more panes side by side, each with its own tabs.

import { Activity, Fragment, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowRightLeft, ChevronDown, Columns2, Copy, House, MinusCircle, PanelRight, Pin, PinOff, Plus, Timer, X } from "lucide-react";
import { useApp, savePref, type Pane, type Tab } from "../store/app";
import { Button, EmptyState, IconButton, useMenu, type MenuEntry } from "./ui";
import { TIME_TABS, useTimeTracking } from "../lib/timetracking";
import { AI_TABS, useAi } from "../lib/aiswitch";
import { openSettingsSection } from "../lib/calnav";
import { Home, TabIcon, tabTitle } from "./Shell";
import { Resizer } from "./Resizer";
import { ViewHeader } from "./ViewHeader";
import { PageView } from "../views/PageView";
import { TrashView } from "../views/TrashView";
import { ConflictView } from "../views/ConflictView";
import { storeFile } from "../lib/api";
import { isPdfName } from "../editor/fileEmbed";
import { lazyView, preloadWhenIdle } from "./lazyView";
import { t, useT } from "../lib/i18n";
import { hint, withHint } from "../lib/keymap";
import { keepAlive, type Kept } from "../lib/keepalive";
import { isComposing } from "../lib/ime";

// Views other than pages load when first opened (a smaller script at start), or in the
// background once the app is idle.
const TimesheetView = lazyView(() => import("../views/TimesheetView").then((m) => m.TimesheetView));
const ProjectsView = lazyView(() => import("../views/ProjectsView").then((m) => m.ProjectsView));
const SettingsView = lazyView(() => import("../views/SettingsView").then((m) => m.SettingsView));
const TagView = lazyView<{ tag: string }>(() => import("../views/TagView").then((m) => m.TagView));
const TasksView = lazyView(() => import("../views/TasksView").then((m) => m.TasksView));
const ActivityView = lazyView(() => import("../views/ActivityView").then((m) => m.ActivityView));
const AttachmentsView = lazyView(() => import("../views/AttachmentsView").then((m) => m.AttachmentsView));
const CalendarView = lazyView(() => import("../views/CalendarView").then((m) => m.CalendarView));
const DayReviewView = lazyView(() => import("../views/DayReviewView").then((m) => m.DayReviewView));
const WeekReviewView = lazyView(() => import("../views/WeekReviewView").then((m) => m.WeekReviewView));
const IssuesView = lazyView(() => import("../views/IssuesView").then((m) => m.IssuesView));
const GraphView = lazyView(() => import("../views/GraphView").then((m) => m.GraphView));
const CanvasView = lazyView<{ pageId: number; tab: Tab; active: boolean }>(() => import("../views/canvas/CanvasView").then((m) => m.CanvasView));
const BriefingView = lazyView(() => import("../views/BriefingView").then((m) => m.BriefingView));
const ChatView = lazyView<{ tab: Tab }>(() => import("../views/ChatView").then((m) => m.ChatView));
const LAZY_VIEWS = [SettingsView, TasksView, TimesheetView, ProjectsView, ActivityView, TagView, AttachmentsView, CalendarView, DayReviewView, WeekReviewView, BriefingView, ChatView];

// The PDF viewer (with pdf.js) loads when a PDF tab is shown.
const PdfPane = lazy(() => import("../editor/PdfViewer").then((m) => ({ default: m.PdfPane })));

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

/**
 * Files dropped on the tab bar, or on a pane without a note: PDFs are stored as attachments and
 * open in a viewer tab of that pane. Other files belong into a note.
 */
async function openDroppedFiles(files: File[], paneId: string) {
  const s = useApp.getState();
  const pdfs = files.filter((f) => isPdfName(f.name));
  if (pdfs.length < files.length)
    s.toast({ tone: "info", title: t("ws.onlyPdf"), detail: t("ws.onlyPdfDetail") });
  for (const file of pdfs) {
    try {
      const saved = await storeFile(file);
      s.focusPane(paneId);
      s.openTab({ kind: "pdf", tag: saved.name }, { newTab: true });
    } catch (e) {
      s.error(t("ws.openFailed", { name: file.name }), e);
    }
  }
}

const MIN_PANE = 280;

export function Workspace() {
  useT();
  const panes = useApp((s) => s.panes);
  const sizes = useApp((s) => s.paneSizes);
  const activePaneId = useApp((s) => s.activePaneId);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<number[] | null>(null);
  useEffect(() => preloadWhenIdle(LAZY_VIEWS), []);

  const resize = (i: number, dx: number) => {
    const width = box.current?.clientWidth ?? 1;
    const start = (drag.current ??= [...sizes]);
    const pair = start[i - 1] + start[i];
    const min = Math.min(MIN_PANE / width, pair / 2);
    const left = Math.max(min, Math.min(pair - min, start[i - 1] + dx / width));
    const next = [...start];
    next[i - 1] = left;
    next[i] = pair - left;
    useApp.getState().setPaneSizes(next);
  };

  return (
    <div className="workspace" ref={box}>
      {panes.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && (
            <Resizer
              label={t("ws.paneWidth")}
              value={(sizes[i - 1] ?? 0) * 100}
              min={0}
              max={100}
              className="pane-resizer"
              onResize={(dx) => resize(i, dx)}
              onEnd={() => (drag.current = null)}
              onReset={() => useApp.getState().setPaneSizes(panes.map(() => 1 / panes.length))}
            />
          )}
          <PaneView pane={p} size={sizes[i] ?? 1} active={p.id === activePaneId} last={i === panes.length - 1} multi={panes.length > 1} />
        </Fragment>
      ))}
    </div>
  );
}

function PaneView({ pane, size, active, last, multi }: { pane: Pane; size: number; active: boolean; last: boolean; multi: boolean }) {
  useT();
  const tab = pane.tabs.find((x) => x.id === pane.activeTabId) ?? null;
  const s = useApp.getState;
  // Switching tabs (or going back and forth in one) keeps the recent places mounted.
  const keptRef = useRef<Kept[]>([]);
  const kept = (keptRef.current = keepAlive(
    keptRef.current,
    tab,
    pane.tabs.map((x) => x.id),
  ));
  const shownKey = kept[0].key;
  // A tab dragged from another pane can be dropped onto this pane's content.
  const [dropHere, setDropHere] = useState(false);
  const [fileDrop, setFileDrop] = useState(false);
  const foreignTab = (e: DragEvent) => e.dataTransfer.types.includes(TAB_MIME) && !pane.tabs.some((t) => t.id === draggedTab);
  // Files open in a tab when they land on the tab bar or on a pane without a note (a note's
  // editor embeds them itself).
  const fileTarget = (e: DragEvent) => hasFiles(e) && (!!(e.target as HTMLElement).closest(".tabbar") || tab?.kind !== "page");
  return (
    <section
      className={`pane ${active ? "active" : ""} ${multi ? "multi" : ""} ${dropHere ? "tab-drop" : ""} ${fileDrop ? "file-drop" : ""}`}
      onDragOver={(e) => {
        if (fileTarget(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setFileDrop(true);
          return;
        }
        if (fileDrop) setFileDrop(false);
        if (!foreignTab(e) || (e.target as HTMLElement).closest(".tabbar")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropHere(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && (setDropHere(false), setFileDrop(false))}
      onDrop={(e) => {
        setDropHere(false);
        setFileDrop(false);
        if (fileTarget(e) && !e.defaultPrevented) {
          e.preventDefault();
          void openDroppedFiles([...e.dataTransfer.files], pane.id);
          return;
        }
        const id = e.dataTransfer.getData(TAB_MIME);
        if (!id || (e.target as HTMLElement).closest(".tabbar")) return;
        e.preventDefault();
        s().moveTab(id, pane.id, pane.tabs.length);
      }}
      style={{ flexGrow: size, flexBasis: 0 }}
      onMouseDownCapture={() => s().focusPane(pane.id)}
      onFocusCapture={() => s().focusPane(pane.id)}
      aria-label={t("ws.pane")}
    >
      <PaneTabs pane={pane} last={last} />
      {kept.map((k) => {
        const shown = k.key === shownKey;
        const content = k.tab ? <TabContent tab={k.tab} active={active && shown} /> : <Home />;
        return (
          <KeptContent key={k.key} shown={shown} tabId={shown ? k.tab?.id : undefined}>
            {/* A page keeps its editor running while hidden (like one in another pane, it is
                just not the active one): undo history, caret and scroll stay. Other views keep
                their state but pause their effects (window keys, polling) while hidden. */}
            {!k.tab || k.tab.kind === "page" ? content : <Activity mode={shown ? "visible" : "hidden"}>{content}</Activity>}
          </KeptContent>
        );
      })}
    </section>
  );
}

/**
 * One kept place: hidden when another one is shown. Scroll offsets inside are put back when it
 * shows again (a hidden box loses them in some engines).
 */
function KeptContent({ shown, tabId, children }: { shown: boolean; tabId?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const offsets = useRef(new Map<Element, [number, number]>());
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = (e: Event) => shownRef.current && e.target instanceof Element && offsets.current.set(e.target, [e.target.scrollTop, e.target.scrollLeft]);
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => el.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  useLayoutEffect(() => {
    if (!shown) return;
    for (const [el, [top, left]] of offsets.current) {
      if (!el.isConnected || !box.current?.contains(el)) offsets.current.delete(el);
      else if (el.scrollTop !== top || el.scrollLeft !== left) el.scrollTo({ top, left, behavior: "instant" });
    }
  }, [shown]);
  return (
    <div
      ref={box}
      className="pane-content"
      hidden={!shown}
      role="tabpanel"
      id={tabId ? `tabpanel-${tabId}` : undefined}
      aria-labelledby={tabId ? `tab-${tabId}` : undefined}
    >
      {children}
    </div>
  );
}

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  const tr = useT();
  const timeOn = useTimeTracking();
  const ai = useAi();
  // A chat tab left open when „KI verwenden“ was switched off.
  if (!ai && AI_TABS.has(tab.kind))
    return (
      <>
        <ViewHeader tab={tab} title="" />
        <div className="view-body">
          <EmptyState
            icon={MinusCircle}
            title={tr("noai.offTitle")}
            action={
              useApp.getState().settings?.ai_policy_off ? undefined : (
                <Button size="sm" onClick={() => openSettingsSection("ai")}>
                  {tr("noai.openSettings")}
                </Button>
              )
            }
          >
            {tr(useApp.getState().settings?.ai_policy_off ? "noai.policyText" : "noai.offText")}
          </EmptyState>
        </div>
      </>
    );
  // A timesheet or projects tab left open when time tracking was switched off.
  if (!timeOn && TIME_TABS.has(tab.kind))
    return (
      <>
        <ViewHeader tab={tab} title="" />
        <div className="view-body">
          <EmptyState
            icon={Timer}
            title={tr("tt.offTitle")}
            action={
              <Button size="sm" onClick={() => useApp.getState().openTab({ kind: "settings" })}>
                {tr("tt.openSettings")}
              </Button>
            }
          >
            {tr("tt.offText")}
          </EmptyState>
        </div>
      </>
    );
  switch (tab.kind) {
    case "page":
      return <PageOrCanvas pageId={tab.pageId!} tab={tab} active={active} />;
    case "home":
      return (
        <>
          <ViewHeader tab={tab} title="" />
          <Home />
        </>
      );
    case "activity":
      return (
        <>
          <ViewHeader tab={tab} title="" />
          <div className="view-body">
            <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
              <ActivityView />
            </Suspense>
          </div>
        </>
      );
    case "chat":
      return (
        <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
          <ChatView tab={tab} />
        </Suspense>
      );
    case "pdf":
      return (
        <Suspense fallback={<div className="pdf-message pdf-tab-loading">{t("ws.pdfLoading")}</div>}>
          <PdfPane key={tab.tag} name={tab.tag!} onClose={() => useApp.getState().closeTab(tab.id)} />
        </Suspense>
      );
    default:
      return (
        <>
          {/* These views open with their own heading; the tab names them too. Settings carry
              back and forward in their own bar above the section, beside the menu. */}
          {tab.kind !== "settings" && <ViewHeader tab={tab} title="" />}
          <div className="view-body">
            <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
            {tab.kind === "timesheet" && <TimesheetView />}
            {tab.kind === "projects" && <ProjectsView />}
            {tab.kind === "settings" && <SettingsView tab={tab} />}
            {tab.kind === "tag" && <TagView tag={tab.tag!} />}
            {tab.kind === "trash" && <TrashView />}
            {tab.kind === "tasks" && <TasksView />}
            {tab.kind === "attachments" && <AttachmentsView />}
            {tab.kind === "calendar" && <CalendarView />}
            {tab.kind === "review" && <DayReviewView />}
            {tab.kind === "weekreview" && <WeekReviewView />}
            {tab.kind === "briefing" && <BriefingView />}
            {tab.kind === "issues" && <IssuesView />}
            {tab.kind === "graph" && <GraphView />}
            {tab.kind === "conflict" && <ConflictView pageId={tab.pageId!} />}
            </Suspense>
          </div>
        </>
      );
  }
}

const TAB_MIME = "application/x-arcalo-tab";
/** The tab being dragged (dataTransfer content is not readable during dragover). */
let draggedTab: string | null = null;

const titleBarInTabs = () => document.documentElement.matches(".os-macos, .frame-custom");

function PaneTabs({ pane, last }: { pane: Pane; last: boolean }) {
  const tr = useT();
  const pages = useApp((s) => s.pages);
  const panelOpen = useApp((s) => s.panelOpen);
  const paneCount = useApp((s) => s.panes.length);
  const [menu, openMenu, openMenuAt] = useMenu();
  const [dropAt, setDropAt] = useState<number | null>(null);
  const s = useApp.getState;

  // Over a tab its right half means "after it". Worked out from the event itself on drop too:
  // the marker state may not have caught up with the last dragover yet.
  const slot = (e: DragEvent, index: number, overTab: boolean) => {
    if (!overTab) return index;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX > r.left + r.width / 2 ? index + 1 : index;
  };
  const onDragOver = (e: DragEvent, index: number, overTab = false) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropAt(slot(e, index, overTab));
  };
  const onDrop = (e: DragEvent, at: number, overTab = false) => {
    const index = slot(e, at, overTab);
    const id = e.dataTransfer.getData(TAB_MIME);
    setDropAt(null);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    s().moveTab(id, pane.id, index);
  };

  const panes = useApp((st) => st.panes);
  const tabMenu = (t: Tab): MenuEntry[] => {
    const i = pane.tabs.findIndex((x) => x.id === t.id);
    const others = panes.filter((p) => p.id !== pane.id);
    return [
      { label: tr("tabs.openRight"), icon: Columns2, disabled: paneCount >= 3 && last, onSelect: () => s().splitTab(t.id) },
      ...others.map((p, n): MenuEntry => ({
        label: others.length > 1 ? `${tr("tabs.moveToPane")} ${n + 1}` : tr("tabs.moveToOther"),
        icon: ArrowRightLeft,
        onSelect: () => s().moveTab(t.id, p.id, p.tabs.length),
      })),
      { label: tr("tabs.duplicate"), icon: Copy, onSelect: () => s().duplicateTab(t.id) },
      { label: t.pinned ? tr("tabs.unpin") : tr("tabs.pin"), icon: t.pinned ? PinOff : Pin, shortcut: hint("pin_tab") || undefined, onSelect: () => s().togglePin(t.id) },
      "separator",
      // Moving stays inside the tab's group (pinned or not).
      { label: tr("tabs.moveLeft"), icon: ArrowLeft, disabled: i <= 0 || !!pane.tabs[i - 1].pinned !== !!t.pinned, onSelect: () => s().moveTab(t.id, pane.id, i - 1) },
      { label: tr("tabs.moveRight"), icon: ArrowRight, disabled: i >= pane.tabs.length - 1 || !!pane.tabs[i + 1].pinned !== !!t.pinned, onSelect: () => s().moveTab(t.id, pane.id, i + 2) },
      "separator",
      { label: tr("tabs.close"), icon: X, onSelect: () => s().closeTab(t.id) },
      // Pinned tabs stay: „Andere“, „rechts“ and „Alle“ close only the unpinned ones.
      { label: tr("tabs.closeOthers"), onSelect: () => s().closeOthers(t.id), disabled: !pane.tabs.some((x) => x.id !== t.id && !x.pinned) },
      { label: tr("tabs.closeRight"), onSelect: () => pane.tabs.slice(i + 1).forEach((x) => !x.pinned && s().closeTab(x.id)), disabled: !pane.tabs.slice(i + 1).some((x) => !x.pinned) },
      { label: tr("tabs.closeAll"), onSelect: () => s().closeAll(pane.id), disabled: !pane.tabs.some((x) => !x.pinned) },
    ];
  };
  // The active tab stays in view when there are more tabs than room.
  const tabsRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    // Fades at the edges that have hidden tabs; the list button when not all fit.
    const edges = () => {
      el.classList.toggle("fade-left", el.scrollLeft > 1);
      el.classList.toggle("fade-right", el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    const fit = () => {
      el.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
      setOverflow(el.scrollWidth > el.clientWidth + 1);
      edges();
    };
    fit();
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    ro.observe(el);
    el.addEventListener("scroll", edges, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      el.removeEventListener("scroll", edges);
    };
  }, [pane.activeTabId, pane.tabs.length]);
  const pinnedCount = pane.tabs.filter((t) => t.pinned).length;
  const allTabs = (): MenuEntry[] =>
    pane.tabs.map((t) => ({ label: tabTitle(t, pages), checked: t.id === pane.activeTabId, onSelect: () => s().activateTab(t.id) }));

  return (
    <div
      className="tabbar"
      data-tauri-drag-region
      onDragOver={(e) => onDragOver(e, pane.tabs.length)}
      // Leaving for a child (a tab) is not leaving the bar: no flicker of the marker.
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropAt(null)}
      onDrop={(e) => onDrop(e, pane.tabs.length)}
      // Where the tab bar is the title bar (macOS, own title bar on Windows) a double-click maximizes.
      onDoubleClick={(e) => e.target === e.currentTarget && !titleBarInTabs() && s().openTab({ kind: "home" }, { newTab: true })}
    >
      {/* The start page of this pane: its tab if one is open, otherwise a new one. */}
      <IconButton
        className="tabbar-home"
        icon={House}
        label={tr("tabs.goHome")}
        size={26}
        iconSize={15}
        active={pane.tabs.find((x) => x.id === pane.activeTabId)?.kind === "home"}
        onClick={() => {
          s().focusPane(pane.id);
          s().openTab({ kind: "home" }, { newTab: true });
        }}
      />
      <div
        className="tabs"
        role="tablist"
        aria-label={tr("tabs.openTabs")}
        data-tauri-drag-region
        ref={tabsRef}
        // Pinned tabs take only their compact width; the others share the rest as before.
        style={pinnedCount ? { gridTemplateColumns: `repeat(${pinnedCount}, max-content)` } : undefined}
        // The mouse wheel scrolls the tab row sideways.
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {pane.tabs.map((t, i) => {
          const title = tabTitle(t, pages);
          const selected = t.id === pane.activeTabId;
          return (
            <div
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-controls={selected ? `tabpanel-${t.id}` : undefined}
              aria-selected={selected}
              className={`tab ${selected ? "active" : ""} ${t.pinned ? "pinned" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === pane.tabs.length && i === pane.tabs.length - 1 ? "drop-after" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, t.id);
                e.dataTransfer.effectAllowed = "move";
                draggedTab = t.id;
              }}
              onDragEnd={() => {
                setDropAt(null);
                draggedTab = null;
              }}
              onDragOver={(e) => onDragOver(e, i, true)}
              onDrop={(e) => onDrop(e, i, true)}
              onMouseDown={(e) => e.button === 0 && s().activateTab(t.id)}
              // A pinned tab is not closed by a stray middle click (Delete, Ctrl+W and the menu do).
              onAuxClick={(e) => e.button === 1 && !t.pinned && s().closeTab(t.id)}
              onContextMenu={(e) => openMenu(e, tabMenu(t))}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(e) => {
                if (isComposing(e)) return;
                if (menu || e.target !== e.currentTarget) return;
                const sibling = (d: number) => {
                  const all = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".tab") ?? [])];
                  all[(all.indexOf(e.currentTarget) + d + all.length) % all.length]?.focus();
                };
                if (e.key === "Enter" || e.key === " ") (e.preventDefault(), s().activateTab(t.id));
                else if (e.key === "ArrowRight") (e.preventDefault(), sibling(1));
                else if (e.key === "ArrowLeft") (e.preventDefault(), sibling(-1));
                else if (e.key === "Home") (e.preventDefault(), (e.currentTarget.parentElement?.querySelector<HTMLElement>(".tab") ?? null)?.focus());
                else if (e.key === "End") (e.preventDefault(), [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".tab") ?? [])].at(-1)?.focus());
                else if (e.key === "Delete") (e.preventDefault(), s().closeTab(t.id));
                else if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
                  openMenuAt(e, tabMenu(t));
                }
              }}
              title={t.pinned ? tr("tabs.pinnedLabel", { title }) : title}
              aria-label={t.pinned ? tr("tabs.pinnedLabel", { title }) : title}
            >
              <span className="tab-icon">
                <TabIcon t={t} />
              </span>
              <span className="tab-title">{title}</span>
              {t.pinned ? (
                // The pin instead of the close button; a click unpins (as in Obsidian).
                <button
                  type="button"
                  className="tab-pin"
                  aria-label={tr("tabs.unpin")}
                  title={tr("tabs.unpin")}
                  tabIndex={-1}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => s().togglePin(t.id)}
                >
                  <Pin size={11} strokeWidth={2} />
                </button>
              ) : (
                <button
                  type="button"
                  className="tab-close"
                  aria-label={tr("tabs.closeTab")}
                  // Not a Tab stop of its own: Delete closes the focused tab, the menu offers it too.
                  tabIndex={-1}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => s().closeTab(t.id)}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {overflow && (
        <IconButton
          icon={ChevronDown}
          label={tr("tabs.all")}
          size={26}
          iconSize={15}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu({ clientX: r.left, clientY: r.bottom + 4 }, allTabs());
          }}
        />
      )}
      <IconButton icon={Plus} label={withHint(tr("tabs.newTab"), "new_tab")} size={26} iconSize={15} onClick={() => s().openTab({ kind: "home" }, { newTab: true })} />
      <span className="tabbar-drag" data-tauri-drag-region />
      {pane.tabs.length > 0 && (
        <IconButton
          icon={Columns2}
          label={tr("tabs.split")}
          size={26}
          iconSize={15}
          disabled={paneCount >= 3 && last}
          onClick={() => s().splitTab(pane.activeTabId)}
        />
      )}
      {last && (
        <IconButton
          icon={PanelRight}
          label={withHint(tr("tabs.panel"), "toggle_panel")}
          active={panelOpen}
          size={26}
          iconSize={15}
          onClick={() => {
            s().set({ panelOpen: !panelOpen });
            savePref("arcalo.panel", !panelOpen);
          }}
        />
      )}
      {menu}
    </div>
  );
}

/** A page tab: the editor, or the board of a canvas page. */
function PageOrCanvas({ pageId, tab, active }: { pageId: number; tab: Tab; active: boolean }) {
  const kind = useApp((s) => (s.pages.has(pageId) ? (s.pages.get(pageId)?.kind ?? "note") : null));
  // A page created elsewhere (an import, the sync) is not in the tree yet: load it before choosing.
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (kind != null) return;
    let alive = true;
    useApp.getState().refreshTree().finally(() => alive && setChecked(true));
    return () => {
      alive = false;
    };
  }, [kind, pageId]);
  if (kind == null && !checked) return null;
  return kind === "canvas" ? <CanvasView pageId={pageId} tab={tab} active={active} /> : <PageView pageId={pageId} tab={tab} active={active} />;
}
