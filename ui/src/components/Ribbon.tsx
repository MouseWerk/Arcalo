// Obsidian-style ribbon: a slim column of global actions left of the sidebar.

import { useRef } from "react";
import { Activity, Briefcase, CalendarCheck2, CalendarRange, ChevronDown, FilePlus2, MessagesSquare, Search, ListChecks, Mic, PanelLeft, Settings, Sparkles, Sun, Sunset, Target, Ticket, Timer, Waypoints } from "lucide-react";
import { api } from "../lib/api";
import { useApp, savePref } from "../store/app";
import { IconButton } from "./ui";
import { QuickLinks } from "./QuickLinks";
import { HelpButton } from "./Help";
import { sidebarShown, toggleSidebar, useNarrowWindow } from "../lib/layout";
import { useTimeTracking } from "../lib/timetracking";
import { aiEnabled, useAi } from "../lib/aiswitch";
import { createSubpage } from "../views/PageView";
import { openCalendar } from "./CalendarPopover";
import { t as tr, useT } from "../lib/i18n";
import { withHint } from "../lib/keymap";
import { openFocusDialog } from "./Focus";
import { openDayReview } from "../lib/reviewnav";
import { openBriefing } from "../lib/briefing";
import { openChatView, useChat } from "../store/chat";
import { startVoice, stopVoice, useVoice } from "../lib/voice";

export async function openToday() {
  const s = useApp.getState();
  try {
    const p = await api.dailyNote();
    await s.refreshTree();
    s.openPage(p.id);
  } catch (e) {
    s.error(tr("ribbon.dailyFailed"), e);
  }
}

export function openAssistant() {
  // „KI verwenden“ off: there is no assistant to open (a shortcut or link does nothing).
  if (!aiEnabled()) return;
  const s = useApp.getState();
  s.set({ panelOpen: true, panelTab: "assistant" });
  savePref("arcalo.panel", true);
  useChat.setState({ historyOpen: false });
  setTimeout(() => document.querySelector<HTMLTextAreaElement>(".assistant .composer textarea")?.focus(), 50);
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
  const focus = useApp((s) => s.focus);
  // „Zeiterfassung verwenden“ off: no timesheet and projects in the ribbon.
  const timeOn = useTimeTracking();
  // „KI verwenden“ off: no assistant and no chat in the ribbon.
  const ai = useAi();
  const recording = useVoice((v) => !!v.status.recording);
  const jiraOn = useApp((st) => (st.settings?.settings.jira?.sites.length ?? 0) > 0);
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
      <IconButton icon={CalendarRange} label={withHint(t("ribbon.calendarView"), "calendar_view")} active={tab?.kind === "calendar"} aria-current={tab?.kind === "calendar" ? "page" : undefined} tooltipSide={side} size="lg" className="ribbon-calendar-view" onClick={() => s().openTab({ kind: "calendar" })} />
      {timeOn && <IconButton icon={Timer} label={t("ribbon.timesheet")} active={tab?.kind === "timesheet"} aria-current={tab?.kind === "timesheet" ? "page" : undefined} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "timesheet" })} />}
      <IconButton icon={ListChecks} label={withHint(t("ribbon.tasks"), "tasks")} active={tab?.kind === "tasks"} aria-current={tab?.kind === "tasks" ? "page" : undefined} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "tasks" })} />
      {timeOn && <IconButton icon={Briefcase} label={t("ribbon.projects")} active={tab?.kind === "projects"} aria-current={tab?.kind === "projects" ? "page" : undefined} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "projects" })} />}
      {jiraOn && <IconButton icon={Ticket} label={t("ribbon.issues")} active={tab?.kind === "issues"} aria-current={tab?.kind === "issues" ? "page" : undefined} tooltipSide={side} size="lg" className="ribbon-issues" onClick={() => s().openTab({ kind: "issues" })} />}
      <IconButton icon={Waypoints} label={t("ribbon.graph")} active={tab?.kind === "graph"} aria-current={tab?.kind === "graph" ? "page" : undefined} tooltipSide={side} size="lg" className="ribbon-graph" onClick={() => s().openTab({ kind: "graph" })} />
      <IconButton icon={Activity} label={t("ribbon.activity")} active={tab?.kind === "activity"} aria-current={tab?.kind === "activity" ? "page" : undefined} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "activity" })} />
      <IconButton icon={Sun} label={t("ribbon.briefing")} active={tab?.kind === "briefing"} aria-current={tab?.kind === "briefing" ? "page" : undefined} tooltipSide={side} size="lg" className="ribbon-briefing" onClick={() => openBriefing()} />
      <IconButton icon={Sunset} label={t("ribbon.review")} active={tab?.kind === "review"} aria-current={tab?.kind === "review" ? "page" : undefined} tooltipSide={side} size="lg" className="ribbon-review" onClick={() => openDayReview()} />
      <IconButton icon={Target} label={t(focus ? "ribbon.focusRunning" : "ribbon.focus")} active={!!focus} tooltipSide={side} size="lg" onClick={() => (focus ? document.querySelector<HTMLButtonElement>(".sb-focus")?.click() : openFocusDialog())} />
      {ai && <IconButton icon={Sparkles} label={withHint(t("ribbon.assistant"), "assistant")} tooltipSide={side} size="lg" className="ribbon-assistant" onClick={openAssistant} />}
      {ai && <IconButton icon={MessagesSquare} label={withHint(t("ribbon.chat"), "chat_view")} active={tab?.kind === "chat"} aria-current={tab?.kind === "chat" ? "page" : undefined} tooltipSide={side} size="lg" className="ribbon-chat" onClick={() => void openChatView()} />}
      <IconButton
        icon={Mic}
        label={t(recording ? "voice.stopRecording" : "voice.record")}
        active={recording}
        tooltipSide={side}
        size="lg"
        className={`ribbon-voice ${recording ? "is-recording" : ""}`}
        onClick={() => void (recording ? stopVoice() : startVoice())}
      />
      <span className="ribbon-sep" />
      <QuickLinks />
      <span className="grow" />
      <HelpButton />
      <IconButton icon={Settings} label={withHint(t("ribbon.settings"), "settings")} active={tab?.kind === "settings"} aria-current={tab?.kind === "settings" ? "page" : undefined} tooltipSide={side} size="lg" onClick={() => s().openTab({ kind: "settings" })} />
    </nav>
  );
}
