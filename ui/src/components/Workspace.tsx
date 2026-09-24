// The editor area: one or more panes side by side, each with its own tabs.

import { Fragment, useRef, useState, type DragEvent } from "react";
import { Columns2, PanelRight, Plus, X } from "lucide-react";
import { useApp, savePref, type Pane, type Tab } from "../store/app";
import { IconButton, useMenu, type MenuEntry } from "./ui";
import { Home, TabIcon, tabTitle } from "./Shell";
import { Resizer } from "./Resizer";
import { ViewHeader } from "./ViewHeader";
import { PageView } from "../views/PageView";
import { TimesheetView } from "../views/TimesheetView";
import { ProjectsView } from "../views/ProjectsView";
import { SettingsView } from "../views/SettingsView";
import { TagView } from "../views/TagView";
import { TrashView } from "../views/TrashView";
import { TasksView } from "../views/TasksView";
import { useT } from "../lib/i18n";
import { withHint } from "../lib/keymap";

const MIN_PANE = 280;

export function Workspace() {
  const panes = useApp((s) => s.panes);
  const sizes = useApp((s) => s.paneSizes);
  const activePaneId = useApp((s) => s.activePaneId);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<number[] | null>(null);

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
  return (
    <section
      className={`pane ${active ? "active" : ""} ${multi ? "multi" : ""}`}
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
    default:
      return (
        <>
          <ViewHeader tab={tab} title={<TabLabel tab={tab} />} />
          <div className="view-body">
            {tab.kind === "timesheet" && <TimesheetView />}
            {tab.kind === "projects" && <ProjectsView />}
            {tab.kind === "settings" && <SettingsView />}
            {tab.kind === "tag" && <TagView tag={tab.tag!} />}
            {tab.kind === "trash" && <TrashView />}
            {tab.kind === "tasks" && <TasksView />}
          </div>
        </>
      );
  }
}

function TabLabel({ tab }: { tab: Tab }) {
  useT();
  const pages = useApp((s) => s.pages);
  return <>{tabTitle(tab, pages)}</>;
}

const TAB_MIME = "application/x-annalo-tab";

function PaneTabs({ pane, last }: { pane: Pane; last: boolean }) {
  const tr = useT();
  const pages = useApp((s) => s.pages);
  const panelOpen = useApp((s) => s.panelOpen);
  const paneCount = useApp((s) => s.panes.length);
  const [menu, openMenu] = useMenu();
  const [dropAt, setDropAt] = useState<number | null>(null);
  const s = useApp.getState;

  const onDragOver = (e: DragEvent, index: number) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropAt(index);
  };
  const onDrop = (e: DragEvent, index: number) => {
    const id = e.dataTransfer.getData(TAB_MIME);
    setDropAt(null);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    s().moveTab(id, pane.id, index);
  };

  const tabMenu = (t: Tab): MenuEntry[] => [
    { label: tr("tabs.openRight"), icon: Columns2, disabled: paneCount >= 3 && last, onSelect: () => s().splitTab(t.id) },
    "separator",
    { label: tr("tabs.close"), icon: X, onSelect: () => s().closeTab(t.id) },
    { label: tr("tabs.closeOthers"), onSelect: () => s().closeOthers(t.id), disabled: pane.tabs.length < 2 },
  ];

  return (
    <div
      className="tabbar"
      role="tablist"
      data-tauri-drag-region
      onDragOver={(e) => onDragOver(e, pane.tabs.length)}
      onDragLeave={() => setDropAt(null)}
      onDrop={(e) => onDrop(e, pane.tabs.length)}
      onDoubleClick={(e) => e.target === e.currentTarget && s().openTab({ kind: "home" }, { newTab: true })}
    >
      <div className="tabs" data-tauri-drag-region>
        {pane.tabs.map((t, i) => {
          const title = tabTitle(t, pages);
          const selected = t.id === pane.activeTabId;
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={selected}
              className={`tab ${selected ? "active" : ""} ${dropAt === i ? "drop-before" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_MIME, t.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDropAt(null)}
              onDragOver={(e) => onDragOver(e, i)}
              onDrop={(e) => onDrop(e, i)}
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
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu({ clientX: r.left + 12, clientY: r.bottom, preventDefault: () => e.preventDefault() }, tabMenu(t));
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
        <IconButton icon={Plus} label={withHint(tr("tabs.newTab"), "new_tab")} size={26} iconSize={15} onClick={() => s().openTab({ kind: "home" }, { newTab: true })} />
      </div>
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
