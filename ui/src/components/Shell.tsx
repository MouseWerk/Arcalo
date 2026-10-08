// Tab bar, status bar, start screen, toasts and the confirm dialog host.

import {
  Activity, AlertTriangle, Briefcase, Home as HomeIcon, CheckCircle2, Cpu, Hash, Info, Link2, Play, Settings, Timer, Trash2, X, XCircle, ListChecks,
  FileText, GitMerge, Paperclip, CalendarCheck, CalendarRange, Sunset, Sun, Ticket, Waypoints, ChevronDown, MessagesSquare,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApp, type Tab } from "../store/app";
import { PageIcon } from "./icons";
import { Button, Dialog, IconButton } from "./ui";
import { clock, h1, int, usd } from "../lib/format";
import { shortenPaths } from "../lib/api";
import { useTimerSeconds, stopTimer } from "./Sidebar";
import { useTimeTracking } from "../lib/timetracking";
import { useAi } from "../lib/aiswitch";
import { Onboarding } from "./Onboarding";
import { FirstSteps } from "../onboarding/FirstStepsCard";
import { UpdateLayer, UpdateStatusItem } from "./Updates";
import { Dashboard } from "./Dashboard";
import { FocusStatus } from "./Focus";
import { t, t as tr, useT } from "../lib/i18n";
import { modelLabel, usableProvider } from "../lib/providers";

export function tabTitle(tab: Tab, pages: Map<number, { title: string }>) {
  switch (tab.kind) {
    case "home":
      return t("tabs.home");
    case "page":
      return pages.get(tab.pageId!)?.title ?? t("tabs.page");
    case "timesheet":
      return t("tabs.timesheet");
    case "projects":
      return t("tabs.projects");
    case "settings":
      return t("tabs.settings");
    case "tag":
      return `#${tab.tag}`;
    case "trash":
      return t("tabs.trash");
    case "tasks":
      return t("tabs.tasks");
    case "activity":
      return t("tabs.activity");
    case "calendar":
      return t("tabs.calendar");
    case "review":
      return t("tabs.review");
    case "weekreview":
      return t("tabs.weekReview");
    case "briefing":
      return t("tabs.briefing");
    case "issues":
      return t("tabs.issues");
    case "graph":
      return t("tabs.graph");
    case "chat":
      return t("tabs.chat");
    case "attachments":
      return t("tabs.attachments");
    case "pdf":
      return tab.tag ?? "PDF";
    case "conflict":
      return `${t("tabs.conflict")}: ${pages.get(tab.pageId!)?.title ?? t("tabs.page")}`;
  }
}

export function TabIcon({ t }: { t: Tab }) {
  const pages = useApp((s) => s.pages);
  switch (t.kind) {
    case "home":
      return <HomeIcon size={14} strokeWidth={1.75} />;
    case "page":
      return <PageIcon name={pages.get(t.pageId!)?.icon} size={14} />;
    case "timesheet":
      return <Timer size={14} strokeWidth={1.75} />;
    case "projects":
      return <Briefcase size={14} strokeWidth={1.75} />;
    case "settings":
      return <Settings size={14} strokeWidth={1.75} />;
    case "tag":
      return <Hash size={14} strokeWidth={1.75} />;
    case "trash":
      return <Trash2 size={14} strokeWidth={1.75} />;
    case "tasks":
      return <ListChecks size={14} strokeWidth={1.75} />;
    case "activity":
      return <Activity size={14} strokeWidth={1.75} />;
    case "calendar":
      return <CalendarRange size={14} strokeWidth={1.75} />;
    case "review":
      return <Sunset size={14} strokeWidth={1.75} />;
    case "weekreview":
      return <CalendarCheck size={14} strokeWidth={1.75} />;
    case "briefing":
      return <Sun size={14} strokeWidth={1.75} />;
    case "issues":
      return <Ticket size={14} strokeWidth={1.75} />;
    case "graph":
      return <Waypoints size={14} strokeWidth={1.75} />;
    case "chat":
      return <MessagesSquare size={14} strokeWidth={1.75} />;
    case "attachments":
      return <Paperclip size={14} strokeWidth={1.75} />;
    case "pdf":
      return <FileText size={14} strokeWidth={1.75} />;
    case "conflict":
      return <GitMerge size={14} strokeWidth={1.75} />;
  }
}

export function StatusBar() {
  const t = useT();
  const timer = useApp((s) => s.timer);
  const meter = useApp((s) => s.meter);
  const settings = useApp((s) => s.settings);
  const seconds = useTimerSeconds();
  const timeOn = useTimeTracking();
  const ai = useAi();
  const s = useApp.getState;
  const configured = !!settings && usableProvider(settings);
  const onPage = useApp((st) => st.tabs.find((t) => t.id === st.activeTabId)?.kind === "page");
  const stats = useApp((st) => st.editorStats);
  const doc = useApp((st) => st.activeDoc);
  const focusMode = useApp((st) => st.focusMode);
  return (
    <footer className="statusbar">
      {!timeOn ? null : timer ? (
        <button type="button" className={`sb-item sb-timer${timer.paused_since ? " paused" : ""}`} onClick={() => stopTimer()} title={t("status.stopTimer")}>
          <span className={timer.paused_since ? "pause-dot" : "rec-dot"} aria-hidden />
          <span className="num">{clock(seconds)}</span>
          {timer.paused_since && <span className="faint">{t("timer.paused")}</span>}
          <span className="faint">{timer.entry.vorgang_nr ? `${timer.entry.vorgang_nr}` : ""}</span>
          {timer.idle_minutes > 0 && <span className="sb-warn">{t("status.idle", { n: timer.idle_minutes })}</span>}
        </button>
      ) : (
        <button type="button" className="sb-item" onClick={() => s().openTab({ kind: "timesheet" })}>
          <Play size={12} /> {t("status.startTimer")}
        </button>
      )}
      <FocusStatus />
      <span className="sb-spacer" />
      <UpdateStatusItem />
      {focusMode && (
        <button type="button" className="sb-item" onClick={() => s().set({ focusMode: false })} title={t("status.endFocus")}>
          {t("status.focusMode")} <kbd>Esc</kbd>
        </button>
      )}
      {onPage && doc && (
        <button type="button" className="sb-item" onClick={() => s().set({ panelOpen: true, panelTab: "links" })} title={t("status.backlinks")}>
          <Link2 size={12} />
          <span className="num">{doc.backlinks.length}</span>
        </button>
      )}
      {onPage && stats && (
        <span className="sb-item sb-static num" title={t("status.chars", { n: int(stats.chars) })}>
          {int(stats.words)} {stats.words === 1 ? t("status.word") : t("status.words")}
        </span>
      )}
      {/* „KI verwenden“ off: no model, meter or „KI einrichten“ down here. */}
      {ai && <button type="button" className="sb-item sb-ai" onClick={() => s().set({ panelOpen: true, panelTab: "assistant" })} title={t("status.aiSession")}>
        <Cpu size={12} />
        {meter && meter.requests > 0 ? (
          <>
            <span className="num">{meter.last_tokens_per_second != null ? `${h1(meter.last_tokens_per_second)} t/s` : "–"}</span>
            <span className="faint num">{t("assist.tokens", { n: int(meter.prompt_tokens + meter.completion_tokens) })}</span>
            <span className="faint num">{usd(meter.cost_usd)}</span>
          </>
        ) : (
          <span className="faint">{configured && settings ? modelLabel(settings.settings.providers, settings.settings.router.standard_provider, settings.settings.router.standard_model) : t("status.setupAi")}</span>
        )}
      </button>}
    </footer>
  );
}

export function Home() {
  const onboarding = useApp((st) => st.onboarding);
  const empty = useApp((st) => st.tree.length === 0);
  // Something imported or created meanwhile (e.g. via Settings): the choice is moot.
  return onboarding && empty ? <Onboarding /> : <StartPage />;
}

function StartPage() {
  // The greeting lives in the „Heute“ widget; the start page is its boards. After the first
  // setup „Erste Schritte“ sits above them until done or dismissed.
  return (
    <div className="home">
      <div className="home-inner home-dash">
        <FirstSteps />
        <Dashboard />
      </div>
    </div>
  );
}

/** A toast's detail with long file paths shortened in the middle (the full text as tooltip). */
function ToastDetail({ text }: { text: string }) {
  const shown = shortenPaths(text);
  return (
    <div className="toast-detail" title={shown !== text ? text : undefined}>
      {shown}
    </div>
  );
}

/** The technical text of an error (SQLite's, the operating system's), opened with „Details“. */
function ToastTech({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="toast-tech-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {tr("toast.details")}
        <ChevronDown size={12} aria-hidden />
      </button>
      {open && <div className="toast-tech selectable">{text}</div>}
    </>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  const icon = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle };
  // A toast pointed at or holding the focus does not close (time to reach „Rückgängig“). Pointed
  // at means the pointer was moved onto it: a toast that appears under a resting pointer (after a
  // click on a button below it) gets hover and enter events without any movement and would
  // otherwise stay over the controls until the mouse moves.
  const box = useRef<HTMLDivElement>(null);
  const pointed = useRef(false);
  const sync = () => {
    const el = box.current;
    if (pointed.current && !el?.matches(":hover")) pointed.current = false;
    useApp.getState().holdToasts(!!el && (pointed.current || el.contains(document.activeElement)));
  };
  // A toast closed under the pointer or with the focus leaves no leave event behind.
  useEffect(sync, [toasts]);
  useEffect(() => {
    let last: [number, number] | null = null;
    const move = (e: MouseEvent) => {
      const moved = !last || last[0] !== e.clientX || last[1] !== e.clientY;
      last = [e.clientX, e.clientY];
      if (moved && !pointed.current && box.current?.contains(e.target as Node)) {
        pointed.current = true;
        useApp.getState().holdToasts(true);
      }
    };
    window.addEventListener("mousemove", move, true);
    // The stack's height, so a control scrolled into view stops above it (settings.css).
    const root = document.documentElement.style;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => root.setProperty("--toast-stack", `${Math.ceil(box.current?.offsetHeight ?? 0)}px`));
    if (box.current) resize?.observe(box.current);
    return () => {
      window.removeEventListener("mousemove", move, true);
      resize?.disconnect();
      root.removeProperty("--toast-stack");
      useApp.getState().holdToasts(false);
    };
  }, []);
  return (
    <div
      className="toasts"
      aria-live="polite"
      ref={box}
      onMouseLeave={() => {
        pointed.current = false;
        useApp.getState().holdToasts(box.current?.contains(document.activeElement) ?? false);
      }}
      onFocus={() => useApp.getState().holdToasts(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && useApp.getState().holdToasts(pointed.current)}
    >
      <UpdateLayer />
      {toasts.map((t) => {
        const Icon = icon[t.tone];
        return (
          <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === "danger" ? "alert" : "status"}>
            <Icon size={16} className="toast-icon" />
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.detail && <ToastDetail text={t.detail} />}
              {t.tech && <ToastTech text={t.tech} />}
            </div>
            {t.action && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </Button>
            )}
            <IconButton icon={X} label={tr("common.close")} size="sm" onClick={() => dismiss(t.id)} />
          </div>
        );
      })}
    </div>
  );
}

export function ConfirmHost() {
  const req = useApp((s) => s.confirmRequest);
  if (!req) return null;
  return (
    <Dialog
      open
      onClose={() => req.resolve("cancel")}
      title={req.title}
      width={req.altLabel ? 480 : 420}
      footer={
        <>
          <Button variant="ghost" onClick={() => req.resolve("cancel")}>
            {req.cancelLabel ?? tr("common.cancel")}
          </Button>
          {req.altLabel && <Button onClick={() => req.resolve("alt")}>{req.altLabel}</Button>}
          <Button variant={req.danger ? "danger" : "primary"} onClick={() => req.resolve("confirm")} data-autofocus>
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="dialog-text">{req.message}</p>
    </Dialog>
  );
}
