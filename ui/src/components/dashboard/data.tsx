// Data of the start page: the parts of every widget in view, loaded in one `dashboard_data`
// call (several widgets with the same settings share a part), kept while they reload, and
// reloaded when what they show changes (time entries, tasks, pages, calendar sync, focus,
// WBS, a Git sync). Widgets scrolled out of view load when they come into view. Widgets that
// load something else (a status, an outside service) use `useLazyData`, which follows the same
// rules.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { api, on } from "../../lib/api";
import { isoDay } from "../../lib/format";
import { partKey, partsOf, partTopics, type DataTopic, type Part } from "../../lib/dashboard";
import { useApp } from "../../store/app";
import { useTimeTracking } from "../../lib/timetracking";
import type { GridWidget } from "../../lib/types";

export interface Entry {
  data?: unknown;
  error?: string;
}

interface Ctx {
  entry: (key: string) => Entry | undefined;
  /** Reloads the parts showing `topics` (all without). */
  refresh: (topics?: DataTopic[]) => void;
  today: Date;
  /** Whether widget `id` is (or was) in view: lazy data loads only then. */
  inView: (id: string) => boolean;
  /** Counts the changes per topic (for `useLazyData`). */
  versions: Partial<Record<DataTopic, number>>;
}

const DataContext = createContext<Ctx>({ entry: () => undefined, refresh: () => {}, today: new Date(), inView: () => true, versions: {} });

/** Timing of the last load: backend time and the time from the answer to the painted grid. */
export interface DashPerf {
  backendMs: number;
  /** From the call to its answer (backend and IPC). */
  roundTripMs: number;
  /** From the answer to the committed grid … */
  commitMs: number;
  /** … and to the next painted frame. */
  renderMs: number;
  parts: number;
}

declare global {
  interface Window {
    __arcaloDashPerf?: DashPerf[];
  }
}

/** The local day, renewed after midnight. */
function useToday(): Date {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = new Date();
      if (isoDay(now) !== isoDay(today)) setToday(now);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [today]);
  return today;
}

export function DashData({ widgets, seen, children }: { widgets: GridWidget[]; seen: Set<string>; children: ReactNode }) {
  const today = useToday();
  const workdays = useApp((s) => s.settings?.settings.workdays);
  const timeOn = useTimeTracking();
  const [store, setStore] = useState<Map<string, Entry>>(() => new Map());
  const storeRef = useRef(store);
  storeRef.current = store;
  const stale = useRef(new Set<string>());
  const inflight = useRef(new Set<string>());
  const pending = useRef<{ t0: number; arrived: number; backend: number; parts: number } | null>(null);

  // The parts of the widgets in view, by key.
  const wanted = useMemo(() => {
    const m = new Map<string, Part>();
    for (const w of widgets) {
      if (!seen.has(w.id)) continue;
      for (const p of partsOf(w, today, workdays ?? [1, 2, 3, 4, 5], timeOn)) m.set(partKey(p), p);
    }
    return m;
  }, [widgets, seen, today, workdays, timeOn]);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const todo = [...wantedRef.current].filter(([k]) => !inflight.current.has(k) && (!storeRef.current.has(k) || stale.current.has(k)));
    if (!todo.length) return;
    todo.forEach(([k]) => {
      inflight.current.add(k);
      stale.current.delete(k);
    });
    const t0 = performance.now();
    try {
      const res = await api.dashboardData(isoDay(today), todo.map(([key, part]) => ({ key, part })));
      pending.current = { t0, arrived: performance.now(), backend: res.ms, parts: todo.length };
      // Rendered right away, in this task: a scheduled render waits for the next frame, and a
      // frame while the window still paints a lot (the start, an animation) takes 50–100 ms.
      flushSync(() =>
        setStore((prev) => {
          const next = new Map(prev);
          for (const [k] of todo) {
            const v = res.parts[k] as { error?: string } | undefined;
            next.set(k, v && typeof v === "object" && !Array.isArray(v) && typeof v.error === "string" && Object.keys(v).length === 1 ? { error: v.error } : { data: v });
          }
          return next;
        }),
      );
    } catch (e) {
      setStore((prev) => {
        const next = new Map(prev);
        for (const [k] of todo) next.set(k, { ...prev.get(k), error: String(e) });
        return next;
      });
    } finally {
      todo.forEach(([k]) => inflight.current.delete(k));
      // Something changed meanwhile: load again.
      if (todo.some(([k]) => stale.current.has(k))) setTick((x) => x + 1);
    }
  }, [today]);

  useEffect(() => {
    // One call for everything that became wanted in this render.
    const id = window.setTimeout(load, 0);
    return () => window.clearTimeout(id);
  }, [wanted, tick, load]);

  // Timing, measured once the grid with the new data is committed and painted.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const committed = performance.now();
    requestAnimationFrame(() => {
      const list = (window.__arcaloDashPerf ??= []);
      list.push({ backendMs: p.backend, roundTripMs: p.arrived - p.t0, commitMs: committed - p.arrived, renderMs: performance.now() - p.arrived, parts: p.parts });
      if (list.length > 50) list.shift();
    });
  }, [store]);

  const [versions, setVersions] = useState<Partial<Record<DataTopic, number>>>({});
  const refresh = useCallback((topics?: DataTopic[]) => {
    setVersions((v) => {
      const next = { ...v };
      for (const tp of topics ?? (["entries", "tasks", "pages", "calendar", "focus", "wbs", "sync"] as DataTopic[])) next[tp] = (next[tp] ?? 0) + 1;
      return next;
    });
    const drop: string[] = [];
    for (const k of storeRef.current.keys()) {
      const part = JSON.parse(k) as Part;
      if (topics && !partTopics(part).some((tp) => topics.includes(tp))) continue;
      if (wantedRef.current.has(k)) stale.current.add(k);
      else drop.push(k);
    }
    if (drop.length)
      setStore((prev) => {
        const next = new Map(prev);
        drop.forEach((k) => next.delete(k));
        return next;
      });
    setTick((x) => x + 1);
  }, []);

  // Changes elsewhere, batched: a save often sends several events at once.
  const queued = useRef(new Set<DataTopic>());
  const timer = useRef<number | null>(null);
  const soon = useCallback(
    (topics: DataTopic[], delay = 150) => {
      topics.forEach((tp) => queued.current.add(tp));
      if (timer.current != null) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const list = [...queued.current];
        queued.current.clear();
        refresh(list);
      }, delay);
    },
    [refresh],
  );
  useEffect(() => {
    const subs: [string, DataTopic[]][] = [
      ["data://entries", ["entries"]],
      ["data://tasks", ["tasks", "pages"]],
      ["data://pages", ["pages", "tasks"]],
      ["calendar://synced", ["calendar"]],
      ["focus://changed", ["focus", "entries"]],
      ["focus://completed", ["focus", "entries"]],
      ["gitsync://done", ["sync"]],
      ["gitsync://failed", ["sync"]],
      ["gitsync://pulled", ["sync", "pages"]],
      ["backup://failed", ["sync"]],
      ["backup://destinations", ["sync"]],
      ["data://absences", ["absences"]],
    ];
    const un = subs.map(([ev, topics]) => on(ev, () => soon(topics)));
    const saved = () => soon(["pages", "tasks"], 600);
    window.addEventListener("arcalo:page-saved", saved);
    return () => {
      un.forEach((u) => u.then((f) => f()));
      window.removeEventListener("arcalo:page-saved", saved);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [soon]);
  const entriesVersion = useApp((s) => s.entriesVersion);
  const wbsVersion = useApp((s) => s.wbsVersion);
  const pages = useApp((s) => s.pages);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) return;
    soon(["entries"]);
  }, [entriesVersion, soon]);
  useEffect(() => {
    if (first.current) return;
    soon(["wbs"]);
  }, [wbsVersion, soon]);
  useEffect(() => {
    if (first.current) return;
    soon(["pages", "tasks"], 400);
  }, [pages, soon]);
  useEffect(() => {
    first.current = false;
  }, []);

  const value = useMemo<Ctx>(() => ({ entry: (k) => store.get(k), refresh, today, inView: (id) => seen.has(id), versions }), [store, refresh, today, seen, versions]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export const useDash = () => useContext(DataContext);

/** Part `index` of a widget: its data (kept while it reloads), an error, or neither while loading. */
export function useWidgetData<T>(w: Pick<GridWidget, "kind" | "config">, index = 0): { data: T | undefined; error: string | undefined; loading: boolean } {
  const { entry, today } = useDash();
  const workdays = useApp((s) => s.settings?.settings.workdays);
  const timeOn = useTimeTracking();
  const part = partsOf(w, today, workdays ?? [1, 2, 3, 4, 5], timeOn)[index];
  const e = part ? entry(partKey(part)) : undefined;
  return { data: e?.data as T | undefined, error: e?.error, loading: !!part && !e };
}

export interface LazyData<T> {
  data: T | undefined;
  error: string | undefined;
  /** Nothing loaded yet. */
  loading: boolean;
  /** Loads again now. */
  reload: () => void;
}

/**
 * Data a widget loads itself (not through `dashboard_data`): `load` runs once the widget is in
 * view, again when one of `topics` changes, every `every` ms while it shows, and when `key`
 * changes (e.g. the settings it depends on). The last data stays while it reloads.
 */
export function useLazyData<T>(widgetId: string, load: () => Promise<T>, opts: { key?: string; topics?: DataTopic[]; every?: number } = {}): LazyData<T> {
  const { inView, versions } = useDash();
  const visible = inView(widgetId);
  const [state, setState] = useState<{ data?: T; error?: string; done: boolean }>({ done: false });
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const version = (opts.topics ?? []).map((tp) => versions[tp] ?? 0).join(".");
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    loader.current().then(
      (data) => alive && setState({ data, done: true }),
      (e) => alive && setState((prev) => ({ ...prev, error: String(e), done: true })),
    );
    return () => {
      alive = false;
    };
  }, [visible, version, tick, opts.key]);
  useEffect(() => {
    if (!visible || !opts.every) return;
    const id = window.setInterval(() => setTick((x) => x + 1), opts.every);
    return () => window.clearInterval(id);
  }, [visible, opts.every]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { data: state.data, error: state.data === undefined ? state.error : undefined, loading: !state.done, reload };
}
