// The shell of the Android companion app: four tabs and a capture button at the bottom,
// screens opened above them, toasts, Android's back button, the app's own updates, text shared
// from other apps, the colors behind the system bars, and the sync when the app comes back to
// the front.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { CircleCheck, Clock, FileText, Info, ListChecks, Plus, Sun, TriangleAlert } from "lucide-react";
import "../styles/mobile.css";
import { applyPrefs } from "../lib/prefs";
import { applyThemeState } from "../lib/themes";
import { t, useT, type TKey } from "../lib/i18n";
import type { Settings, SettingsView } from "../lib/types";
import { mobileApi, type UpdateStatus } from "./api";
import { Ctx, errorText, useMobile, type MobileContext, type Toast, type ToastTone } from "./context";
import { START, backAction, cssHex, current, navigate, syncDue, type Tab } from "./model";
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
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [installBlocked, setInstallBlocked] = useState(false);
  const lastSync = useRef<number | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  // What the back button closes before it leaves a screen (an edit mode), last one first.
  const layers = useRef<(() => void)[]>([]);

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
      listen<UpdateStatus>("apkupdate://status", (e) => setUpdate(e.payload)),
    ];
    mobileApi.update
      .status()
      .then((s) => s && setUpdate(s))
      .catch(() => {});
    return () => offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
  }, [refresh, loadSettings]);

  // „Wie das System“: the theme follows Android's dark mode while the app runs.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeState({});
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const onBack = useCallback((close: () => void) => {
    layers.current.push(close);
    return () => {
      layers.current = layers.current.filter((c) => c !== close);
    };
  }, []);

  // Android's back button: an edit mode first, then the top screen, then „Heute“; on „Heute“
  // the app goes to the background (it never quits from here).
  useEffect(() => {
    const listener = onBackButtonPress(() => {
      switch (backAction(routeRef.current, layers.current.length)) {
        case "layer":
          layers.current[layers.current.length - 1]();
          break;
        case "pop":
          dispatch({ type: "pop" });
          break;
        case "today":
          dispatch({ type: "tab", tab: "today" });
          break;
        case "background":
          void mobileApi.toBackground().catch(() => {});
      }
    });
    return () => void listener.then((l) => l.unregister()).catch(() => {});
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

  // Text shared from another app („Teilen“ → Arcalo) opens a capture with it.
  const takeShared = useCallback(() => {
    mobileApi
      .sharedText()
      .then((text) => text && dispatch({ type: "push", screen: { kind: "capture", mode: "note", text } }))
      .catch(() => {});
  }, []);
  const ready = !!view;
  useEffect(() => {
    if (ready) takeShared();
  }, [ready, takeShared]);

  // Back in front: sync (at most every two minutes), show fresh numbers, take shared text.
  const gs = view?.settings.git_sync;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      refresh();
      takeShared();
      if (gs?.enabled && gs.remote_url.trim() && syncDue(lastSync.current, Date.now())) void sync({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [gs?.enabled, gs?.remote_url, sync, refresh, takeShared]);

  // The window behind the status and navigation bars has the colors of the header and of the
  // tab bar (or of the screen, on a screen without tab bar), in every theme.
  const screen = current(route);
  const onTab = typeof screen === "string";
  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const app = document.querySelector(".m-app");
        const bar = document.querySelector(".m-tabbar");
        const top = app && cssHex(getComputedStyle(app).backgroundColor);
        const bottom = (bar && cssHex(getComputedStyle(bar).backgroundColor)) || top;
        if (top && bottom) void mobileApi.bars(document.documentElement.dataset.theme === "dark", top, bottom).catch(() => {});
      });
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-id"] });
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ready, onTab]);

  const installUpdate = useCallback(async () => {
    try {
      const out = await mobileApi.update.install();
      setInstallBlocked(out === "needs_permission");
    } catch (e) {
      toast("error", t("mob.upd.failed"), errorText(e));
    }
  }, [toast]);

  const allowInstall = useCallback(async () => {
    try {
      if (await mobileApi.update.allowInstall()) {
        setInstallBlocked(false);
        await installUpdate();
      } else {
        toast("info", t("mob.upd.permissionDenied"));
      }
    } catch (e) {
      toast("error", t("mob.upd.failed"), errorText(e));
    }
  }, [installUpdate, toast]);

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
      open: (s) => dispatch({ type: "push", screen: s }),
      back: () => dispatch({ type: "pop" }),
      tab: (tab) => dispatch({ type: "tab", tab }),
      saveSettings: async (next: Settings) => {
        const saved = await mobileApi.saveSettings(next);
        applyPrefs(saved.settings);
        setView(saved);
      },
      update,
      setUpdate,
      installBlocked,
      installUpdate,
      allowInstall,
      onBack,
    };
  }, [view, version, refresh, toast, syncing, sync, update, installBlocked, installUpdate, allowInstall, onBack]);

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

  return (
    <Ctx.Provider value={ctx}>
      <div className={onTab ? "m-app" : "m-app m-app-stacked"} data-screen={typeof screen === "string" ? screen : screen.kind}>
        <main className="m-main">
          {screen === "today" && <TodayScreen />}
          {screen === "tasks" && <TasksScreen />}
          {screen === "time" && <TimeScreen />}
          {screen === "notes" && <NotesScreen />}
          {typeof screen !== "string" && screen.kind === "capture" && <CaptureScreen key={`${screen.mode}:${screen.text ?? ""}`} mode={screen.mode} text={screen.text} />}
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
        <span className="m-tab-label">{t(TAB_LABELS[id])}</span>
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
        <span className="m-tab-label">{t("mob.tab.capture")}</span>
      </button>
      {item("time")}
      {item("notes")}
    </nav>
  );
}
