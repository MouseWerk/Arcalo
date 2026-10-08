// The shell of the Android companion app: four tabs and a capture button at the bottom,
// screens opened above them (Android's back button closes them), toasts, and the sync when the
// app comes back to the front.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleCheck, Clock, FileText, Info, ListChecks, Plus, Sun, TriangleAlert } from "lucide-react";
import "../styles/mobile.css";
import { applyPrefs } from "../lib/prefs";
import { t, useT, type TKey } from "../lib/i18n";
import type { Settings, SettingsView } from "../lib/types";
import { mobileApi } from "./api";
import { Ctx, errorText, useMobile, type MobileContext, type Toast, type ToastTone } from "./context";
import { START, current, navigate, syncDue, type Tab } from "./model";
import { TodayScreen } from "./screens/Today";
import { CaptureScreen } from "./screens/Capture";
import { DailyScreen } from "./screens/Daily";
import { TasksScreen } from "./screens/Tasks";
import { TimeScreen } from "./screens/Time";
import { NotesScreen, PageScreen } from "./screens/Notes";
import { SettingsScreen } from "./screens/Settings";
import { Spinner } from "./ui";

const TAB_ICONS: Record<Tab, typeof Sun> = { today: Sun, tasks: ListChecks, time: Clock, notes: FileText };
const TAB_LABELS: Record<Tab, TKey> = { today: "mob.tab.today", tasks: "mob.tab.tasks", time: "mob.tab.time", notes: "mob.tab.notes" };

export function MobileApp() {
  useT();
  const [route, dispatch] = useReducer(navigate, START);
  const [view, setView] = useState<SettingsView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [syncing, setSyncing] = useState(false);
  const lastSync = useRef<number | null>(null);
  const depth = useRef(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((tone: ToastTone, title: string, detail?: string) => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, tone, title, detail }]);
    window.setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), tone === "error" ? 6000 : 3500);
  }, []);

  const loadSettings = useCallback(
    () =>
      mobileApi
        .settings()
        .then((v) => {
          applyPrefs(v.settings);
          setView(v);
          setFailed(null);
        })
        .catch((e) => setFailed(errorText(e))),
    [],
  );

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Data changed in the shell (a booking, a sync that pulled notes): the screens load again.
  useEffect(() => {
    const offs = [
      listen("data://entries", refresh),
      listen("data://pages", refresh),
      listen("gitsync://pulled", refresh),
      listen("settings://changed", () => void loadSettings()),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
  }, [refresh, loadSettings]);

  // Android's back button goes back through the browser history: every opened screen is an
  // entry, so back closes the top screen instead of leaving the app.
  useEffect(() => {
    const onPop = () => {
      if (depth.current > 0) {
        depth.current--;
        dispatch({ type: "pop" });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const sync = useCallback<MobileContext["sync"]>(
    async (opts = {}) => {
      setSyncing(true);
      try {
        const out = await mobileApi.sync(opts.allowDeletions ?? false);
        lastSync.current = Date.now();
        if (!opts.quiet) toast("success", t("mob.set.synced"), out.message);
        refresh();
        return true;
      } catch (e) {
        if (!opts.quiet) toast("error", t("mob.today.syncFailed"), errorText(e));
        refresh();
        return false;
      } finally {
        setSyncing(false);
      }
    },
    [toast, refresh],
  );

  // Back in front: sync (at most every two minutes) and show fresh numbers.
  const gs = view?.settings.git_sync;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      if (gs?.enabled && gs.remote_url.trim() && syncDue(lastSync.current, Date.now())) void sync({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [gs?.enabled, gs?.remote_url, sync, refresh]);

  const ctx = useMemo<MobileContext | null>(() => {
    if (!view) return null;
    return {
      view,
      settings: view.settings,
      version,
      refresh,
      toast,
      syncing,
      sync,
      open: (s) => {
        depth.current++;
        window.history.pushState({ arcalo: depth.current }, "");
        dispatch({ type: "push", screen: s });
      },
      back: () => {
        if (depth.current > 0) window.history.back();
      },
      tab: (tab) => {
        // Screens above the tabs close with a tab: their history entries go too.
        if (depth.current > 0) {
          const n = depth.current;
          depth.current = 0;
          window.history.go(-n);
        }
        dispatch({ type: "tab", tab });
      },
      saveSettings: async (next: Settings) => {
        const saved = await mobileApi.saveSettings(next);
        applyPrefs(saved.settings);
        setView(saved);
      },
    };
  }, [view, version, refresh, toast, syncing, sync]);

  if (!ctx) {
    return (
      <div className="m-app m-boot">
        {failed ? (
          <div className="m-empty">
            <p>{t("mob.offline", { msg: failed })}</p>
            <button type="button" className="m-btn" onClick={() => void loadSettings()}>
              {t("mob.retry")}
            </button>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  const screen = current(route);
  const onTab = typeof screen === "string";
  return (
    <Ctx.Provider value={ctx}>
      <div className={onTab ? "m-app" : "m-app m-app-stacked"} data-screen={typeof screen === "string" ? screen : screen.kind}>
        <main className="m-main">
          {screen === "today" && <TodayScreen />}
          {screen === "tasks" && <TasksScreen />}
          {screen === "time" && <TimeScreen />}
          {screen === "notes" && <NotesScreen />}
          {typeof screen !== "string" && screen.kind === "capture" && <CaptureScreen key={screen.mode} mode={screen.mode} />}
          {typeof screen !== "string" && screen.kind === "daily" && <DailyScreen key={screen.date} date={screen.date} />}
          {typeof screen !== "string" && screen.kind === "page" && <PageScreen key={screen.id} id={screen.id} />}
          {typeof screen !== "string" && screen.kind === "settings" && <SettingsScreen />}
        </main>
        {onTab && <TabBar tab={route.tab} />}
        <div className="m-toasts" aria-live="polite">
          {toasts.map((x) => (
            <div key={x.id} className={`m-toast m-toast-${x.tone}`} role={x.tone === "error" ? "alert" : "status"}>
              <span className="m-toast-icon">{x.tone === "error" ? <TriangleAlert size={18} /> : x.tone === "success" ? <CircleCheck size={18} /> : <Info size={18} />}</span>
              <span className="m-toast-text">
                <span className="m-toast-title">{x.title}</span>
                {x.detail && <span className="m-toast-detail">{x.detail}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Ctx.Provider>
  );
}

function TabBar({ tab }: { tab: Tab }) {
  const m = useMobile();
  const item = (id: Tab) => {
    const Icon = TAB_ICONS[id];
    return (
      <button key={id} type="button" className={id === tab ? "m-tab on" : "m-tab"} aria-current={id === tab ? "page" : undefined} onClick={() => m.tab(id)}>
        <span className="m-tab-icon">
          <Icon size={22} />
        </span>
        <span>{t(TAB_LABELS[id])}</span>
      </button>
    );
  };
  return (
    <nav className="m-tabbar" aria-label={t("mob.nav")}>
      {item("today")}
      {item("tasks")}
      <button type="button" className="m-tab m-tab-capture" onClick={() => m.open({ kind: "capture", mode: "note" })} aria-label={t("mob.cap.title")}>
        <span className="m-tab-icon m-capture-btn-primary">
          <Plus size={24} />
        </span>
        <span>{t("mob.tab.capture")}</span>
      </button>
      {item("time")}
      {item("notes")}
    </nav>
  );
}
