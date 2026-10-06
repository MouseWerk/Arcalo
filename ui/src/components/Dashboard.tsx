// The start page (also shown in new tabs): boards (start pages) as tabs („Heute“, „Projekte“,
// own ones from templates such as „Sprint“ or „Persönlich“), each a grid of widgets in 12
// columns; the board used last opens. „Anpassen“ switches to edit mode: add widgets from the
// gallery, drag or move them with the keyboard, resize them with the handle, the keys or the
// preset sizes (also in each widget's menu outside edit mode), set them up, duplicate and
// remove, apply a preset, export and import a board; „Fertig“ saves. Narrow panes show the
// same board in fewer columns. The widgets' data comes in one batched call (dashboard/data.tsx);
// how to add a widget is described in dashboard/define.ts.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, Copy, Download, GripVertical, LayoutTemplate, MoreHorizontal, Plus, RotateCcw, Settings2, SlidersHorizontal, Trash2, Upload, X } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { timeTrackingEnabled, useTimeTracking } from "../lib/timetracking";
import { t, useT } from "../lib/i18n";
import { cellAt, columnsFor, COLS, GAP, grow, moveTo, nudge, readingOrder, rectPx, reflow, resizeTo, ROW_H } from "../lib/dashgrid";
import {
  boardFileName,
  configOf,
  editBoard,
  exportBoard,
  importBoard,
  isKind,
  loadDashboard,
  minOf,
  moveBoard,
  narrowMinOf,
  newBoard,
  PRESETS,
  resizeToPreset,
  shownWidgets,
  sizeName,
  SIZE_LABELS,
  SIZE_NAMES,
  SIZES,
  titleOf,
  toSaved,
  withHidden,
  type BoardAction,
  type PresetName,
  type SizeName,
  type WidgetKind,
} from "../lib/dashboard";
import type { Board, Dashboard as DashboardT, GridWidget } from "../lib/types";
import { Button, IconButton, useMenu, type MenuEntry, type MenuItem } from "./ui";
import { DashData } from "./dashboard/data";
import { BoardContext } from "./dashboard/board";
import { bodyOf, iconOf, openerOf } from "./dashboard/registry";
import { Gallery } from "./dashboard/Gallery";
import { WidgetSettings } from "./dashboard/WidgetSettings";

const s = useApp.getState;

/** The start page as stored now (another window or widget may have saved meanwhile). */
const fresh = () => loadDashboard(s().settings?.settings.dashboard, timeTrackingEnabled());

async function persist(next: DashboardT): Promise<boolean> {
  try {
    s().set({ settings: await api.saveDashboard(toSaved(next)) });
    return true;
  } catch (e) {
    s().error(t("dash.saveFailed"), e);
    return false;
  }
}

export function Dashboard() {
  const tr = useT();
  const stored = useApp((st) => st.settings?.settings.dashboard);
  // „Zeiterfassung verwenden“ off: time widgets stay on the boards, hidden (lib/dashboard.ts).
  const timeOn = useTimeTracking();
  const loaded = useMemo(() => loadDashboard(stored, timeOn), [stored, timeOn]);
  const [draft, setDraft] = useState<DashboardT | null>(null);
  const [saving, setSaving] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, , openMenuAt] = useMenu();
  // The board chosen outside edit mode shows at once (it is saved in the background).
  const [picked, setPicked] = useState<string | null>(null);
  const editing = draft != null;
  const dash = draft ?? loaded;
  const activeId = draft ? draft.active : (picked ?? loaded.active);
  const board = dash.boards.find((b) => b.id === activeId) ?? dash.boards[0];

  // The widget list of 1.3–1.5 moves onto a board once, saved right away.
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current || !stored || stored.boards?.length || stored.widgets == null) return;
    migrated.current = true;
    void persist(loaded);
  }, [stored, loaded]);

  /** A change of boards: into the draft while editing, else saved now. */
  const change = useCallback(
    (f: (d: DashboardT) => DashboardT) => {
      if (draft) setDraft((d) => (d ? f(d) : d));
      else void persist(f(fresh()));
    },
    [draft],
  );
  const dispatch = (a: BoardAction, boardId = board?.id) =>
    change((d) => ({ ...d, boards: d.boards.map((b) => (b.id === boardId ? editBoard(b, d.boards, a) : b)) }));

  const setActive = (id: string) => {
    if (draft) setDraft({ ...draft, active: id });
    else if (id !== activeId) {
      setPicked(id);
      // Saved so a restart comes back to it.
      void persist({ ...fresh(), active: id }).then(() => setPicked(null));
    }
  };

  const notesCtx = useMemo(
    () => ({
      notes: loaded.notes,
      setNote: (id: string, text: string) => {
        const cur = fresh();
        if ((cur.notes[id] ?? "") === text) return;
        void persist({ ...cur, notes: { ...cur.notes, [id]: text } });
      },
      setConfig: (id: string, patch: Record<string, unknown>) =>
        change((d) => ({ ...d, boards: d.boards.map((b) => ({ ...b, widgets: b.widgets.map((w) => (w.id === id ? { ...w, config: { ...configOf(w), ...patch } } : w)) })) })),
    }),
    [loaded.notes, change],
  );

  const finish = async () => {
    if (!draft) return;
    setSaving(true);
    // Notes typed meanwhile are kept (they are saved on their own).
    if (await persist({ ...draft, notes: fresh().notes })) setDraft(null);
    setSaving(false);
  };

  const addBoard = (preset: PresetName | null) =>
    change((d) => {
      const b = newBoard(d.boards, preset ? t(PRESETS.find((p) => p.name === preset)!.label) : t("dash.board.new"), preset, timeOn);
      setRenaming(b.id);
      return { ...d, boards: [...d.boards, b], active: b.id };
    });
  const removeBoard = async (b: Board) => {
    if (dash.boards.length <= 1) return;
    const ok = await s().confirm({ title: t("dash.board.deleteAsk", { name: b.name }), message: t("dash.board.deleteText"), confirmLabel: t("dash.board.delete"), danger: true });
    if (!ok) return;
    change((d) => {
      const boards = d.boards.filter((x) => x.id !== b.id);
      return { ...d, boards, active: d.active === b.id ? boards[0].id : d.active };
    });
  };
  const renameBoard = (id: string, name: string) => {
    setRenaming(null);
    const n = name.trim();
    if (n) change((d) => ({ ...d, boards: d.boards.map((b) => (b.id === id ? { ...b, name: n.slice(0, 40) } : b)) }));
  };
  const boardMenu = (b: Board, e: { currentTarget: EventTarget | null; clientX?: number; clientY?: number; preventDefault?: () => void; detail?: number }) => {
    const i = dash.boards.findIndex((x) => x.id === b.id);
    const items: MenuEntry[] = [
      { label: t("dash.board.rename"), onSelect: () => setRenaming(b.id) },
      { label: t("dash.board.left"), disabled: i === 0, onSelect: () => change((d) => ({ ...d, boards: moveBoard(d.boards, b.id, -1) })) },
      { label: t("dash.board.right"), disabled: i === dash.boards.length - 1, onSelect: () => change((d) => ({ ...d, boards: moveBoard(d.boards, b.id, 1) })) },
      { label: t("dash.board.export"), icon: Download, onSelect: () => void exportTo(b) },
      "separator",
      { label: t("dash.board.delete"), icon: Trash2, danger: true, disabled: dash.boards.length <= 1, onSelect: () => void removeBoard(b) },
    ];
    openMenuAt(e, items);
  };

  const exportTo = async (b: Board) => {
    const path = await saveDialog({ defaultPath: boardFileName(b), filters: [{ name: t("dash.board.fileType"), extensions: ["json"] }] });
    if (!path) return;
    try {
      await api.dashboardFileWrite(path, exportBoard(b, fresh().notes));
      s().toast({ tone: "success", title: t("dash.exported"), detail: path });
    } catch (e) {
      s().error(t("dash.exportFailed"), e);
    }
  };
  const importFrom = async () => {
    const path = await openDialog({ multiple: false, directory: false, filters: [{ name: t("dash.board.fileType"), extensions: ["json"] }] });
    if (typeof path !== "string") return;
    try {
      importText(await api.readSettingsFile(path));
    } catch (e) {
      s().error(t("dash.importFailed"), e);
    }
  };
  const importText = (text: string) => {
    const r = importBoard(text, dash.boards);
    if ("error" in r) return s().toast({ tone: "danger", title: t("dash.importFailed"), detail: t(r.error) });
    change((d) => ({ ...d, boards: [...d.boards, r.board], active: r.board.id, notes: { ...d.notes, ...r.notes } }));
    // Widgets this version does not know are left out, and said so.
    if (r.dropped.length) s().toast({ tone: "warning", title: t("dash.imported", { name: r.board.name }), detail: t("dash.import.dropped", { n: r.dropped.length, kinds: r.dropped.join(", ") }) });
    else s().toast({ tone: "success", title: t("dash.imported", { name: r.board.name }) });
  };
  // Tests and scripts import a board, or export one to a path, without the file dialog.
  useEffect(() => {
    const f = (e: Event) => importText((e as CustomEvent<string>).detail);
    const x = (e: Event) => {
      const { board: id, path } = (e as CustomEvent<{ board: string; path: string }>).detail;
      const b = fresh().boards.find((y) => y.id === id);
      if (b) void api.dashboardFileWrite(path, exportBoard(b, fresh().notes));
    };
    window.addEventListener("annalo:dashboard-import", f);
    window.addEventListener("annalo:dashboard-export", x);
    return () => {
      window.removeEventListener("annalo:dashboard-import", f);
      window.removeEventListener("annalo:dashboard-export", x);
    };
  });

  const presetMenu = (e: ReactMouseEvent) =>
    openMenuAt(e, [
      ...PRESETS.map((p) => ({ label: t(p.label), onSelect: () => dispatch({ type: "preset", name: p.name, time: timeOn }) })),
      "separator",
      { label: t("dash.reset"), icon: RotateCcw, onSelect: () => dispatch({ type: "preset", name: board?.id === "projekte" ? "lead" : "start", time: timeOn }) },
    ]);
  const moreMenu = (e: ReactMouseEvent) =>
    openMenuAt(e, [
      { label: t("dash.board.export"), icon: Download, disabled: !board, onSelect: () => board && void exportTo(board) },
      { label: t("dash.board.import"), icon: Upload, onSelect: () => void importFrom() },
    ]);
  const newBoardMenu = (e: ReactMouseEvent) =>
    openMenuAt(e, [{ label: t("dash.board.empty"), onSelect: () => addBoard(null) }, "separator", ...PRESETS.map((p) => ({ label: t(p.label), onSelect: () => addBoard(p.name) }))]);

  const settingsWidget = board?.widgets.find((w) => w.id === settingsFor);

  return (
    <section className={`dash ${editing ? "editing" : ""}`} aria-label={tr("dash.label")}>
      <div className="dash-top">
        <div className="dash-tabs" role="tablist" aria-label={tr("dash.boards")}>
          {dash.boards.map((b, i) =>
            renaming === b.id ? (
              <input
                key={b.id}
                className="input dash-tab-input"
                defaultValue={b.name}
                aria-label={tr("dash.board.name")}
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => renameBoard(b.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameBoard(b.id, e.currentTarget.value);
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                key={b.id}
                type="button"
                role="tab"
                className="dash-tab"
                aria-selected={b.id === board?.id}
                tabIndex={b.id === board?.id ? 0 : -1}
                data-board={b.id}
                onClick={() => setActive(b.id)}
                onDoubleClick={() => setRenaming(b.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  boardMenu(b, e);
                }}
                onKeyDown={(e) => {
                  const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
                  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                    e.preventDefault();
                    change((d) => ({ ...d, boards: moveBoard(d.boards, b.id, e.key === "ArrowLeft" ? -1 : 1) }));
                  } else if (j >= 0 && j < dash.boards.length) {
                    e.preventDefault();
                    setActive(dash.boards[j].id);
                    (e.currentTarget.parentElement?.querySelector(`[data-board="${dash.boards[j].id}"]`) as HTMLElement | null)?.focus();
                  } else if (e.key === "F2") setRenaming(b.id);
                }}
              >
                {b.name}
                {editing && b.id === board?.id && (
                  <span
                    className="dash-tab-more"
                    role="button"
                    tabIndex={-1}
                    aria-label={tr("dash.board.options", { name: b.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      boardMenu(b, e);
                    }}
                  >
                    <ChevronDown size={12} />
                  </span>
                )}
              </button>
            ),
          )}
          <IconButton icon={Plus} size="sm" label={tr("dash.board.add")} onClick={newBoardMenu} />
        </div>
        <div className="dash-bar">
          {editing ? (
            <>
              <Button size="sm" icon={Plus} onClick={() => setGallery(true)}>
                {tr("dash.addWidget")}
              </Button>
              <Button size="sm" variant="ghost" icon={LayoutTemplate} onClick={presetMenu}>
                {tr("dash.presets")}
              </Button>
              <IconButton icon={MoreHorizontal} label={tr("dash.more2")} onClick={moreMenu} />
              <span className="dash-bar-sep" aria-hidden />
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                {tr("dash.cancel")}
              </Button>
              <Button size="sm" variant="primary" onClick={finish} loading={saving}>
                {tr("dash.done")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={SlidersHorizontal} onClick={() => setDraft({ ...structuredClone(fresh()), active: board?.id ?? "" })}>
              {tr("dash.customize")}
            </Button>
          )}
        </div>
      </div>
      {board && (
        <BoardContext.Provider value={notesCtx}>
          <BoardGrid
            key={board.id}
            board={board}
            editing={editing}
            timeOn={timeOn}
            onLayout={(widgets) => dispatch({ type: "layout", widgets: withHidden(board.widgets, widgets, timeOn) })}
            onAction={dispatch}
            onSettings={setSettingsFor}
            onAdd={() => setGallery(true)}
          />
        </BoardContext.Provider>
      )}
      {gallery && (
        <Gallery
          timeOn={timeOn}
          onClose={() => setGallery(false)}
          onPick={(kind: WidgetKind) => {
            setGallery(false);
            // Adding starts edit mode when it was not on.
            setDraft((d) => {
              const base = d ?? { ...structuredClone(fresh()), active: board?.id ?? "" };
              const b = base.boards.find((x) => x.id === base.active) ?? base.boards[0];
              return { ...base, boards: base.boards.map((x) => (x.id === b.id ? editBoard(x, base.boards, { type: "add", kind }) : x)) };
            });
          }}
        />
      )}
      {settingsWidget && (
        <WidgetSettings
          widget={settingsWidget}
          onClose={() => setSettingsFor(null)}
          onApply={(config, title) => {
            dispatch({ type: "config", id: settingsWidget.id, config, title });
            setSettingsFor(null);
          }}
        />
      )}
      {editing && <DashKeysHint />}
      {menu}
    </section>
  );
}

// ------------------------------------------------------------------ grid

type Drag = { id: string; mode: "move" | "resize"; grabX: number; grabY: number; layout: GridWidget[]; px: number; py: number; start: GridWidget[] };

/** Whether two layouts put every widget at the same place and size. */
const sameLayout = (a: readonly GridWidget[], b: readonly GridWidget[]) =>
  a.length === b.length && a.every((w, i) => w.id === b[i].id && w.x === b[i].x && w.y === b[i].y && w.w === b[i].w && w.h === b[i].h);

function BoardGrid({ board: stored, editing, timeOn, onLayout, onAction, onSettings, onAdd }: { board: Board; editing: boolean; timeOn: boolean; onLayout: (w: GridWidget[]) => void; onAction: (a: BoardAction) => void; onSettings: (id: string) => void; onAdd: () => void }) {
  // The board as shown: hidden time widgets left out and the gaps closed; edits work on this
  // layout and `onLayout` puts the hidden ones back.
  const board = useMemo(() => ({ ...stored, widgets: shownWidgets(stored.widgets, timeOn) }), [stored, timeOn]);
  const tr = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announce, setAnnounce] = useState("");
  const [seen, setSeen] = useState<Set<string>>(() => new Set());

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const cols = width ? columnsFor(width) : COLS;
  const full = cols === COLS;
  const shown = useMemo(() => {
    const base = drag?.layout ?? board.widgets;
    return full ? base : reflow(base, cols, narrowMinOf);
  }, [drag, board.widgets, cols, full]);
  const ordered = useMemo(() => readingOrder(shown), [shown]);

  // Widgets load when they come into view (a little ahead); the first screen right away.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const limit = (window.innerHeight + 400) / (ROW_H + GAP);
    const top = el.getBoundingClientRect().top / (ROW_H + GAP);
    setSeen((prev) => {
      const next = new Set(prev);
      for (const w of shown) if (w.y < limit - Math.max(0, top)) next.add(w.id);
      return next.size === prev.size ? prev : next;
    });
    const root = el.closest(".home") as Element | null;
    const io = new IntersectionObserver(
      (entries) => {
        const ids = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.widget!);
        if (ids.length) setSeen((prev) => (ids.every((id) => prev.has(id)) ? prev : new Set([...prev, ...ids])));
      },
      { root, rootMargin: "300px 0px" },
    );
    el.querySelectorAll<HTMLElement>(".dw[data-widget]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [shown]);

  const describe = (w: GridWidget) => tr("dash.a11y.pos", { name: titleOf(w), x: w.x + 1, y: w.y + 1, w: w.w, h: w.h });

  const keyDown = (w: GridWidget, e: ReactKeyboardEvent) => {
    if (!editing || e.target !== e.currentTarget) return;
    const dir: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dir[e.key];
    let next: GridWidget[] | null = null;
    if (d && full) {
      e.preventDefault();
      next = e.shiftKey ? grow(board.widgets, w.id, d[0], d[1], COLS, minOf(w)) : nudge(board.widgets, w.id, d[0], d[1]);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const i = ordered.findIndex((x) => x.id === w.id);
      const neighbour = ordered[i + 1] ?? ordered[i - 1];
      onAction({ type: "remove", id: w.id });
      setAnnounce(tr("dash.a11y.removed", { name: titleOf(w) }));
      if (neighbour) requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-widget="${neighbour.id}"]`)?.focus());
    } else if (e.key === "Enter") {
      e.preventDefault();
      onSettings(w.id);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      onAction({ type: "duplicate", id: w.id });
    } else if (full && !e.ctrlKey && !e.metaKey && !e.altKey && /^[1-5]$/.test(e.key)) {
      // 1–5: the preset sizes (small, medium, wide, tall, wide and tall).
      e.preventDefault();
      next = resizeToPreset(board.widgets, w.id, SIZE_NAMES[Number(e.key) - 1]);
    }
    if (next && next !== board.widgets) {
      onLayout(next);
      const moved = next.find((x) => x.id === w.id)!;
      setAnnounce(describe(moved));
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-widget="${w.id}"]`)?.focus());
    }
  };

  const startDrag = (w: GridWidget, mode: Drag["mode"], e: ReactPointerEvent) => {
    if (!editing || !full || e.button !== 0) return;
    if (mode === "move" && (e.target as Element).closest("button, input, [role=button]")) return;
    e.preventDefault();
    const grid = ref.current!.getBoundingClientRect();
    const r = rectPx(w, width);
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already released pointers cannot be captured; moves still reach the grid.
    }
    setDrag({ id: w.id, mode, grabX: e.clientX - grid.left - r.left, grabY: e.clientY - grid.top - r.top, layout: board.widgets, px: e.clientX - grid.left, py: e.clientY - grid.top, start: board.widgets });
  };
  /** The layout for the pointer at `e`, computed from the drag's start, so it does not depend on renders. */
  const layoutAt = (d: Drag, e: ReactPointerEvent) => {
    const grid = ref.current!.getBoundingClientRect();
    const px = e.clientX - grid.left;
    const py = e.clientY - grid.top;
    const w = d.start.find((x) => x.id === d.id)!;
    let layout: GridWidget[];
    if (d.mode === "move") {
      const cell = cellAt(px - d.grabX + (width / COLS) / 2, py - d.grabY + ROW_H / 2, width);
      layout = moveTo(d.start, d.id, cell.col, cell.row);
    } else {
      const r = rectPx(w, width);
      const colW = (width - GAP * (COLS - 1)) / COLS;
      const nw = Math.round((px - r.left + GAP) / (colW + GAP));
      const nh = Math.round((py - r.top + GAP) / (ROW_H + GAP));
      layout = resizeTo(d.start, d.id, nw, nh, COLS, minOf(w));
    }
    return { ...d, layout, px, py };
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (drag) setDrag(layoutAt(drag, e));
  };
  const endDrag = (e: ReactPointerEvent) => {
    if (!drag) return;
    // The release point decides: the last move may not have rendered yet.
    const { layout } = e.type === "pointerup" ? layoutAt(drag, e) : drag;
    const moved = layout.find((x) => x.id === drag.id);
    if (!sameLayout(layout, drag.start)) {
      onLayout(layout);
      if (moved) setAnnounce(describe(moved));
    }
    setDrag(null);
  };

  const rows = shown.reduce((m, w) => Math.max(m, w.y + w.h), 0);
  return (
    <>
      {editing && !full && <div className="dash-narrow faint small">{tr("dash.narrowHint")}</div>}
      <div
        ref={ref}
        className={`dash-grid ${drag ? "dragging" : ""}`}
        style={{ "--cols": cols, "--rows": Math.max(rows, 1) } as CSSProperties}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-cols={cols}
      >
        <DashData widgets={board.widgets} seen={seen}>
          {ordered.map((w) => {
            const dragged = drag?.id === w.id;
            const style: CSSProperties = { gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` };
            let ghost: CSSProperties | null = null;
            if (dragged && drag) {
              const target = rectPx(w, width);
              if (drag.mode === "move") ghost = { transform: `translate(${drag.px - drag.grabX - target.left}px, ${drag.py - drag.grabY - target.top}px)` };
            }
            return (
              <WidgetCard
                key={w.id}
                widget={w}
                editing={editing}
                full={full}
                style={{ ...style, ...ghost }}
                dragged={dragged}
                dragMode={dragged ? drag!.mode : null}
                onKeyDown={(e) => keyDown(w, e)}
                onGrab={(e) => startDrag(w, "move", e)}
                onResizeStart={(e) => startDrag(w, "resize", e)}
                onAction={onAction}
                onSettings={() => onSettings(w.id)}
                onSize={(name) => {
                  const next = resizeToPreset(board.widgets, w.id, name);
                  onLayout(next);
                  setAnnounce(describe(next.find((x) => x.id === w.id)!));
                }}
              />
            );
          })}
          {drag && drag.mode === "move" && (() => {
            const w = drag.layout.find((x) => x.id === drag.id)!;
            return <div className="dw-drop" style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }} aria-hidden />;
          })()}
        </DashData>
        {board.widgets.length === 0 && (
          <div className="dash-empty">
            <div className="dash-empty-title">{tr("dash.emptyTitle")}</div>
            <div className="faint">{editing ? tr("dash.emptyEditing") : tr("dash.emptyText")}</div>
            <Button size="sm" icon={Plus} onClick={onAdd}>
              {tr("dash.addWidget")}
            </Button>
          </div>
        )}
      </div>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </>
  );
}

function WidgetCard({
  widget: w,
  editing,
  full,
  style,
  dragged,
  dragMode,
  onKeyDown,
  onGrab,
  onResizeStart,
  onAction,
  onSettings,
  onSize,
}: {
  widget: GridWidget;
  editing: boolean;
  full: boolean;
  style: CSSProperties;
  dragged: boolean;
  dragMode: Drag["mode"] | null;
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onGrab: (e: ReactPointerEvent) => void;
  onResizeStart: (e: ReactPointerEvent) => void;
  onAction: (a: BoardAction) => void;
  onSettings: () => void;
  onSize: (name: SizeName) => void;
}) {
  const tr = useT();
  const [menu, , openMenuAt] = useMenu();
  const Body = bodyOf(w.kind);
  if (!isKind(w.kind) || !Body) return null;
  const Icon = iconOf(w.kind);
  const title = titleOf(w);
  const open = openerOf(w);
  const current = sizeName(w);
  // Narrow widgets keep room for their title: sizes and „Duplizieren“ go into a menu.
  const compact = w.w <= 4;
  const sizes: MenuItem[] = SIZE_NAMES.map((n) => ({ label: tr("dash.sizeName", { size: tr(SIZE_LABELS[n]) }), checked: current === n, onSelect: () => onSize(n) }));
  const sizeItems: MenuEntry[] = full ? [...sizes, "separator"] : [];
  return (
    <article
      className={`card dw dw-k-${w.kind} ${dragged ? `lifted ${dragMode}` : ""} ${w.w <= 4 ? "narrow" : ""}`}
      data-widget={w.id}
      data-kind={w.kind}
      style={style}
      aria-label={title}
      aria-roledescription={editing ? tr("dash.a11y.widget") : undefined}
      aria-describedby={editing ? "dash-keys-hint" : undefined}
      tabIndex={editing ? 0 : undefined}
      onKeyDown={onKeyDown}
    >
      <header className="dw-head" onPointerDown={editing && full ? onGrab : undefined}>
        {editing && <GripVertical size={14} className="faint dw-grip" aria-hidden />}
        <Icon size={14} className="dw-head-icon" aria-hidden />
        {open && !editing ? (
          <button type="button" className="dw-title-btn" onClick={open}>
            <h2 title={title}>{title}</h2>
          </button>
        ) : (
          <h2 title={title}>{title}</h2>
        )}
        {editing ? (
          <div className="dw-tools">
            {compact ? (
              <IconButton
                icon={MoreHorizontal}
                label={tr("dash.widgetMenu")}
                size="sm"
                onClick={(e) => openMenuAt(e, [...sizeItems, { label: tr("dash.duplicate"), icon: Copy, onSelect: () => onAction({ type: "duplicate", id: w.id }) }])}
              />
            ) : (
              full && (
                <div className="dw-sizes" role="group" aria-label={tr("dash.size")}>
                  {SIZE_NAMES.map((n) => (
                    <button key={n} type="button" aria-pressed={current === n} aria-label={tr("dash.sizeName", { size: tr(SIZE_LABELS[n]) })} title={tr(SIZE_LABELS[n])} onClick={() => onSize(n)}>
                      <SizeGlyph name={n} />
                    </button>
                  ))}
                </div>
              )
            )}
            <IconButton icon={Settings2} label={tr("dash.settings")} size="sm" onClick={onSettings} />
            {!compact && <IconButton icon={Copy} label={tr("dash.duplicate")} size="sm" onClick={() => onAction({ type: "duplicate", id: w.id })} />}
            <IconButton icon={X} label={tr("dash.remove")} size="sm" onClick={() => onAction({ type: "remove", id: w.id })} />
          </div>
        ) : (
          <div className="dw-hover-tools">
            <IconButton icon={Settings2} label={tr("dash.settingsOf", { name: title })} size="sm" className="dw-gear" onClick={onSettings} />
            <IconButton
              icon={MoreHorizontal}
              label={tr("dash.menuOf", { name: title })}
              size="sm"
              className="dw-menu"
              onClick={(e) =>
                openMenuAt(e, [
                  ...(full ? [{ label: tr("dash.size"), submenu: sizes }] : []),
                  { label: tr("dash.settings"), icon: Settings2, onSelect: onSettings },
                  { label: tr("dash.duplicate"), icon: Copy, onSelect: () => onAction({ type: "duplicate", id: w.id }) },
                  "separator",
                  { label: tr("dash.remove"), icon: Trash2, danger: true, onSelect: () => onAction({ type: "remove", id: w.id }) },
                ])
              }
            />
          </div>
        )}
      </header>
      <div className="dw-body" inert={editing}>
        <Body widget={w} openSettings={onSettings} />
      </div>
      {editing && full && <span className="dw-resize" role="presentation" onPointerDown={onResizeStart} title={tr("dash.resize")} />}
      {menu}
    </article>
  );
}

/** A preset size drawn to scale on a 2 × 2 tile (wide = two tiles side by side, …). */
export function SizeGlyph({ name }: { name: SizeName }) {
  const sz = SIZES[name];
  // Medium fills one tile (a third of the width), small a little less.
  const w = name === "s" ? 3.5 : sz.w >= 8 ? 11 : 5;
  const h = name === "s" ? 3.5 : sz.h >= 14 ? 11 : 5;
  return (
    <svg className="dw-size-glyph" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect className="dw-size-frame" x="0.5" y="0.5" width="13" height="13" rx="2.5" />
      <rect className="dw-size-fill" x="1.5" y="1.5" width={w} height={h} rx="1.25" />
    </svg>
  );
}

/** The keyboard help of edit mode (referenced by every widget). */
function DashKeysHint() {
  return (
    <span id="dash-keys-hint" className="sr-only">
      {t("dash.a11y.keys")}
    </span>
  );
}
