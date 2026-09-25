// The editor area: one or more panes side by side, each with its own tabs.

import { Fragment, lazy, Suspense, useEffect, useRef, useState, type DragEvent } from "react";
import { ArrowLeft, ArrowRight, ArrowRightLeft, ChevronDown, Columns2, Copy, PanelRight, Plus, X } from "lucide-react";
import { useApp, savePref, type Pane, type Tab } from "../store/app";
import { IconButton, useMenu, type MenuEntry } from "./ui";
import { Home, TabIcon, tabTitle } from "./Shell";
import { Resizer } from "./Resizer";
import { ViewHeader } from "./ViewHeader";
import { PageView } from "../views/PageView";
import { TrashView } from "../views/TrashView";
import { ConflictView } from "../views/ConflictView";
import { storeFile } from "../lib/api";
import { isPdfName } from "../editor/fileEmbed";
import { lazyView, preloadWhenIdle } from "./lazyView";

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
const LAZY_VIEWS = [SettingsView, TasksView, TimesheetView, ProjectsView, ActivityView, TagView, AttachmentsView, CalendarView, DayReviewView];

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
    s.toast({ tone: "info", title: "Nur PDFs öffnen sich im Tab", detail: "Andere Dateien in eine Notiz ziehen, um sie dort einzufügen." });
  for (const file of pdfs) {
    try {
      const saved = await storeFile(file);
      s.focusPane(paneId);
      s.openTab({ kind: "pdf", tag: saved.name }, { newTab: true });
    } catch (e) {
      s.error(`„${file.name}“ ließ sich nicht öffnen`, e);
    }
  }
}
import { useT } from "../lib/i18n";
import { withHint } from "../lib/keymap";

const MIN_PANE = 280;

export function Workspace() {
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
              label="Bereichsbreite"
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
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
  const s = useApp.getState;
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
      aria-label="Bereich"
    >
      <PaneTabs pane={pane} last={last} />
      <div className="pane-content" key={tab ? `${tab.id}:${tab.kind}:${tab.pageId ?? tab.tag ?? ""}` : "home"}>
        {!tab && <Home />}
        {tab && <TabContent tab={tab} active={active} />}
      </div>
    </section>
  );
}

function TabContent({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case "page":
      return <PageView pageId={tab.pageId!} tab={tab} active={active} />;
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
    case "pdf":
      return (
        <Suspense fallback={<div className="pdf-message pdf-tab-loading">PDF wird geladen…</div>}>
          <PdfPane key={tab.tag} name={tab.tag!} onClose={() => useApp.getState().closeTab(tab.id)} />
        </Suspense>
      );
    default:
      return (
        <>
          {/* These views open with their own heading; the tab names them too. */}
          <ViewHeader tab={tab} title="" />
          <div className="view-body">
            <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
            {tab.kind === "timesheet" && <TimesheetView />}
            {tab.kind === "projects" && <ProjectsView />}
            {tab.kind === "settings" && <SettingsView />}
            {tab.kind === "tag" && <TagView tag={tab.tag!} />}
            {tab.kind === "trash" && <TrashView />}
            {tab.kind === "tasks" && <TasksView />}
            {tab.kind === "attachments" && <AttachmentsView />}
            {tab.kind === "calendar" && <CalendarView />}
            {tab.kind === "review" && <DayReviewView />}
            {tab.kind === "conflict" && <ConflictView pageId={tab.pageId!} />}
            </Suspense>
          </div>
        </>
      );
  }
}

const TAB_MIME = "application/x-annalo-tab";
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
      "separator",
      { label: tr("tabs.moveLeft"), icon: ArrowLeft, disabled: i <= 0, onSelect: () => s().moveTab(t.id, pane.id, i - 1) },
      { label: tr("tabs.moveRight"), icon: ArrowRight, disabled: i >= pane.tabs.length - 1, onSelect: () => s().moveTab(t.id, pane.id, i + 2) },
      "separator",
      { label: tr("tabs.close"), icon: X, onSelect: () => s().closeTab(t.id) },
      { label: tr("tabs.closeOthers"), onSelect: () => s().closeOthers(t.id), disabled: pane.tabs.length < 2 },
      { label: tr("tabs.closeRight"), onSelect: () => pane.tabs.slice(i + 1).forEach((x) => s().closeTab(x.id)), disabled: i >= pane.tabs.length - 1 },
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
  const allTabs = (): MenuEntry[] =>
    pane.tabs.map((t) => ({ label: tabTitle(t, pages), checked: t.id === pane.activeTabId, onSelect: () => s().activateTab(t.id) }));

  return (
    <div
      className="tabbar"
      role="tablist"
      data-tauri-drag-region
      onDragOver={(e) => onDragOver(e, pane.tabs.length)}
      // Leaving for a child (a tab) is not leaving the bar: no flicker of the marker.
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDropAt(null)}
      onDrop={(e) => onDrop(e, pane.tabs.length)}
      // Where the tab bar is the title bar (macOS, own title bar on Windows) a double-click maximizes.
      onDoubleClick={(e) => e.target === e.currentTarget && !titleBarInTabs() && s().openTab({ kind: "home" }, { newTab: true })}
    >
      <div
        className="tabs"
        data-tauri-drag-region
        ref={tabsRef}
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
              aria-selected={selected}
              className={`tab ${selected ? "active" : ""} ${dropAt === i ? "drop-before" : ""} ${dropAt === pane.tabs.length && i === pane.tabs.length - 1 ? "drop-after" : ""}`}
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
              onAuxClick={(e) => e.button === 1 && s().closeTab(t.id)}
              onContextMenu={(e) => openMenu(e, tabMenu(t))}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(e) => {
                if (menu || e.target !== e.currentTarget) return;
                const sibling = (d: number) => {
                  const all = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".tab") ?? [])];
                  all[(all.indexOf(e.currentTarget) + d + all.length) % all.length]?.focus();
                };
                if (e.key === "Enter" || e.key === " ") (e.preventDefault(), s().activateTab(t.id));
                else if (e.key === "ArrowRight") (e.preventDefault(), sibling(1));
                else if (e.key === "ArrowLeft") (e.preventDefault(), sibling(-1));
                else if (e.key === "Delete") (e.preventDefault(), s().closeTab(t.id));
                else if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
                  openMenuAt(e, tabMenu(t));
                }
              }}
              title={title}
            >
              <span className="tab-icon">
                <TabIcon t={t} />
              </span>
              <span className="tab-title">{title}</span>
              <button
                type="button"
                className="tab-close"
                aria-label={tr("tabs.closeTab")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => s().closeTab(t.id)}
              >
                <X size={12} strokeWidth={2} />
              </button>
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
            savePref("annalo.panel", !panelOpen);
          }}
        />
      )}
      {menu}
    </div>
  );
}
