// Obsidian-style ribbon: a slim column of global actions left of the sidebar.

import { useRef } from "react";
import { Briefcase, CalendarCheck2, ChevronDown, FilePlus2, Search, ListChecks, PanelLeft, Settings, Sparkles, Timer } from "lucide-react";
import { api } from "../lib/api";
import { useApp, savePref } from "../store/app";
import { IconButton } from "./ui";
import { QuickLinks } from "./QuickLinks";
import { sidebarShown, toggleSidebar, useNarrowWindow } from "../lib/layout";
import { createSubpage } from "../views/PageView";
import { openCalendar } from "./CalendarPopover";
import { useT } from "../lib/i18n";
import { withHint } from "../lib/keymap";

export async function openToday() {
  const s = useApp.getState();
  try {
    const p = await api.dailyNote();
    await s.refreshTree();
    s.openPage(p.id);
  } catch (e) {
    s.error("Tagesnotiz konnte nicht geöffnet werden", e);
  }
}

export function openAssistant() {
  const s = useApp.getState();
  s.set({ panelOpen: true, panelTab: "assistant" });
  savePref("annalo.panel", true);
  setTimeout(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(), 50);
}

/** „Heutige Tagesnotiz“; right-click, a long press or the small chevron opens the calendar. */
function DailyButton() {
  const t = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const press = useRef<{ timer: number; fired: boolean } | null>(null);
  const show = () => openCalendar(wrap.current, undefined, "right");
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
  };
  return (
    <div className="ribbon-daily" ref={wrap}>
      <IconButton
        icon={CalendarCheck2}
        label={`${withHint(t("ribbon.daily"), "daily_note")} – ${t("ribbon.rightClickCalendar")}`}
        tooltipSide="right"
        size="lg"
        onClick={() => {
          if (press.current?.fired) return;
          openToday();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          show();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = { timer: 0, fired: false };
          p.timer = window.setTimeout(() => {
            p.fired = true;
            show();
          }, 500);
          press.current = p;
        }}
        onPointerUp={cancel}
        onPointerLeave={cancel}
      />
      <button type="button" className="ribbon-chevron" aria-label={withHint(t("ribbon.calendar"), "calendar")} data-tooltip={withHint(t("ribbon.calendar"), "calendar")} data-tooltip-side="right" onClick={show}>
        <ChevronDown size={11} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

export function Ribbon() {
  const t = useT();
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const panelOpen = useApp((s) => s.panelOpen);
  const shown = sidebarShown(sidebarOpen, panelOpen, useNarrowWindow());
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const s = useApp.getState;
  const side = "right" as const;
  return (
    <nav className="ribbon" aria-label={t("ribbon.actions")}>
      {/* macOS: room for the traffic lights; drags the window like a title bar. */}
      <div className="ribbon-titlebar" data-tauri-drag-region />
      <IconButton
        icon={PanelLeft}
        label={withHint(t(shown ? "ribbon.hideSidebar" : "ribbon.showSidebar"), "toggle_sidebar")}
        active={shown}
        tooltipSide={side}
        size="lg"
        onClick={toggleSidebar}
      />
      <span className="ribbon-sep" />
      <IconButton icon={FilePlus2} label={withHint(t("ribbon.newPage"), "new_page")} tooltipSide={side} size="lg" onClick={() => createSubpage(null)} />
      <DailyButton />
      <IconButton icon={Search} label={withHint(t("ribbon.palette"), "palette")} tooltipSide={side} size="lg" onClick={() => s().set({ paletteOpen: true, paletteMode: "all", paletteQuery: "" })} />
      <span className="ribbon-sep" />
      <IconButton icon={Timer} label={t("ribbon.timesheet")} active={tab?.kind === "timesheet"} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "timesheet" })} />
      <IconButton icon={ListChecks} label={withHint(t("ribbon.tasks"), "tasks")} active={tab?.kind === "tasks"} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "tasks" })} />
      <IconButton icon={Briefcase} label={t("ribbon.projects")} active={tab?.kind === "projects"} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "projects" })} />
      <IconButton icon={Sparkles} label={withHint(t("ribbon.assistant"), "assistant")} tooltipSide={side} size="lg" onClick={openAssistant} />
      <span className="ribbon-sep" />
      <QuickLinks />
      <span className="grow" />
      <IconButton icon={Settings} label={withHint(t("ribbon.settings"), "settings")} active={tab?.kind === "settings"} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "settings" })} />
    </nav>
  );
}
