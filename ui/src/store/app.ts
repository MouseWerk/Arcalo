// Global UI state: tabs, panels, cached workspace data, timer and toasts.

import { create } from "zustand";
import { api, errorText } from "../lib/api";
import { logUi } from "../lib/devlog";
import type { BudgetStatus, FocusState, PageDoc, PageNode, SessionMeter, SettingsView, TimerStatus } from "../lib/types";
import { applyPrefs } from "../lib/prefs";

export type TabKind = "home" | "page" | "timesheet" | "projects" | "settings" | "tag" | "trash" | "tasks" | "activity";
/** A place a tab can show. */
export interface Loc {
  kind: TabKind;
  pageId?: number;
  tag?: string;
}
export interface Tab extends Loc {
  id: string;
  /** Navigation history of this tab (Obsidian-style back/forward). */
  back: Loc[];
  forward: Loc[];
}
/** A group of tabs shown side by side with other panes (split view). */
export interface Pane {
  id: string;
  tabs: Tab[];
  activeTabId: string;
}
export type PanelTab = "assistant" | "outline" | "links";

export interface Toast {
  id: number;
  tone: "info" | "success" | "warning" | "danger";
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
  /** Stays until closed. */
  persistent?: boolean;
  /** Shown even during a focus session (the session's own messages). */
  urgent?: boolean;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Label of the cancel button (default „Abbrechen“). */
  cancelLabel?: string;
  /** Optional third button between Abbrechen and the confirm button. */
  altLabel?: string;
  danger: boolean;
  resolve: (choice: ConfirmChoice) => void;
}
export type ConfirmChoice = "confirm" | "alt" | "cancel";
type ConfirmOpts = { title: string; message: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };

/** A preset request for the assistant (e.g. the weekly report). */
export interface PendingAsk {
  text: string;
  /** Title for „In neue Seite einfügen“ on the answer. */
  pageTitle?: string;
  /** Offer the tools even if the user switched them off. */
  tools?: boolean;
  /** Shown as the user's message instead of the (internal) prompt text. */
  display?: string;
}

interface State {
  confirmRequest: ConfirmRequest | null;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  /** Three-way dialog: confirm, alternative, or cancel. */
  choose: (opts: ConfirmOpts & { altLabel: string }) => Promise<ConfirmChoice>;
  /** Tabs and active tab of the focused pane (mirrors `panes`). */
  tabs: Tab[];
  activeTabId: string;
  panes: Pane[];
  activePaneId: string;
  /** Relative widths of the panes (sum 1). */
  paneSizes: number[];
  tree: PageNode[];
  pages: Map<number, PageNode>;
  sidebarOpen: boolean;
  panelOpen: boolean;
  panelTab: PanelTab;
  paletteOpen: boolean;
  paletteQuery: string;
  paletteMode: "all" | "pages";
  /** Daily-note calendar: open at a point (below a button), or centered when x/y are missing. */
  calendar: CalendarAnchor | null;
  timer: TimerStatus | null;
  meter: SessionMeter | null;
  settings: SettingsView | null;
  /** Bumped whenever time entries change so views can refetch. */
  entriesVersion: number;
  /** Bumped whenever the WBS (projects, Netzpläne, Vorgänge) changes. */
  wbsVersion: number;
  /** The document shown in the active page tab (outline and backlinks read it). */
  activeDoc: PageDoc | null;
  /** Headings of the active editor for the outline panel. */
  outline: { level: number; text: string; pos: number }[];
  scrollToPos: ((pos: number) => void) | null;
  /** Word and character count of the focused editor. */
  editorStats: { words: number; chars: number } | null;
  toasts: Toast[];
  focusMode: boolean;
  /** First start: show the welcome choice instead of the start page. */
  onboarding: boolean;
  /** Question from the palette, consumed by the assistant panel once it is mounted. */
  pendingAsk: string | PendingAsk | null;
  /** The focus session (work phase or break), null without. */
  focus: FocusState | null;
  /** Toasts held back during a focus session, shown as a summary afterwards. */
  heldToasts: Omit<Toast, "id">[];
  /** The focus dialog is open (with a preset Vorgang and goal). */
  focusDialog: { reference?: string; goal?: string } | null;
  /** The page shown as a presentation. */
  presenting: { pageId: number } | null;

  openTab: (loc: Loc, opts?: OpenOpts) => void;
  openPage: (pageId: number, opts?: OpenOpts) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  focusPane: (paneId: string) => void;
  goBack: () => void;
  goForward: () => void;
  splitTab: (tabId: string) => void;
  moveTab: (tabId: string, toPaneId: string, index: number) => void;
  /** A copy of the tab (same place, fresh history) right after it. */
  duplicateTab: (tabId: string) => void;
  closeOthers: (tabId: string) => void;
  setPaneSizes: (sizes: number[]) => void;
  refreshTree: () => Promise<void>;
  refreshTimer: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  bumpEntries: () => void;
  bumpWbs: () => void;
  set: (patch: Partial<State>) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  error: (title: string, e: unknown) => void;
  alerts: (alerts: BudgetStatus[]) => void;
}

export interface CalendarAnchor {
  x?: number;
  y?: number;
  /** Month and day to show first (YYYY-MM-DD); default today. */
  date?: string;
  /** Date picker: a chosen day is handed here instead of opening its daily note. */
  onPick?: (iso: string) => void;
}

export interface OpenOpts {
  /** Open in a new tab instead of navigating the current one (Ctrl+click). */
  newTab?: boolean;
  /** Open in the pane to the right, creating it if needed (Ctrl+Alt+click). */
  split?: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10);
const MAX_PANES = 3;
const sameLoc = (a: Loc, b: Loc) => a.kind === b.kind && a.pageId === b.pageId && a.tag === b.tag;
const locOf = (t: Tab): Loc => ({ kind: t.kind, pageId: t.pageId, tag: t.tag });
const newTab = (loc: Loc): Tab => ({ ...loc, id: uid(), back: [], forward: [] });

interface Layout {
  panes: Pane[];
  activePaneId: string;
  paneSizes: number[];
}

function loadLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem("annalo.layout") ?? "null");
    if (raw?.panes?.length) {
      const panes: Pane[] = raw.panes.map((p: Pane) => ({ ...p, tabs: p.tabs.map((t) => ({ ...t, back: t.back ?? [], forward: t.forward ?? [] })) }));
      return { panes, activePaneId: raw.activePaneId ?? panes[0].id, paneSizes: raw.paneSizes?.length === panes.length ? raw.paneSizes : panes.map(() => 1 / panes.length) };
    }
    // Older single-pane format.
    const old = JSON.parse(localStorage.getItem("annalo.tabs") ?? "null");
    if (old?.tabs?.length) {
      const pane = { id: uid(), tabs: old.tabs.map((t: Tab) => ({ ...t, back: [], forward: [] })), activeTabId: old.active ?? old.tabs[0].id };
      return { panes: [pane], activePaneId: pane.id, paneSizes: [1] };
    }
  } catch {
    /* ignore */
  }
  const pane = { id: uid(), tabs: [], activeTabId: "" };
  return { panes: [pane], activePaneId: pane.id, paneSizes: [1] };
}
function saveLayout(l: Layout) {
  try {
    localStorage.setItem("annalo.layout", JSON.stringify(l));
  } catch {
    /* ignore */
  }
}

/** Applies a new pane layout and mirrors the focused pane into `tabs`/`activeTabId`. */
function layoutPatch(panes: Pane[], activePaneId: string, paneSizes: number[]) {
  // Remove empty panes, but always keep one.
  const kept = panes.filter((p) => p.tabs.length > 0);
  let sizes = paneSizes;
  if (kept.length !== panes.length) {
    const keptIdx = panes.map((p, i) => (p.tabs.length > 0 ? i : -1)).filter((i) => i >= 0);
    sizes = keptIdx.map((i) => paneSizes[i] ?? 1);
    if (!kept.length) {
      kept.push(panes.find((p) => p.id === activePaneId) ?? panes[0]);
      sizes = [1];
    }
  }
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  sizes = sizes.map((x) => x / total);
  const active = kept.find((p) => p.id === activePaneId) ?? kept[kept.length - 1];
  const layout = { panes: kept, activePaneId: active.id, paneSizes: sizes };
  saveLayout(layout);
  return { ...layout, tabs: active.tabs, activeTabId: active.activeTabId };
}
function pref(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
export function savePref(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const initial = loadLayout();
const initialPane = initial.panes.find((p) => p.id === initial.activePaneId) ?? initial.panes[0];
let toastSeq = 0;

export const useApp = create<State>((set, get) => ({
  confirmRequest: null,
  confirm: async (opts) => (await get().choose({ ...opts, altLabel: "" })) === "confirm",
  choose: (opts) =>
    new Promise<ConfirmChoice>((resolve) =>
      set({
        confirmRequest: {
          title: opts.title,
          message: opts.message,
          confirmLabel: opts.confirmLabel ?? "Bestätigen",
          cancelLabel: opts.cancelLabel,
          altLabel: opts.altLabel || undefined,
          danger: opts.danger ?? false,
          resolve: (choice) => {
            set({ confirmRequest: null });
            resolve(choice);
          },
        },
      }),
    ),
  tabs: initialPane.tabs,
  activeTabId: initialPane.activeTabId,
  panes: initial.panes,
  activePaneId: initialPane.id,
  paneSizes: initial.paneSizes,
  tree: [],
  pages: new Map(),
  sidebarOpen: pref("annalo.sidebar", true),
  panelOpen: pref("annalo.panel", true),
  panelTab: "assistant",
  paletteOpen: false,
  paletteQuery: "",
  paletteMode: "all",
  calendar: null,
  timer: null,
  meter: null,
  settings: null,
  entriesVersion: 0,
  wbsVersion: 0,
  activeDoc: null,
  outline: [],
  scrollToPos: null,
  editorStats: null,
  toasts: [],
  focusMode: false,
  onboarding: false,
  pendingAsk: null,
  focus: null,
  heldToasts: [],
  focusDialog: null,
  presenting: null,

  openTab: (loc, opts) => {
    const { panes, activePaneId, paneSizes } = get();
    // Already open somewhere? Focus it (unless a split was requested).
    if (!opts?.split) {
      for (const p of panes) {
        const t = p.tabs.find((x) => sameLoc(x, loc));
        if (t && (p.id === activePaneId || !opts?.newTab)) {
          const next = panes.map((q) => (q.id === p.id ? { ...q, activeTabId: t.id } : q));
          set(layoutPatch(next, p.id, paneSizes));
          return;
        }
      }
    }
    if (opts?.split) {
      const idx = panes.findIndex((p) => p.id === activePaneId);
      const target = panes[idx + 1];
      if (target) {
        const tab = newTab(loc);
        const next = panes.map((p) => (p.id === target.id ? { ...p, tabs: [...p.tabs, tab], activeTabId: tab.id } : p));
        set(layoutPatch(next, target.id, paneSizes));
      } else if (panes.length < MAX_PANES) {
        const tab = newTab(loc);
        const pane: Pane = { id: uid(), tabs: [tab], activeTabId: tab.id };
        const next = [...panes.slice(0, idx + 1), pane, ...panes.slice(idx + 1)];
        const sizes = next.map(() => 1 / next.length);
        set(layoutPatch(next, pane.id, sizes));
      } else {
        get().openTab(loc, { newTab: true });
      }
      return;
    }
    const pane = panes.find((p) => p.id === activePaneId)!;
    const current = pane.tabs.find((t) => t.id === pane.activeTabId);
    let tabs: Tab[];
    let activeId: string;
    if (opts?.newTab || !current) {
      const tab = newTab(loc);
      const idx = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
      tabs = [...pane.tabs.slice(0, idx + 1), tab, ...pane.tabs.slice(idx + 1)];
      activeId = tab.id;
    } else {
      // Navigate the current tab and remember where we came from.
      const moved: Tab = { ...current, ...loc, pageId: loc.pageId, tag: loc.tag, back: [...current.back, locOf(current)].slice(-50), forward: [] };
      tabs = pane.tabs.map((t) => (t.id === current.id ? moved : t));
      activeId = current.id;
    }
    const next = panes.map((p) => (p.id === pane.id ? { ...p, tabs, activeTabId: activeId } : p));
    set(layoutPatch(next, pane.id, paneSizes));
  },
  openPage: (pageId, opts) => get().openTab({ kind: "page", pageId }, opts),
  closeTab: (id) => {
    const { panes, activePaneId, paneSizes } = get();
    const pane = panes.find((p) => p.tabs.some((t) => t.id === id));
    if (!pane) return;
    const idx = pane.tabs.findIndex((t) => t.id === id);
    const tabs = pane.tabs.filter((t) => t.id !== id);
    const activeTabId = id === pane.activeTabId ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? "") : pane.activeTabId;
    const next = panes.map((p) => (p.id === pane.id ? { ...p, tabs, activeTabId } : p));
    set(layoutPatch(next, tabs.length ? pane.id : activePaneId === pane.id ? (panes.find((p) => p.id !== pane.id)?.id ?? pane.id) : activePaneId, paneSizes));
  },
  activateTab: (id) => {
    const { panes, paneSizes } = get();
    const pane = panes.find((p) => p.tabs.some((t) => t.id === id));
    if (!pane) return;
    const next = panes.map((p) => (p.id === pane.id ? { ...p, activeTabId: id } : p));
    set(layoutPatch(next, pane.id, paneSizes));
  },
  focusPane: (paneId) => {
    const { panes, paneSizes, activePaneId } = get();
    if (paneId !== activePaneId) set(layoutPatch(panes, paneId, paneSizes));
  },
  goBack: () => {
    const { panes, activePaneId, paneSizes } = get();
    const pane = panes.find((p) => p.id === activePaneId)!;
    const t = pane.tabs.find((x) => x.id === pane.activeTabId);
    if (!t?.back.length) return;
    const to = t.back[t.back.length - 1];
    const moved: Tab = { ...t, kind: to.kind, pageId: to.pageId, tag: to.tag, back: t.back.slice(0, -1), forward: [locOf(t), ...t.forward] };
    set(layoutPatch(panes.map((p) => (p.id === pane.id ? { ...p, tabs: p.tabs.map((x) => (x.id === t.id ? moved : x)) } : p)), pane.id, paneSizes));
  },
  goForward: () => {
    const { panes, activePaneId, paneSizes } = get();
    const pane = panes.find((p) => p.id === activePaneId)!;
    const t = pane.tabs.find((x) => x.id === pane.activeTabId);
    if (!t?.forward.length) return;
    const to = t.forward[0];
    const moved: Tab = { ...t, kind: to.kind, pageId: to.pageId, tag: to.tag, back: [...t.back, locOf(t)], forward: t.forward.slice(1) };
    set(layoutPatch(panes.map((p) => (p.id === pane.id ? { ...p, tabs: p.tabs.map((x) => (x.id === t.id ? moved : x)) } : p)), pane.id, paneSizes));
  },
  splitTab: (tabId) => {
    const { panes } = get();
    const pane = panes.find((p) => p.tabs.some((t) => t.id === tabId));
    const t = pane?.tabs.find((x) => x.id === tabId);
    if (!pane || !t) return;
    get().focusPane(pane.id);
    get().openTab(locOf(t), { split: true });
  },
  moveTab: (tabId, toPaneId, index) => {
    const { panes, paneSizes } = get();
    const from = panes.find((p) => p.tabs.some((t) => t.id === tabId));
    const tab = from?.tabs.find((t) => t.id === tabId);
    if (!from || !tab) return;
    const next = panes.map((p) => {
      let tabs = p.tabs.filter((t) => t.id !== tabId);
      if (p.id === toPaneId) {
        const at = Math.max(0, Math.min(index - (p.id === from.id && p.tabs.findIndex((t) => t.id === tabId) < index ? 1 : 0), tabs.length));
        tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
        return { ...p, tabs, activeTabId: tab.id };
      }
      const activeTabId = p.activeTabId === tabId ? (tabs[0]?.id ?? "") : p.activeTabId;
      return { ...p, tabs, activeTabId };
    });
    set(layoutPatch(next, toPaneId, paneSizes));
  },
  duplicateTab: (tabId) => {
    const { panes, paneSizes } = get();
    const pane = panes.find((p) => p.tabs.some((t) => t.id === tabId));
    const i = pane?.tabs.findIndex((t) => t.id === tabId) ?? -1;
    if (!pane || i < 0) return;
    const copy = newTab(locOf(pane.tabs[i]));
    const next = panes.map((p) => (p.id === pane.id ? { ...p, tabs: [...p.tabs.slice(0, i + 1), copy, ...p.tabs.slice(i + 1)], activeTabId: copy.id } : p));
    set(layoutPatch(next, pane.id, paneSizes));
  },
  closeOthers: (tabId) => {
    const { panes, paneSizes } = get();
    const pane = panes.find((p) => p.tabs.some((t) => t.id === tabId));
    if (!pane) return;
    const next = panes.map((p) => (p.id === pane.id ? { ...p, tabs: p.tabs.filter((t) => t.id === tabId), activeTabId: tabId } : p));
    set(layoutPatch(next, pane.id, paneSizes));
  },
  setPaneSizes: (sizes) => {
    const { panes, activePaneId } = get();
    set(layoutPatch(panes, activePaneId, sizes));
  },
  refreshTree: async () => {
    const tree = await api.tree();
    const pages = new Map<number, PageNode>();
    const walk = (list: PageNode[]) => list.forEach((p) => (pages.set(p.id, p), walk(p.children)));
    walk(tree);
    // Drop tabs of deleted pages and history entries pointing to them.
    const alive = (l: Loc) => l.kind !== "page" || pages.has(l.pageId!);
    const panes = get().panes.map((p) => {
      const tabs = p.tabs.filter(alive).map((t) => ({ ...t, back: t.back.filter(alive), forward: t.forward.filter(alive) }));
      const activeTabId = tabs.some((t) => t.id === p.activeTabId) ? p.activeTabId : (tabs[tabs.length - 1]?.id ?? "");
      return { ...p, tabs, activeTabId };
    });
    set({ tree, pages, ...layoutPatch(panes, get().activePaneId, get().paneSizes) });
  },
  refreshTimer: async () => set({ timer: await api.timerStatus() }),
  refreshSettings: async () => set({ settings: await api.settings() }),
  bumpEntries: () => {
    set({ entriesVersion: get().entriesVersion + 1 });
    get().refreshTimer();
  },
  bumpWbs: () => set({ wbsVersion: get().wbsVersion + 1 }),
  set: (patch) => set(patch),
  toast: (t) => {
    // Focus session: everything but errors waits for the end of the session.
    if (get().focus?.phase === "work" && !t.urgent && t.tone !== "danger") {
      set({ heldToasts: [...get().heldToasts, t].slice(-50) });
      return;
    }
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { ...t, id }].filter((x, i, all) => x.persistent || i >= all.length - 3) });
    const ms = t.tone === "danger" ? 8000 : t.action ? 7000 : t.tone === "success" ? 3200 : 4500;
    if (!t.persistent) setTimeout(() => get().dismissToast(id), ms);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  error: (title, e) => {
    const detail = errorText(e);
    logUi("ERROR", `${title}: ${detail}`);
    get().toast({ tone: "danger", title, detail });
  },
  alerts: (alerts) => {
    // Settings → Benachrichtigungen.
    if (get().settings?.settings.notifications?.budget === false) return;
    // Focus session: budget alerts wait for its end like other messages.
    const hold = get().focus?.phase === "work";
    for (const a of alerts) {
      const pct = Math.round(a.consumed * 100);
      const title =
        a.level === "exceeded" ? `Budget überschritten: ${a.label}` : a.level === "critical" ? `Budget kritisch: ${a.label}` : `Budget-Warnung: ${a.label}`;
      const toast: Omit<Toast, "id"> = {
        tone: a.level === "warning" ? "warning" : "danger",
        title,
        detail: `${a.booked_hours.toFixed(1).replace(".", ",")} von ${a.planned_hours.toFixed(1).replace(".", ",")} h gebucht (${pct} %), Restaufwand ${a.etc_hours.toFixed(1).replace(".", ",")} h`,
      };
      if (hold) set({ heldToasts: [...get().heldToasts, toast].slice(-50) });
      else get().toast(toast);
    }
  },
}));

// Appearance, language, formats and shortcuts follow the settings (before components re-render).
useApp.subscribe((st, prev) => {
  if (st.settings && st.settings !== prev.settings) applyPrefs(st.settings.settings);
});

export const activeTab = () => {
  const s = useApp.getState();
  return s.tabs.find((t) => t.id === s.activeTabId) ?? null;
};
