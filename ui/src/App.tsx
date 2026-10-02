import { useEffect, useRef, useState } from "react";
import { api, on } from "./lib/api";
import { requestWeekProposal } from "./lib/weekplan";
import { TIME_SHORTCUTS, timeTrackingEnabled } from "./lib/timetracking";
import { useApp, savePref, activeTab } from "./store/app";
import { applyTheme } from "./lib/actions";
import { Sidebar, stopTimer } from "./components/Sidebar";
import { ConfirmHost, StatusBar, Toasts } from "./components/Shell";
import { VoiceBar } from "./components/VoiceBar";
import { TemplateHost } from "./components/Templates";
import { Ribbon, openAssistant, openToday } from "./components/Ribbon";
import { Workspace } from "./components/Workspace";
import { Resizer, readSize } from "./components/Resizer";
import { LinkPreview } from "./components/LinkPreview";
import { IssuePreview } from "./components/IssuePreview";
import { CreateIssueHost } from "./components/CreateIssueDialog";
import { openIssueNote } from "./lib/jiraActions";
import { CommandPalette } from "./components/CommandPalette";
import { CalendarPopover, openCalendar } from "./components/CalendarPopover";
import { RightPanel } from "./panels/RightPanel";
import { WindowControls } from "./components/WindowControls";
import { createSubpage } from "./views/PageView";
import { requestAddProperty } from "./views/PageProperties";
import { flushAllEditors, reloadEditors } from "./editor/NoteEditor";
import type { ActivityTick, GitPulled, SearchTarget } from "./lib/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tabTitle } from "./components/Shell";
import { requestPageCommand } from "./lib/pageModes";
import { sidebarShown, toggleSidebar, useNarrowWindow } from "./lib/layout";
import { flushBeforeExit } from "./lib/exit";
import { startUpdateChecks } from "./components/Updates";
import { commandAllowed, commandFor, currentKeymap } from "./lib/keymap";
import { withPacResults } from "./views/settings/NetworkSection";
import { warnDestination } from "./views/settings/BackupDestinations";
import type { SettingsView } from "./lib/types";
import { FocusDialogHost, useFocusEngine } from "./components/Focus";
import { PresentationHost, startPresentation } from "./components/Presentation";
import { MailImportHost } from "./components/MailImport";
import { BookmarkImportHost } from "./components/BookmarkImport";
import { openDayReview } from "./lib/reviewnav";
import { offerBriefing, openBriefing, startBriefing } from "./lib/briefing";
import { FirstRun } from "./onboarding/FirstRun";
import { checkFirstRun } from "./onboarding/state";
import { t, useT } from "./lib/i18n";

export function App() {
  useT();
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const panelOpen = useApp((s) => s.panelOpen);
  const focus = useApp((s) => s.focusMode);
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  useFocusEngine();

  useEffect(() => {
    const s = useApp.getState();
    (async () => {
      const [view] = await Promise.all([api.settings(), s.refreshTree(), s.refreshTimer(), api.meter().then((m) => s.set({ meter: m }))]);
      s.set({ settings: view });
      applyTheme(view.settings.theme);
      // Settings → Start: the last tabs (restored from the layout), the start page or today's note.
      const open = view.settings.start?.open ?? (view.settings.open_daily_on_start ? "daily" : "tabs");
      if (await api.onboardingNeeded().catch(() => false)) s.set({ onboarding: true });
      else if (open === "daily") {
        const p = await api.dailyNote();
        await s.refreshTree();
        s.openPage(p.id);
      } else if (open === "dashboard") s.openTab({ kind: "home" });
      document.body.classList.add("ready");
      // Settings → Briefing: the first start of a workday opens it (or notifies).
      if (!useApp.getState().onboarding) void startBriefing();
      // First start: the intro and the setup; after an upgrade a one-time hint instead.
      void checkFirstRun();
      void s.refreshConflicts();
      // PAC: re-evaluate once per start (the script may have changed) and store changed answers.
      void refreshPac(view);
    })().catch((e) => s.error(t("onb.failed"), e));
    // SQLite in a sync client's or a network folder can be corrupted: warn until dismissed.
    api
      .dataDirStatus()
      .then((d) => {
        // A move at startup, or a chosen folder that is not reachable (fallback to the default).
        const n = d.notice;
        if (n?.kind === "info") s.toast({ tone: "success", title: t("app.dirMoved"), detail: n.message });
        else if (n?.kind === "warning") s.toast({ tone: "warning", persistent: true, title: n.title ?? t("app.dirUnavailable"), detail: n.message });
        else if (n?.kind === "error") s.toast({ tone: "danger", persistent: true, title: n.title ?? t("app.dirNotMoved"), detail: n.message });
        if (d.synced) s.toast({ tone: "warning", persistent: true, title: t("app.syncedDb"), detail: t("app.syncedDbDetail", { dir: d.data_dir }) });
      })
      .catch(() => {});

    // Only builds with an update key look for new releases; installing always needs a click.
    const stopUpdates = startUpdateChecks();

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => applyTheme(useApp.getState().settings?.settings.theme ?? "system");
    media.addEventListener("change", onMedia);
    const unlisten = [
      on("data://entries", () => useApp.getState().bumpEntries()),
      on<string>("backup://failed", (msg) => notify("backup_failed") && useApp.getState().toast({ tone: "warning", title: t("app.backupFailed"), detail: msg })),
      on<Parameters<typeof warnDestination>[0]>("backup://destination-failed", (w) => notify("backup_failed") && warnDestination(w)),
      // Git sync: only failures are shown (successes appear in the settings' status line).
      on<string>("gitsync://failed", (msg) => notify("git_failed") && useApp.getState().toast({ tone: "warning", title: t("app.gitFailed"), detail: msg })),
      // Git sync took over notes from the server; notes changed on both sides are conflicts.
      on<GitPulled>("gitsync://pulled", (p) => void onPulled(p)),
      on("gitsync://conflicts", () => void useApp.getState().refreshConflicts()),
      // Pages rewritten elsewhere (an attachment renamed): open editors reload them.
      on<number[]>("data://pages", (ids) => reloadEditors(ids)),
      // Saved elsewhere (another window, a test, an import): take over the new settings.
      on("settings://changed", async () => {
        const next = await api.settings().catch(() => null);
        const cur = useApp.getState().settings;
        if (next && JSON.stringify(next) !== JSON.stringify(cur)) {
          useApp.getState().set({ settings: next });
          applyTheme(next.settings.theme);
        }
      }),
      // A task was toggled outside the editor: open editors of that page take over the new Markdown.
      on<number>("data://tasks", (pageId) => reloadEditors([pageId])),
      on<ActivityTick>("activity://tick", (t) => {
        const st = useApp.getState();
        if (st.timer && t.timer_idle_minutes != null && t.timer_idle_minutes !== st.timer.idle_minutes)
          st.set({ timer: { ...st.timer, idle_minutes: t.timer_idle_minutes, is_idle: t.is_idle } });
      }),
      // Tray „Beenden“: store edits, then quit for real.
      on("app://quit-requested", async () => {
        if (await flushBeforeExit()) await api.quit().catch((e) => useApp.getState().error(t("app.quitFailed"), e));
      }),
      on("tray://timer-stop", () => void (timeTrackingEnabled() && stopTimer())),
      // macOS app menu (its key equivalents ⌘, ⌘\ ⌘. never reach the keydown handler below).
      on<string>("menu://action", (action) => {
        const st = useApp.getState();
        if (action === "settings") st.openTab({ kind: "settings" });
        else if (action === "sidebar") toggleSidebar();
        else if (action === "focus") st.set({ focusMode: !st.focusMode });
        else if (action === "palette") st.set({ paletteOpen: true, paletteMode: "all", paletteQuery: "" });
        // Taskbar jump list (Windows).
        else if (action === "today") void openToday();
        else if (action === "new_page") void createSubpage(null);
      }),
      // Clicked the end-of-day reminder (or came back after it).
      on("nav://timesheet", () => useApp.getState().openTab({ kind: "timesheet" })),
      // Came back after the „Woche vorschlagen“ reminder.
      on("nav://week-proposal", () => {
        if (!timeTrackingEnabled()) return;
        useApp.getState().openTab({ kind: "timesheet" });
        requestWeekProposal();
      }),
      // Came back after the „Tagesrückblick ansehen“ reminder.
      on("nav://day-review", () => openDayReview()),
      // Morgen-Briefing: the tray entry, or back after its notification.
      on("nav://briefing", () => openBriefing()),
      // Its notification while the app is in front: offered here too.
      on("briefing://notified", () => offerBriefing()),
      // A result chosen in the quick-search window (it may have created the page).
      on<SearchTarget>("search://open", async (t) => {
        const st = useApp.getState();
        if (t.kind === "page") {
          if (!st.pages.has(t.page_id)) await st.refreshTree();
          st.openPage(t.page_id, { newTab: !!t.new_tab });
        } else if (t.kind === "timesheet") st.openTab({ kind: "timesheet" });
        else if (t.kind === "issues") st.openTab({ kind: "issues" });
        else if (t.kind === "issue") void openIssueNote(t.key);
        else if (t.kind === "timer_stop" && timeTrackingEnabled()) {
          await st.refreshTimer();
          stopTimer();
        }
      }),
      // Quick capture (its own window): new pages appear in the tree; the queue reports here.
      on<{ page_id: number; title: string; created: boolean; late: boolean }>("capture://stored", async (c) => {
        const st = useApp.getState();
        if (c.created || !st.pages.has(c.page_id)) await st.refreshTree();
        if (c.late) st.toast({ tone: "success", title: t("app.captureLate"), detail: t("app.captureIn", { title: c.title }) });
      }),
      on<[number, boolean]>("capture://undone", ([, created]) => void (created && useApp.getState().refreshTree())),
      on<string>("capture://queued", (msg) =>
        useApp.getState().toast({ tone: "warning", title: t("app.captureWaits"), detail: t("app.captureWaitsDetail", { msg }) }),
      ),
      on<[string, string]>("capture://failed", ([msg, text]) =>
        useApp.getState().toast({
          tone: "danger",
          persistent: true,
          title: t("app.captureFailed"),
          detail: `${msg}\n\n${text}`,
          action: { label: t("app.copyText"), run: () => void navigator.clipboard?.writeText(text).catch(() => {}) },
        }),
      ),
      // Global palette shortcut: toggles while the window is in front, otherwise always opens.
      on<boolean>("palette://toggle", (foreground) => {
        const st = useApp.getState();
        st.set({ paletteOpen: foreground ? !st.paletteOpen : true, paletteMode: "all", paletteQuery: "" });
      }),
    ];
    // Started from a taskbar jump-list entry: the shell sends it once everything listens.
    void Promise.all(unlisten).then(() => import("@tauri-apps/api/core").then(({ invoke }) => invoke("jump_take")));
    return () => {
      stopUpdates();
      media.removeEventListener("change", onMedia);
      unlisten.forEach((u) => u.then((f) => f()));
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // AltGr arrives as Ctrl+Alt on Windows; it types characters like \ | [ ] @ on German keyboards.
      if (e.getModifierState("AltGraph") || (e.ctrlKey && e.altKey)) return;
      const st = useApp.getState();
      if (e.key === "Escape" && st.focusMode && !st.paletteOpen) return st.set({ focusMode: false });
      // Settings → Tastatur: the keymap decides which command a combination runs.
      const id = commandFor(e, currentKeymap());
      const command = id ? COMMAND_RUNNERS[id] : undefined;
      if (!command) return;
      // „Zeiterfassung verwenden“ off: the timer shortcut does nothing (and the key stays free).
      if (TIME_SHORTCUTS.has(id!) && !timeTrackingEnabled()) return;
      // Back/forward never while typing: there the keys move the caret (word jumps on macOS).
      if (!commandAllowed(id!, document.activeElement)) return;
      // The editor takes Ctrl+J on a selection (inline AI) and marks the event handled.
      if (id === "assistant" && e.defaultPrevented) return;
      e.preventDefault();
      command();
    };
    // Mouse back/forward buttons.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) (e.preventDefault(), useApp.getState().goBack());
      else if (e.button === 4) (e.preventDefault(), useApp.getState().goForward());
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
  }, []);

  // Settings → Start: remember the window's size and position (saved shortly after moving/resizing).
  useEffect(() => {
    const win = getCurrentWindow();
    let timer = 0;
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void api.saveWindowState().catch(() => {}), 600);
    };
    const offs = [win.onMoved(later).catch(() => null), win.onResized(later).catch(() => null)];
    return () => {
      clearTimeout(timer);
      offs.forEach((p) => p.then((f) => f?.()));
    };
  }, []);

  // Store pending edits before the window closes.
  useEffect(() => {
    const win = getCurrentWindow();
    let closing = false;
    const unlisten = win
      .onCloseRequested(async (e) => {
        e.preventDefault();
        if (closing) return;
        closing = true;
        // Close to tray (macOS: always, the app stays in the Dock): the app keeps running.
        const toTray = useApp.getState().settings?.settings.close_to_tray;
        const action = await api.closeAction().catch(() => (toTray ? "hide" : "quit"));
        if (action !== "quit") {
          await flushAllEditors().catch(() => {});
          await api.hideWindow().catch((err) => useApp.getState().error(t("app.hideFailed"), err));
          closing = false;
          return;
        }
        if (!(await flushBeforeExit())) {
          closing = false;
          return;
        }
        // Needs core:window:allow-destroy.
        await win.destroy().catch((err) => {
          closing = false;
          useApp.getState().error(t("app.closeFailed"), err);
        });
      })
      .catch(() => null);
    return () => {
      unlisten.then((f) => f?.());
    };
  }, []);

  // Window title follows the active tab.
  const pages = useApp((s) => s.pages);
  useEffect(() => {
    const title = active ? `${tabTitle(active, pages)} – Arcalo` : "Arcalo";
    document.title = title;
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [active, pages]);

  const [sideW, setSideW] = useState(() => readSize("annalo.sidebar-w", 264));
  const [panelW, setPanelW] = useState(() => readSize("annalo.panel-w", 360));
  const dragStart = useRef(0);
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
  const persist = (key: string, v: number) => {
    try {
      localStorage.setItem(key, String(v));
    } catch {
      /* ignore */
    }
  };

  // The welcome choice fills the window: no assistant/outline panel next to it.
  const onboardingShown = useApp((st) => st.onboarding && st.tree.length === 0 && (st.tabs.find((t) => t.id === st.activeTabId)?.kind ?? "home") === "home");
  const showPanel = panelOpen && !focus && !onboardingShown;
  const narrow = useNarrowWindow();
  const showSidebar = sidebarShown(sidebarOpen, showPanel, narrow) && !focus;
  const style = { "--sidebar-w": `${sideW}px`, "--panel-w": `${panelW}px` } as React.CSSProperties;
  return (
    <div className={`app ${focus ? "focus" : ""} ${showPanel ? "with-panel" : ""}`} style={style}>
      {!focus && <Ribbon />}
      {showSidebar && (
        <>
          <Sidebar />
          <Resizer
            label={t("app.sidebar")}
            className="side-resizer"
            onResize={(dx) => {
              if (!dragStart.current) dragStart.current = sideW;
              setSideW(clamp(dragStart.current + dx, 200, 480));
            }}
            onEnd={() => {
              dragStart.current = 0;
              persist("annalo.sidebar-w", sideW);
            }}
            onReset={() => (setSideW(264), persist("annalo.sidebar-w", 264))}
          />
        </>
      )}
      <main className="main">
        <Workspace />
        <StatusBar />
      </main>
      {showPanel && (
        <>
          <Resizer
            label={t("panel.label")}
            className="panel-resizer"
            onResize={(dx) => {
              if (!dragStart.current) dragStart.current = panelW;
              setPanelW(clamp(dragStart.current - dx, 280, 640));
            }}
            onEnd={() => {
              dragStart.current = 0;
              persist("annalo.panel-w", panelW);
            }}
            onReset={() => (setPanelW(360), persist("annalo.panel-w", 360))}
          />
          <RightPanel />
        </>
      )}
      <CommandPalette />
      <LinkPreview />
      <IssuePreview />
      <CreateIssueHost />
      <CalendarPopover />
      <WindowControls />
      <Toasts />
      <VoiceBar />
      <FocusDialogHost />
      <PresentationHost />
      <MailImportHost />
      <BookmarkImportHost />
      <ConfirmHost />
      <TemplateHost />
      <FirstRun />
    </div>
  );
}

/** Notes the Git sync took over: tree, open editors and the conflict marks follow; conflicts are announced. */
async function onPulled(p: GitPulled) {
  const st = useApp.getState();
  await st.refreshTree().catch(() => {});
  reloadEditors([...p.pages, ...p.created]);
  await st.refreshConflicts();
  if (p.kept?.length) {
    st.toast({
      tone: "warning",
      persistent: true,
      title: t("app.keptTitle"),
      detail: t("app.keptDetail", { n: p.kept.length }),
    });
  }
  if (!p.conflicts.length) return;
  const first = p.conflicts[0];
  const title = st.pages.get(first)?.title ?? t("app.aNote");
  st.toast({
    tone: "warning",
    persistent: true,
    title: t("app.conflicts", { n: p.conflicts.length }),
    detail: p.conflicts.length === 1 ? t("app.conflictOne", { title }) : t("app.conflictMany"),
    action: { label: t("app.merge"), run: () => useApp.getState().openTab({ kind: "conflict", pageId: first }, { newTab: true }) },
  });
}

/** Whether a notification kind is switched on (Settings → Benachrichtigungen). */
export function notify(kind: "budget" | "backup_failed" | "git_failed" | "updates"): boolean {
  return useApp.getState().settings?.settings.notifications?.[kind] !== false;
}

/** Re-evaluates the PAC script at start and saves changed answers (mode PAC only). */
async function refreshPac(view: SettingsView) {
  const s = view.settings;
  if (s.network?.mode !== "pac" || !s.network.pac_url) return;
  try {
    const next = await withPacResults(s);
    if (JSON.stringify(next.network.pac_results) !== JSON.stringify(s.network.pac_results)) {
      const saved = await api.saveSettings(next);
      useApp.getState().set({ settings: saved });
    }
  } catch (e) {
    useApp.getState().toast({ tone: "warning", title: t("app.pacFailed"), detail: String(e) });
  }
}

const togglePanel = () => {
  const st = useApp.getState();
  st.set({ panelOpen: !st.panelOpen });
  savePref("annalo.panel", !st.panelOpen);
};
const cycleTab = (d: number) => {
  const st = useApp.getState();
  const i = st.tabs.findIndex((t) => t.id === st.activeTabId);
  const next = st.tabs[(i + d + st.tabs.length) % st.tabs.length];
  if (next) st.activateTab(next.id);
};

/** What each keymap command does (ids as in lib/keymap.ts). */
const COMMAND_RUNNERS: Record<string, () => void> = {
  palette: () => {
    const st = useApp.getState();
    st.set({ paletteOpen: !st.paletteOpen, paletteMode: "all", paletteQuery: "" });
  },
  quick_switcher: () => useApp.getState().set({ paletteOpen: true, paletteMode: "pages", paletteQuery: "" }),
  new_page: () => void createSubpage(null),
  daily_note: () => void openToday(),
  tasks: () => useApp.getState().openTab({ kind: "tasks" }),
  calendar_view: () => useApp.getState().openTab({ kind: "calendar" }),
  calendar: () => {
    const st = useApp.getState();
    if (st.calendar) st.set({ calendar: null });
    else openCalendar();
  },
  search: () => {
    const st = useApp.getState();
    if (!st.sidebarOpen) {
      st.set({ sidebarOpen: true });
      savePref("annalo.sidebar", true);
    }
    setTimeout(() => window.dispatchEvent(new Event("annalo:sidebar-search")), 0);
  },
  new_tab: () => useApp.getState().openTab({ kind: "home" }, { newTab: true }),
  close_tab: () => {
    const st = useApp.getState();
    if (st.activeTabId) st.closeTab(st.activeTabId);
  },
  next_tab: () => cycleTab(1),
  prev_tab: () => cycleTab(-1),
  back: () => useApp.getState().goBack(),
  forward: () => useApp.getState().goForward(),
  timer: () => (useApp.getState().timer ? void stopTimer() : useApp.getState().openTab({ kind: "timesheet" })),
  assistant: () => openAssistant(),
  toggle_sidebar: toggleSidebar,
  toggle_panel: togglePanel,
  add_property: () => requestAddProperty(),
  toggle_source: () => requestPageCommand("source"),
  full_width: () => requestPageCommand("full"),
  focus_mode: () => useApp.getState().set({ focusMode: !useApp.getState().focusMode }),
  settings: () => useApp.getState().openTab({ kind: "settings" }),
  present: () => {
    const tab = activeTab();
    if (tab?.kind === "page" && tab.pageId != null) void startPresentation(tab.pageId);
  },
};
