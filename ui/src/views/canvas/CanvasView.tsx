// A canvas page: an infinite board of cards and connections (JSON Canvas, `lib/canvas/`).
// The world (groups, edges, cards) is one transformed layer; only cards near the visible part
// are rendered. Every change goes through `commit` (undo snapshot, autosave); gestures record
// the state they start from once and drop it again when nothing changed.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter, AlignStartHorizontal, AlignStartVertical,
  AlignVerticalDistributeCenter, ArrowRight, BoxSelect, Copy, Download, FileText, Grid3x3, Group as GroupIcon, ImagePlus, Link2, Maximize, Minus, MoreHorizontal, Pencil, Plus,
  Redo2, Spline, StickyNote, Ticket, Trash2, Undo2, LayoutDashboard,
} from "lucide-react";
import { api, storeFile, uploadAttachment } from "../../lib/api";
import { t, useT } from "../../lib/i18n";
import { keys } from "../../lib/shortcut";
import { readPlanData, PAGE_MIME, PLAN_MIME } from "../../lib/blocks";
import { useIssueIndex } from "../../lib/jira";
import { openIssue } from "../../lib/jiraActions";
import { useApp, type Tab } from "../../store/app";
import type { PageDoc } from "../../lib/types";
import { registerFlusher, trackSave } from "../../editor/saves";
import type { EmbedHost } from "../../editor/embedView";
import { ConflictBanner } from "../ConflictView";
import { Button, Dialog, IconButton, Input, Spinner, useMenu, type MenuEntry } from "../../components/ui";
import { ViewHeader } from "../../components/ViewHeader";
import { CanvasHistory } from "../../lib/canvas/history";
import { CLIP_MIME, copyPayload, pastePayload, readPayload, type ClipPayload } from "../../lib/canvas/clipboard";
import {
  alignNodes, boxOf, bounds, contains, distributeNodes, fitView, GRID, intersects, moveNodes, movingIds, nearestSide, resizeRect, snap, snapRect, visibleNodes, zoomAt,
  type Align, type Handle, type Point, type Rect,
} from "../../lib/canvas/geometry";
import {
  cardKind, DEFAULT_SIZE, isImagePath, isReadableCanvas, newId, parseCanvas, patchEdge, patchNode, PRESET_COLORS, removeItems, serializeCanvas, withNode,
  type CanvasDoc, type CanvasEdge, type CanvasNode, type CardKind, type Side,
} from "../../lib/canvas/model";
import { Card, EdgeLabels, EdgeLayer, Group, Minimap, type CardHost, type EdgeDraft } from "./CanvasCards";
import { exportCanvas, type CanvasExportFormat } from "./exportCanvas";
import { isComposing } from "../../lib/ime";

const MIN_ZOOM = 0.1;
/** Below this zoom cards show only their first line (nothing smaller is readable). */
const LOD_ZOOM = 0.4;
const MAX_ZOOM = 4;
const SAVE_DELAY = 600;
const SNAP_KEY = "arcalo.canvas-snap";
const VIEW_KEY = "arcalo.canvas-view";
/** Ask for an export with a path (no dialog): `detail: { pageId, format, path }` (also used by tests). */
export const CANVAS_EXPORT_EVENT = "arcalo:canvas-export";

interface View {
  zoom: number;
  x: number;
  y: number;
}

function storedViews(): Record<string, View> {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function storeView(pageId: number, v: View) {
  try {
    const all = storedViews();
    all[pageId] = v;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
    localStorage.setItem(VIEW_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the view is not remembered */
  }
}
function snapPref(): boolean {
  try {
    return localStorage.getItem(SNAP_KEY) !== "0";
  } catch {
    return true;
  }
}

type Gesture =
  | { kind: "pan"; start: Point; view: View }
  | { kind: "box"; start: Point; base: Set<string> }
  | { kind: "move"; start: Point; ids: Set<string>; doc: CanvasDoc; lead: CanvasNode; moved: boolean; clickId: string | null }
  | { kind: "resize"; start: Point; id: string; handle: Handle; rect: Rect }
  | { kind: "connect"; from: string; side: Side; start: Point };

export function CanvasView({ pageId, tab, active }: { pageId: number; tab: Tab; active: boolean }) {
  useT();
  const [page, setPage] = useState<PageDoc | null>(null);
  const [missing, setMissing] = useState(false);
  /** The stored text is no canvas (e.g. a broken file): shown, never overwritten. */
  const [unreadable, setUnreadable] = useState(false);
  const [doc, setDocState] = useState<CanvasDoc>({ nodes: [], edges: [] });
  const docRef = useRef(doc);
  const nodeMap = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes]);
  const savedText = useRef<string | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef(0);
  const history = useRef(new CanvasHistory());
  const [, bump] = useState(0);
  // The view lives in a ref: panning moves the layers directly (`applyView`) and renders only
  // when cards come into reach (culling) or after the view rests (minimap, toolbars).
  const [viewTick, setViewState] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(viewTick);
  /** The part of the board the last render covers (visible area plus the culling margin). */
  const rendered = useRef<{ rect: Rect; zoom: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [selEdges, setSelEdges] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const [draft, setDraft] = useState<EdgeDraft | null>(null);
  const [snapOn, setSnapOn] = useState(snapPref);
  const [panning, setPanning] = useState(false);
  const [dialog, setDialog] = useState<null | "note" | "link" | "issue">(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const spaceDown = useRef(false);
  const pointer = useRef<Point | null>(null);
  const memClip = useRef<ClipPayload | null>(null);
  const pasteSeen = useRef(false);
  const [menu, openMenu, openMenuAt] = useMenu();
  const pages = useApp((s) => s.pages);
  const title = pages.get(pageId)?.title ?? page?.title ?? "";
  const titleRef = useRef(title);
  titleRef.current = title;

  // ------------------------------------------------------------------ load & save

  const setDoc = (next: CanvasDoc) => {
    docRef.current = next;
    setDocState(next);
  };
  const worldRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef(0);
  const setView = (v: View) => {
    viewRef.current = v;
    const el = rootRef.current;
    const r = rendered.current;
    const visible = el ? { x: -v.x / v.zoom, y: -v.y / v.zoom, width: el.clientWidth / v.zoom, height: el.clientHeight / v.zoom } : null;
    if (!r || !visible || r.zoom !== v.zoom || !contains(r.rect, visible)) setViewState(v);
    else applyView(v);
    // While the view moves the world is its own layer (cheap to move) and the selection bar
    // hides; once it rests, it renders again (text crisp at the final scale).
    el?.classList.add("is-moving");
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      rootRef.current?.classList.remove("is-moving");
      setViewState(viewRef.current);
    }, 160);
  };
  /** Moves world and grid without a render. */
  const applyView = (v: View) => {
    if (worldRef.current) worldRef.current.style.transform = worldTransform(v);
    if (gridRef.current) gridRef.current.style.transform = gridTransform(v);
  };

  const save = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    if (!dirty.current) return;
    const text = serializeCanvas(docRef.current);
    dirty.current = false;
    if (text === savedText.current) return;
    const before = savedText.current;
    savedText.current = text;
    try {
      await trackSave(api.savePage(pageId, text));
      window.dispatchEvent(new CustomEvent("arcalo:page-saved", { detail: { id: pageId, content: text } }));
    } catch (e) {
      // Not stored: the next save tries again (the same text included).
      if (savedText.current === text) savedText.current = before;
      dirty.current = true;
      useApp.getState().error(t("canvas.saveFailed"), e);
    }
  }, [pageId]);

  useEffect(() => {
    let alive = true;
    setPage(null);
    setMissing(false);
    setUnreadable(false);
    history.current.clear();
    api
      .page(pageId)
      .then((d) => {
        if (!alive) return;
        setPage(d);
        savedText.current = d.content;
        dirty.current = false;
        setUnreadable(!isReadableCanvas(d.content));
        const parsed = parseCanvas(d.content);
        setDoc(parsed);
        const remembered = storedViews()[pageId];
        const el = rootRef.current;
        const b = bounds(parsed.nodes);
        if (remembered) setView(remembered);
        else if (b && el) setView(fitView(b, el.clientWidth || 1000, el.clientHeight || 700));
        else setView({ zoom: 1, x: (el?.clientWidth ?? 1000) / 2 - 130, y: (el?.clientHeight ?? 700) / 3 });
      })
      .catch(() => alive && setMissing(true));
    const unregister = registerFlusher(() => save());
    return () => {
      alive = false;
      unregister();
      void save();
    };
  }, [pageId, save]);

  // Saved elsewhere (Git sync, a restored version): take it over unless there are local edits.
  useEffect(() => {
    const reload = () => {
      if (dirty.current) return;
      api
        .page(pageId)
        .then((d) => {
          if (dirty.current || d.content === savedText.current) return;
          savedText.current = d.content;
          setUnreadable(!isReadableCanvas(d.content));
          setDoc(parseCanvas(d.content));
          setPage(d);
        })
        .catch(() => {});
    };
    const onReload = (e: Event) => {
      const ids = (e as CustomEvent<{ ids?: number[] }>).detail?.ids;
      if (!ids || ids.includes(pageId)) reload();
    };
    window.addEventListener("arcalo:reload-pages", onReload);
    return () => window.removeEventListener("arcalo:reload-pages", onReload);
  }, [pageId]);

  useEffect(() => {
    if (active && page) useApp.getState().set({ activeDoc: page });
  }, [active, page]);

  // The view is remembered per page on this device.
  useEffect(() => {
    if (!page) return;
    const timer = window.setTimeout(() => storeView(pageId, view), 400);
    return () => window.clearTimeout(timer);
  }, [viewTick, pageId, page]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, [page]);

  /** Applies a change: undo snapshot (unless part of a gesture that recorded already), autosave. */
  const commit = useCallback(
    (next: CanvasDoc, record = true) => {
      if (record) history.current.record(serializeCanvas(docRef.current));
      setDoc(next);
      dirty.current = true;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void save(), SAVE_DELAY);
      bump((n) => n + 1);
    },
    [save],
  );

  const restore = (text: string | null) => {
    if (text == null) return;
    const next = parseCanvas(text);
    setDoc(next);
    const ids = new Set(next.nodes.map((n) => n.id));
    setSel((s) => new Set([...s].filter((id) => ids.has(id))));
    setSelEdges(new Set());
    setEditing(null);
    dirty.current = true;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), SAVE_DELAY);
    bump((n) => n + 1);
  };
  const undo = () => restore(history.current.undo(serializeCanvas(docRef.current)));
  const redo = () => restore(history.current.redo(serializeCanvas(docRef.current)));

  // ------------------------------------------------------------------ coordinates

  const toWorld = useCallback((clientX: number, clientY: number): Point => {
    const r = rootRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom };
  }, []);
  const viewCenter = (): Point => {
    const v = viewRef.current;
    return { x: (size.width / 2 - v.x) / v.zoom, y: (size.height / 2 - v.y) / v.zoom };
  };
  const view = viewRef.current;
  const visibleRect: Rect = { x: -view.x / view.zoom, y: -view.y / view.zoom, width: size.width / view.zoom, height: size.height / view.zoom };

  const focusBoard = () => rootRef.current?.focus({ preventScroll: true });

  // ------------------------------------------------------------------ adding cards

  const place = (kind: CardKind, at: Point, extra: Partial<CanvasNode>): CanvasNode => {
    const s = DEFAULT_SIZE[kind];
    const width = extra.width ?? s.width;
    const height = extra.height ?? s.height;
    let r = { x: at.x - width / 2, y: at.y - height / 2, width, height };
    if (snapOn) r = snapRect(r);
    const type = kind === "text" ? "text" : kind === "group" ? "group" : kind === "link" || kind === "issue" ? "link" : "file";
    return { id: newId(), type, ...r, ...extra, x: r.x, y: r.y, width: r.width, height: r.height } as CanvasNode;
  };

  const addNodes = (nodes: CanvasNode[], edit = false) => {
    if (!nodes.length) return;
    let next = docRef.current;
    for (const n of nodes) next = withNode(next, n);
    commit(next);
    setSel(new Set(nodes.map((n) => n.id)));
    setSelEdges(new Set());
    if (edit && nodes.length === 1) setEditing(nodes[0].id);
    else focusBoard();
  };

  const addText = (at = viewCenter()) => addNodes([place("text", at, { text: "" })], true);

  const addNotes = async (pageIds: number[], at = viewCenter()) => {
    try {
      const nodes: CanvasNode[] = [];
      for (const [i, id] of pageIds.entries()) {
        const file = await api.canvasNotePath(id);
        nodes.push(place("note", { x: at.x + i * 40, y: at.y + i * 40 }, { file }));
      }
      addNodes(nodes);
    } catch (e) {
      useApp.getState().error(t("canvas.addFailed"), e);
    }
  };

  const addFiles = async (files: File[], at = viewCenter()) => {
    try {
      const nodes: CanvasNode[] = [];
      for (const [i, f] of files.entries()) {
        const saved = f.type.startsWith("image/") ? await uploadAttachment(f) : await storeFile(f);
        const kind: CardKind = isImagePath(saved.name) ? "image" : "file";
        nodes.push(place(kind, { x: at.x + i * 40, y: at.y + i * 40 }, { file: `attachments/${saved.name}` }));
      }
      addNodes(nodes);
    } catch (e) {
      useApp.getState().error(t("canvas.addFailed"), e);
    }
  };

  const pickFiles = async () => {
    const picked = await openDialog({ multiple: true, directory: false, title: t("canvas.add.file") }).catch(() => null);
    const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
    if (!paths.length) return;
    try {
      const at = viewCenter();
      const nodes: CanvasNode[] = [];
      for (const [i, p] of paths.entries()) {
        const saved = await api.importAttachment(p);
        nodes.push(place(isImagePath(saved.name) ? "image" : "file", { x: at.x + i * 40, y: at.y + i * 40 }, { file: `attachments/${saved.name}` }));
      }
      addNodes(nodes);
    } catch (e) {
      useApp.getState().error(t("canvas.addFailed"), e);
    }
  };

  const addLink = (url: string, at = viewCenter()) => {
    const node = place("link", at, { url });
    addNodes([node]);
    // The page's title, when it can be fetched; the card shows the host meanwhile.
    void api
      .linkTitle(url)
      .then((title) => {
        if (title && title !== url && docRef.current.nodes.some((n) => n.id === node.id)) {
          setDoc(patchNode(docRef.current, node.id, { title }));
          dirty.current = true;
          void save();
        }
      })
      .catch(() => {});
  };

  const addIssue = (key: string, summary?: string, at = viewCenter()) => {
    const chip = useIssueIndex.getState().byKey.get(key);
    addNodes([place("issue", at, { url: chip?.url ?? "", issue: key, ...(summary || chip?.summary ? { title: summary || chip?.summary } : {}) })]);
  };

  const addGroup = () => {
    const chosen = docRef.current.nodes.filter((n) => sel.has(n.id));
    const b = bounds(chosen);
    const label = t("canvas.group.default");
    if (!b) return addNodes([place("group", viewCenter(), { label })]);
    const pad = 40;
    let r = { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
    if (snapOn) r = snapRect(r);
    addNodes([{ id: newId(), type: "group", ...r, label }]);
  };

  // ------------------------------------------------------------------ selection actions

  const selectedNodes = () => docRef.current.nodes.filter((n) => sel.has(n.id));

  const removeSelection = () => {
    if (!sel.size && !selEdges.size) return;
    commit(removeItems(docRef.current, sel, selEdges));
    setSel(new Set());
    setSelEdges(new Set());
    setEditing(null);
  };

  const setColor = (color: string | undefined) => {
    let next = docRef.current;
    for (const id of sel) next = patchNode(next, id, { color });
    for (const id of selEdges) next = patchEdge(next, id, { color });
    commit(next);
  };

  const applyPositions = (pos: Map<string, Point>) => {
    if (!pos.size) return;
    let next = docRef.current;
    for (const [id, p] of pos) {
      const n = next.nodes.find((x) => x.id === id)!;
      // A group takes its cards along.
      next = moveNodes(next, movingIds(next.nodes, [id]), p.x - n.x, p.y - n.y);
    }
    commit(next);
  };
  const align = (how: Align) => applyPositions(alignNodes(selectedNodes(), how));
  const distribute = (axis: "x" | "y") => applyPositions(distributeNodes(selectedNodes(), axis));

  const copySelection = (): ClipPayload | null => {
    if (!sel.size) return null;
    const p = copyPayload(docRef.current, sel);
    memClip.current = p;
    return p;
  };

  const paste = (payload: ClipPayload, at?: Point) => {
    const { doc: next, ids } = pastePayload(docRef.current, payload, at ? { at } : { offset: { x: 40, y: 40 } });
    commit(next);
    setSel(new Set(ids));
    setSelEdges(new Set());
  };

  const duplicate = () => {
    const p = copySelection();
    if (p) paste(p);
  };

  const bringToFront = () => {
    const d = docRef.current;
    const front = d.nodes.filter((n) => sel.has(n.id) && n.type !== "group");
    if (!front.length) return;
    commit({ ...d, nodes: [...d.nodes.filter((n) => !front.includes(n)), ...front] });
  };

  const fit = () => {
    const b = bounds(docRef.current.nodes);
    // Centered above the bottom toolbars.
    if (b) setView(fitView(b, size.width, size.height - 64));
  };
  const zoomBy = (factor: number, at: Point = { x: size.width / 2, y: size.height / 2 }) => {
    const v = viewRef.current;
    setView(zoomAt(v, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor)), at));
  };

  const openNode = (n: CanvasNode, newTab = false) => {
    const kind = cardKind(n);
    if (kind === "text") setEditing(n.id);
    else if (kind === "group") setEditing(n.id);
    else if (kind === "note") openNote((n.file ?? "").split(/[\\/]/).pop()!.replace(/\.md$/i, ""), newTab);
    else if (kind === "issue") void openIssue(String(n.issue), { browser: newTab });
    else if (kind === "link" && n.url) void openUrl(n.url).catch((e) => useApp.getState().error(t("canvas.openFailed"), e));
    else if (kind === "image" || kind === "file") void api.openAttachment((n.file ?? "").split(/[\\/]/).pop()!).catch((e) => useApp.getState().error(t("canvas.openFailed"), e));
  };

  const openNote = async (target: string, newTab: boolean) => {
    try {
      await save();
      const p = await api.resolvePage(target, true);
      if (!p) return;
      if (!useApp.getState().pages.has(p.id)) await useApp.getState().refreshTree();
      useApp.getState().openPage(p.id, { newTab });
    } catch (e) {
      useApp.getState().error(t("canvas.openFailed"), e);
    }
  };
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;

  // The cards' callbacks: one stable object, so memoized cards do not re-render for them.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const host = useMemo<CardHost>(() => {
    const embed: EmbedHost = { stack: [], depth: 1, onOpen: (target, newTab) => void openNoteRef.current(target, newTab), hideTitleHeading: true };
    Object.defineProperty(embed, "stack", { get: () => [titleRef.current.toLowerCase()] });
    return {
      embed,
      onText: (id, text) => commitRef.current(patchNode(docRef.current, id, { text }), false),
      onEndEdit: () => {
        history.current.settle(serializeCanvas(docRef.current));
        setEditing(null);
        focusBoard();
      },
      onLabel: (id, label) => {
        const n = docRef.current.nodes.find((x) => x.id === id);
        if (n && (n.label ?? "") !== label) commitRef.current(patchNode(docRef.current, id, { label: label || undefined }));
        setEditing(null);
        focusBoard();
      },
      openNote: (title, newTab) => void openNoteRef.current(title, newTab),
    };
  }, []);

  const startEdit = (id: string) => {
    // One undo step for the whole edit.
    history.current.record(serializeCanvas(docRef.current));
    setEditing(id);
  };
  useEffect(() => {
    if (editing && docRef.current.nodes.find((n) => n.id === editing)?.type === "text") history.current.record(serializeCanvas(docRef.current));
  }, [editing]);

  const setEdgeLabel = (id: string, label: string) => {
    const e = docRef.current.edges.find((x) => x.id === id);
    if (e && (e.label ?? "") !== label) commit(patchEdge(docRef.current, id, { label: label || undefined }));
    setEditingEdge(null);
    focusBoard();
  };

  // ------------------------------------------------------------------ pointer gestures

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, .cv-chrome")) return;
    if (e.button === 2) return;
    const p = toWorld(e.clientX, e.clientY);
    pointer.current = p;
    const board = rootRef.current!;
    const capture = () => board.setPointerCapture(e.pointerId);
    focusBoard();
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      e.preventDefault();
      gesture.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, view: viewRef.current };
      setPanning(true);
      return capture();
    }
    if (e.button !== 0) return;
    const handle = target.closest<HTMLElement>("[data-handle]");
    const connect = target.closest<HTMLElement>("[data-connect]");
    const nodeEl = target.closest<HTMLElement>("[data-node]");
    const edgeEl = target.closest<HTMLElement>("[data-edge]");
    if (editing && nodeEl?.dataset.node !== editing) setEditing(null);
    if (handle && nodeEl) {
      const n = docRef.current.nodes.find((x) => x.id === nodeEl.dataset.node)!;
      history.current.record(serializeCanvas(docRef.current));
      gesture.current = { kind: "resize", start: p, id: n.id, handle: handle.dataset.handle as Handle, rect: { x: n.x, y: n.y, width: n.width, height: n.height } };
      e.preventDefault();
      return capture();
    }
    if (connect && nodeEl) {
      gesture.current = { kind: "connect", from: nodeEl.dataset.node!, side: connect.dataset.connect as Side, start: p };
      e.preventDefault();
      return capture();
    }
    if (edgeEl && !nodeEl) {
      const id = edgeEl.dataset.edge!;
      setSelEdges((s) => (e.shiftKey ? toggle(s, id) : new Set([id])));
      if (!e.shiftKey) setSel(new Set());
      return;
    }
    if (nodeEl) {
      const id = nodeEl.dataset.node!;
      if (editing === id) return;
      // Text selection and links inside a card's content stay usable while it is not dragged.
      let next = sel;
      if (e.shiftKey) next = toggle(sel, id);
      else if (!sel.has(id)) next = new Set([id]);
      setSel(next);
      if (!e.shiftKey) setSelEdges(new Set());
      const d = docRef.current;
      const lead = d.nodes.find((n) => n.id === id)!;
      if (!next.has(id)) return;
      history.current.record(serializeCanvas(d));
      gesture.current = { kind: "move", start: p, ids: movingIds(d.nodes, next), doc: d, lead, moved: false, clickId: !e.shiftKey && sel.has(id) && sel.size > 1 ? id : null };
      e.preventDefault();
      return capture();
    }
    // Empty board: box selection.
    const base = e.shiftKey ? new Set(sel) : new Set<string>();
    if (!e.shiftKey) {
      setSel(new Set());
      setSelEdges(new Set());
    }
    gesture.current = { kind: "box", start: p, base };
    capture();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = toWorld(e.clientX, e.clientY);
    pointer.current = p;
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      setView({ ...g.view, x: g.view.x + e.clientX - g.start.x, y: g.view.y + e.clientY - g.start.y });
    } else if (g.kind === "box") {
      const r = boxOf(g.start, p);
      setBox(r);
      const hit = docRef.current.nodes.filter((n) => (n.type === "group" ? contains(r, n) : intersects(r, n))).map((n) => n.id);
      setSel(new Set([...g.base, ...hit]));
    } else if (g.kind === "move") {
      let dx = p.x - g.start.x;
      let dy = p.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) * viewRef.current.zoom < 3) return;
      g.moved = true;
      if (snapOn && !e.altKey) {
        dx = snap(g.lead.x + dx) - g.lead.x;
        dy = snap(g.lead.y + dy) - g.lead.y;
      }
      commit(moveNodes(g.doc, g.ids, dx, dy), false);
    } else if (g.kind === "resize") {
      let r = resizeRect(g.rect, g.handle, p.x - g.start.x, p.y - g.start.y);
      if (snapOn && !e.altKey) r = snapRect(r);
      commit(patchNode(docRef.current, g.id, { ...r }), false);
    } else if (g.kind === "connect") {
      const from = docRef.current.nodes.find((n) => n.id === g.from);
      if (!from) return;
      const r = from;
      const a = g.side === "top" ? { x: r.x + r.width / 2, y: r.y } : g.side === "bottom" ? { x: r.x + r.width / 2, y: r.y + r.height } : g.side === "left" ? { x: r.x, y: r.y + r.height / 2 } : { x: r.x + r.width, y: r.y + r.height / 2 };
      setDraft({ from: a, fromSide: g.side, to: p });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toWorld(e.clientX, e.clientY);
    if (g.kind === "pan") setPanning(false);
    if (g.kind === "box") setBox(null);
    if (g.kind === "move") {
      if (!g.moved && g.clickId) setSel(new Set([g.clickId]));
      history.current.settle(serializeCanvas(docRef.current));
    }
    if (g.kind === "resize") history.current.settle(serializeCanvas(docRef.current));
    if (g.kind === "connect") {
      setDraft(null);
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-node]");
      const toId = under?.dataset.node;
      const d = docRef.current;
      if (toId && toId !== g.from) {
        const to = d.nodes.find((n) => n.id === toId)!;
        const edge: CanvasEdge = { id: newId(), fromNode: g.from, fromSide: g.side, toNode: toId, toSide: nearestSide(to, p), toEnd: "arrow" };
        commit({ ...d, edges: [...d.edges, edge] });
        setSelEdges(new Set([edge.id]));
        setSel(new Set());
      } else if (!toId && Math.hypot(p.x - g.start.x, p.y - g.start.y) > 30) {
        // Dropped on the board: a new card there, connected.
        const node = place("text", p, { text: "" });
        const side: Side = g.side === "right" ? "left" : g.side === "left" ? "right" : g.side === "top" ? "bottom" : "top";
        const edge: CanvasEdge = { id: newId(), fromNode: g.from, fromSide: g.side, toNode: node.id, toSide: side, toEnd: "arrow" };
        const next = withNode(d, node);
        commit({ ...next, edges: [...next.edges, edge] });
        setSel(new Set([node.id]));
        setEditing(node.id);
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // The board holds the pointer capture of the clicks before: the element under the pointer counts.
    const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) ?? (e.target as HTMLElement);
    if (target.closest("input, textarea, .cv-chrome, .cv-note-open")) return;
    const nodeEl = target.closest<HTMLElement>("[data-node]");
    const edgeEl = target.closest<HTMLElement>("[data-edge]");
    if (nodeEl) {
      const n = docRef.current.nodes.find((x) => x.id === nodeEl.dataset.node);
      if (!n) return;
      if (n.type === "group" && !target.closest(".cv-group-label")) return addText(toWorld(e.clientX, e.clientY));
      if (cardKind(n) === "text" || n.type === "group") startEdit(n.id);
      else openNode(n, e.ctrlKey || e.metaKey);
      return;
    }
    if (edgeEl) return setEditingEdge(edgeEl.dataset.edge!);
    addText(toWorld(e.clientX, e.clientY));
  };

  // Wheel: pan; Ctrl/pinch: zoom around the pointer. Scrollable card content keeps its wheel.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      if (!e.ctrlKey && !e.metaKey) {
        const scroller = target.closest<HTMLElement>(".cv-scroll, .cv-text-input");
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
          const down = e.deltaY > 0;
          const can = down ? scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1 : scroller.scrollTop > 0;
          if (can) return;
        }
      }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const v = viewRef.current;
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        setView(zoomAt(v, Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor)), { x: e.clientX - r.left, y: e.clientY - r.top }));
      } else {
        const line = e.deltaMode === 1 ? 32 : 1;
        const v = viewRef.current;
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * line;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * line;
        setView({ ...v, x: v.x - dx, y: v.y - dy });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [page]);

  // ------------------------------------------------------------------ keyboard

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(e)) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === " ") {
      e.preventDefault();
      spaceDown.current = true;
      setPanning(true);
      return;
    }
    if (mod && k === "z") {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && k === "y") {
      e.preventDefault();
      return redo();
    }
    if (mod && k === "a") {
      e.preventDefault();
      setSel(new Set(docRef.current.nodes.map((n) => n.id)));
      return;
    }
    if (mod && k === "d") {
      e.preventDefault();
      return duplicate();
    }
    if (mod && (k === "c" || k === "x")) {
      // The copy event writes the system clipboard; this copy serves when it does not come.
      copySelection();
      if (k === "x") window.setTimeout(removeSelection, 0);
      return;
    }
    if (mod && k === "v") {
      pasteSeen.current = false;
      window.setTimeout(() => {
        if (!pasteSeen.current && memClip.current) paste(memClip.current);
      }, 60);
      return;
    }
    if (mod) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      return removeSelection();
    }
    if (e.key === "Escape") {
      if (editing || editingEdge) {
        setEditing(null);
        setEditingEdge(null);
      } else {
        setSel(new Set());
        setSelEdges(new Set());
      }
      return;
    }
    if (e.key === "Enter" && sel.size === 1) {
      e.preventDefault();
      const n = docRef.current.nodes.find((x) => sel.has(x.id));
      if (n && (cardKind(n) === "text" || n.type === "group")) startEdit(n.id);
      else if (n) openNode(n);
      return;
    }
    if (e.key === "Enter" && selEdges.size === 1) {
      e.preventDefault();
      return setEditingEdge([...selEdges][0]);
    }
    const arrows: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const dir = arrows[e.key];
    if (dir && sel.size) {
      e.preventDefault();
      const step = e.shiftKey ? GRID * 5 : snapOn ? GRID : 1;
      commit(moveNodes(docRef.current, movingIds(docRef.current.nodes, sel), dir.x * step, dir.y * step));
      return;
    }
    if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) {
      e.preventDefault();
      fit();
    }
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === " ") {
      spaceDown.current = false;
      if (!gesture.current) setPanning(false);
    }
  };

  // ------------------------------------------------------------------ clipboard & drop

  const onCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input, textarea") || !sel.size) return;
    const p = copySelection();
    if (!p) return;
    e.preventDefault();
    const json = JSON.stringify(p);
    e.clipboardData.setData(CLIP_MIME, json);
    e.clipboardData.setData("text/plain", json);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    pasteSeen.current = true;
    e.preventDefault();
    const at = pointer.current && contains(visibleRect, { ...pointer.current, width: 0, height: 0 }) ? pointer.current : viewCenter();
    const ours = readPayload(e.clipboardData.getData(CLIP_MIME)) ?? readPayload(e.clipboardData.getData("text/plain"));
    if (ours) return paste(ours, at);
    const files = [...e.clipboardData.files];
    if (files.length) return void addFiles(files, at);
    const text = e.clipboardData.getData("text/plain").trim();
    if (!text) {
      if (memClip.current) paste(memClip.current);
      return;
    }
    if (/^https?:\/\/\S+$/i.test(text)) return addLink(text, at);
    addNodes([place("text", at, { text })]);
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const types = [...e.dataTransfer.types];
    if (types.includes(PLAN_MIME) || types.includes(PAGE_MIME) || types.includes("Files") || types.includes("text/uri-list")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const at = toWorld(e.clientX, e.clientY);
    const item = readPlanData(e.dataTransfer);
    if (item?.kind === "page") {
      e.preventDefault();
      return void addNotes([item.page_id], at);
    }
    if (item?.kind === "issue") {
      e.preventDefault();
      return addIssue(item.key, item.summary, at);
    }
    if (item?.kind === "task") {
      e.preventDefault();
      return void addNotes([item.page_id], at);
    }
    const files = [...e.dataTransfer.files];
    if (files.length) {
      e.preventDefault();
      return void addFiles(files, at);
    }
    const url = e.dataTransfer.getData("text/uri-list").split("\n").find((l) => l && !l.startsWith("#"));
    if (url) {
      e.preventDefault();
      addLink(url.trim(), at);
    }
  };

  // ------------------------------------------------------------------ export

  const runExport = useCallback((format: CanvasExportFormat, path?: string) => {
    const el = rootRef.current;
    if (el) void exportCanvas(docRef.current, el, titleRef.current, format, path);
  }, []);
  useEffect(() => {
    const onExport = (e: Event) => {
      const d = (e as CustomEvent<{ pageId: number; format: CanvasExportFormat; path: string }>).detail;
      if (d?.pageId === pageId && d.path) runExport(d.format, d.path);
    };
    window.addEventListener(CANVAS_EXPORT_EVENT, onExport);
    return () => window.removeEventListener(CANVAS_EXPORT_EVENT, onExport);
  }, [pageId, runExport]);

  // ------------------------------------------------------------------ menus

  const colorItems = (): MenuEntry[] => [
    { label: t("canvas.color.none"), onSelect: () => setColor(undefined) },
    ...PRESET_COLORS.map((c) => ({ label: t(`canvas.color.${c}` as "canvas.color.1"), onSelect: () => setColor(c) })),
  ];

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, .cv-chrome")) return;
    e.preventDefault();
    const at = toWorld(e.clientX, e.clientY);
    const nodeEl = target.closest<HTMLElement>("[data-node]");
    const edgeEl = target.closest<HTMLElement>("[data-edge]");
    if (nodeEl) {
      const id = nodeEl.dataset.node!;
      if (!sel.has(id)) {
        setSel(new Set([id]));
        setSelEdges(new Set());
      }
      const n = docRef.current.nodes.find((x) => x.id === id)!;
      const kind = cardKind(n);
      openMenu(e, [
        ...(kind === "text" || kind === "group" ? [{ label: t("canvas.menu.edit"), icon: Pencil, shortcut: keys("Enter"), onSelect: () => startEdit(id) }] : [{ label: t("canvas.menu.open"), icon: FileText, shortcut: keys("Enter"), onSelect: () => openNode(n) }]),
        { label: t("canvas.menu.color"), submenu: colorItems() as never },
        { label: t("canvas.menu.group"), icon: GroupIcon, onSelect: addGroup },
        { label: t("canvas.menu.front"), onSelect: bringToFront },
        "separator",
        { label: t("canvas.menu.duplicate"), icon: Copy, shortcut: keys("Mod D"), onSelect: duplicate },
        { label: t("canvas.menu.delete"), icon: Trash2, shortcut: keys("Delete"), danger: true, onSelect: removeSelection },
      ]);
      return;
    }
    if (edgeEl) {
      const id = edgeEl.dataset.edge!;
      setSelEdges(new Set([id]));
      setSel(new Set());
      const edge = docRef.current.edges.find((x) => x.id === id)!;
      openMenu(e, [
        { label: t("canvas.edge.editLabel"), icon: Pencil, onSelect: () => setEditingEdge(id) },
        { label: t("canvas.menu.color"), submenu: colorItems() as never },
        { label: t("canvas.edge.arrow"), icon: ArrowRight, checked: (edge.toEnd ?? "arrow") === "arrow", onSelect: () => commit(patchEdge(docRef.current, id, { toEnd: (edge.toEnd ?? "arrow") === "arrow" ? "none" : "arrow" })) },
        { label: t("canvas.edge.straight"), icon: Spline, checked: edge.path === "straight", onSelect: () => commit(patchEdge(docRef.current, id, { path: edge.path === "straight" ? undefined : "straight" })) },
        "separator",
        { label: t("canvas.menu.delete"), icon: Trash2, danger: true, onSelect: () => commit(removeItems(docRef.current, new Set(), new Set([id]))) },
      ]);
      return;
    }
    openMenu(e, [
      { label: t("canvas.add.text"), icon: StickyNote, onSelect: () => addText(at) },
      { label: t("canvas.add.note"), icon: FileText, onSelect: () => setDialog("note") },
      { label: t("canvas.add.file"), icon: ImagePlus, onSelect: () => void pickFiles() },
      { label: t("canvas.add.link"), icon: Link2, onSelect: () => setDialog("link") },
      { label: t("canvas.add.group"), icon: GroupIcon, onSelect: addGroup },
      "separator",
      ...(memClip.current ? [{ label: t("canvas.menu.paste"), shortcut: keys("Mod V"), onSelect: () => paste(memClip.current!, at) }] : []),
      { label: t("canvas.menu.selectAll"), icon: BoxSelect, shortcut: keys("Mod A"), onSelect: () => setSel(new Set(docRef.current.nodes.map((n) => n.id))) },
      { label: t("canvas.zoom.fit"), icon: Maximize, shortcut: keys("Shift 1"), onSelect: fit },
    ]);
  };

  const exportMenu = (el: Element) =>
    openMenuAt(el, [
      { label: t("canvas.export.png"), icon: Download, onSelect: () => runExport("png") },
      { label: t("canvas.export.svg"), icon: Download, onSelect: () => runExport("svg") },
      { label: t("canvas.export.html"), icon: Download, onSelect: () => runExport("html") },
    ]);

  // ------------------------------------------------------------------ render

  if (missing)
    return (
      <>
        <ViewHeader tab={tab} title={t("pv.notFound")} />
        <div className="center-fill faint">{t("pv.notFoundText")}</div>
      </>
    );
  if (unreadable)
    return (
      <>
        <ViewHeader tab={tab} title={page?.title ?? ""} />
        <div className="center-fill cv-unreadable">
          <strong>{t("canvas.unreadable")}</strong>
          <span className="faint">{t("canvas.unreadableText")}</span>
        </div>
      </>
    );

  // Edges live in canvas units: panning and zooming never redraw them, only changes do.
  const margin = 300 / view.zoom;
  const shown = visibleNodes(doc.nodes, visibleRect, margin);
  rendered.current = size.width ? { zoom: view.zoom, rect: { x: visibleRect.x - margin * 0.8, y: visibleRect.y - margin * 0.8, width: visibleRect.width + margin * 1.6, height: visibleRect.height + margin * 1.6 } } : null;
  const edges = doc.edges;
  const lod = view.zoom < LOD_ZOOM;
  const single = sel.size === 1;
  const selBounds = bounds(doc.nodes.filter((n) => sel.has(n.id)));
  const selEdge = selEdges.size === 1 ? doc.edges.find((e) => selEdges.has(e.id)) : undefined;
  const barAt = (() => {
    if (editing || gesture.current?.kind === "move" || gesture.current?.kind === "resize") return null;
    let r: Rect | null = selBounds;
    if (!r && selEdge) {
      const a = nodeMap.get(selEdge.fromNode);
      const b = nodeMap.get(selEdge.toNode);
      r = a && b ? bounds([a, b]) : null;
    }
    if (!r) return null;
    const x = r.x * view.zoom + view.x + (r.width * view.zoom) / 2;
    const top = r.y * view.zoom + view.y;
    const y = top > 70 ? top - 52 : r.y * view.zoom + view.y + r.height * view.zoom + 12;
    return { x: Math.max(160, Math.min(size.width - 160, x)), y: Math.max(8, Math.min(size.height - 60, y)) };
  })();
  const zoomPct = Math.round(view.zoom * 100);
  const gridStep = gridStepOf(view.zoom);

  return (
    <div className="canvas-view">
      <ViewHeader
        tab={tab}
        title={title}
        actions={
          <>
            <IconButton icon={Undo2} label={`${t("canvas.undo")} (${keys("Mod Z")})`} disabled={!history.current.canUndo} onClick={undo} />
            <IconButton icon={Redo2} label={`${t("canvas.redo")} (${keys("Mod Shift Z")})`} disabled={!history.current.canRedo} onClick={redo} />
            <IconButton icon={MoreHorizontal} label={t("canvas.export")} onClick={(e) => exportMenu(e.currentTarget)} />
          </>
        }
      />
      <div className="cv-conflict">
        <ConflictBanner pageId={pageId} />
      </div>
      <div
        ref={rootRef}
        className={`cv-board${panning ? " is-panning" : ""}${snapOn ? " is-snapping" : ""}`}
        tabIndex={0}
        role="application"
        aria-label={t("canvas.board", { title })}
        data-canvas={pageId}
        style={{ ["--cv-zoom" as string]: view.zoom }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCopy={onCopy}
        onCut={(e) => {
          onCopy(e);
          if (sel.size) removeSelection();
        }}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onContextMenu={onContextMenu}
      >
        <div ref={gridRef} className="cv-grid" aria-hidden style={{ transform: gridTransform(view), backgroundSize: `${gridStep}px ${gridStep}px` }} />
        {!page ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : (
          <div ref={worldRef} className="cv-world" style={{ transform: worldTransform(view) }}>
            {shown.filter((n) => n.type === "group").map((n) => (
              <Group key={n.id} node={n} selected={sel.has(n.id)} single={single} editing={editing === n.id} host={host} />
            ))}
            <EdgeLayer edges={edges} nodes={nodeMap} selected={selEdges} draft={draft} />
            {shown.filter((n) => n.type !== "group").map((n) => (
              <Card key={n.id} node={n} kind={cardKind(n)} selected={sel.has(n.id)} single={single} editing={editing === n.id} lod={lod} host={host} />
            ))}
            <EdgeLabels edges={edges} nodes={nodeMap} selected={selEdges} editing={editingEdge} onLabel={setEdgeLabel} />
            {box && <div className="cv-box" style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.width, height: box.height }} />}
          </div>
        )}
        {page && !doc.nodes.length && (
          <div className="cv-empty">
            <span className="empty-icon" aria-hidden>
              <LayoutDashboard size={20} strokeWidth={1.5} />
            </span>
            <div className="cv-empty-title">{t("canvas.empty.title")}</div>
            <div className="cv-empty-text">{t("canvas.empty.text")}</div>
          </div>
        )}

        {barAt && (
          <div className="cv-chrome cv-selbar" style={{ left: barAt.x, top: barAt.y }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="cv-swatches" role="group" aria-label={t("canvas.menu.color")}>
              <button type="button" className="cv-swatch cv-swatch-none" title={t("canvas.color.none")} aria-label={t("canvas.color.none")} onClick={() => setColor(undefined)} />
              {PRESET_COLORS.map((c) => (
                <button key={c} type="button" className="cv-swatch" data-color={c} style={{ ["--cv-color" as string]: `var(--cv-c${c})` }} title={t(`canvas.color.${c}` as "canvas.color.1")} aria-label={t(`canvas.color.${c}` as "canvas.color.1")} onClick={() => setColor(c)} />
              ))}
            </div>
            {sel.size > 1 && (
              <>
                <span className="cv-sep" />
                <IconButton aria-haspopup="menu"
                  icon={AlignStartVertical}
                  label={t("canvas.align")}
                  onClick={(e) =>
                    openMenuAt(e.currentTarget, [
                      { label: t("canvas.align.left"), icon: AlignStartVertical, onSelect: () => align("left") },
                      { label: t("canvas.align.hcenter"), icon: AlignCenterVertical, onSelect: () => align("hcenter") },
                      { label: t("canvas.align.right"), icon: AlignEndVertical, onSelect: () => align("right") },
                      "separator",
                      { label: t("canvas.align.top"), icon: AlignStartHorizontal, onSelect: () => align("top") },
                      { label: t("canvas.align.vcenter"), icon: AlignCenterHorizontal, onSelect: () => align("vcenter") },
                      { label: t("canvas.align.bottom"), icon: AlignEndHorizontal, onSelect: () => align("bottom") },
                      "separator",
                      { label: t("canvas.distribute.x"), icon: AlignHorizontalDistributeCenter, disabled: sel.size < 3, onSelect: () => distribute("x") },
                      { label: t("canvas.distribute.y"), icon: AlignVerticalDistributeCenter, disabled: sel.size < 3, onSelect: () => distribute("y") },
                    ])
                  }
                />
              </>
            )}
            {sel.size > 0 && <IconButton icon={GroupIcon} label={t("canvas.menu.group")} onClick={addGroup} />}
            {selEdge && !sel.size && (
              <>
                <span className="cv-sep" />
                <IconButton icon={Pencil} label={t("canvas.edge.editLabel")} onClick={() => setEditingEdge(selEdge.id)} />
                <IconButton icon={ArrowRight} label={t("canvas.edge.arrow")} active={(selEdge.toEnd ?? "arrow") === "arrow"} onClick={() => commit(patchEdge(docRef.current, selEdge.id, { toEnd: (selEdge.toEnd ?? "arrow") === "arrow" ? "none" : "arrow" }))} />
                <IconButton icon={Spline} label={t("canvas.edge.straight")} active={selEdge.path === "straight"} onClick={() => commit(patchEdge(docRef.current, selEdge.id, { path: selEdge.path === "straight" ? undefined : "straight" }))} />
              </>
            )}
            <span className="cv-sep" />
            <IconButton icon={Trash2} label={t("canvas.menu.delete")} onClick={removeSelection} />
          </div>
        )}

        {page && (
          <div className="cv-chrome cv-tools" role="toolbar" aria-label={t("canvas.tools")} onPointerDown={(e) => e.stopPropagation()}>
            <IconButton icon={StickyNote} label={t("canvas.add.text")} data-cv-add="text" onClick={() => addText()} />
            <IconButton icon={FileText} label={t("canvas.add.note")} data-cv-add="note" onClick={() => setDialog("note")} />
            <IconButton icon={ImagePlus} label={t("canvas.add.file")} data-cv-add="file" onClick={() => void pickFiles()} />
            <IconButton icon={Link2} label={t("canvas.add.link")} data-cv-add="link" onClick={() => setDialog("link")} />
            <IconButton icon={Ticket} label={t("canvas.add.issue")} data-cv-add="issue" onClick={() => setDialog("issue")} />
            <IconButton icon={GroupIcon} label={t("canvas.add.group")} data-cv-add="group" onClick={addGroup} />
            <span className="cv-sep" />
            <IconButton
              icon={Grid3x3}
              label={snapOn ? t("canvas.snap.on") : t("canvas.snap.off")}
              active={snapOn}
              data-cv-snap
              onClick={() => {
                setSnapOn(!snapOn);
                try {
                  localStorage.setItem(SNAP_KEY, snapOn ? "0" : "1");
                } catch {
                  /* not remembered */
                }
              }}
            />
          </div>
        )}

        {page && (
          <div className="cv-chrome cv-zoom" onPointerDown={(e) => e.stopPropagation()}>
            <IconButton icon={Minus} label={t("canvas.zoom.out")} onClick={() => zoomBy(1 / 1.2)} />
            <button type="button" className="cv-zoom-pct" title={t("canvas.zoom.reset")} onClick={() => setView(zoomAt(viewRef.current, 1, { x: size.width / 2, y: size.height / 2 }))}>
              {zoomPct}%
            </button>
            <IconButton icon={Plus} label={t("canvas.zoom.in")} onClick={() => zoomBy(1.2)} />
            <IconButton icon={Maximize} label={`${t("canvas.zoom.fit")} (${keys("Shift 1")})`} onClick={fit} />
          </div>
        )}

        {page && doc.nodes.length > 0 && size.width > 640 && (
          <div className="cv-chrome cv-minimap-box">
            <Minimap
              nodes={doc.nodes}
              view={visibleRect}
              width={176}
              height={112}
              onJump={(p) => setView({ ...viewRef.current, x: size.width / 2 - p.x * viewRef.current.zoom, y: size.height / 2 - p.y * viewRef.current.zoom })}
            />
          </div>
        )}
      </div>
      {menu}
      {dialog === "note" && <NotePicker onClose={() => setDialog(null)} onPick={(ids) => void addNotes(ids)} exclude={pageId} />}
      {dialog === "link" && (
        <PromptDialog
          title={t("canvas.add.link")}
          label={t("canvas.link.url")}
          placeholder="https://"
          valid={(v) => /^https?:\/\/\S+$/i.test(v.trim())}
          onClose={() => setDialog(null)}
          onSubmit={(v) => addLink(v.trim())}
        />
      )}
      {dialog === "issue" && (
        <PromptDialog
          title={t("canvas.add.issue")}
          label={t("canvas.issue.key")}
          placeholder="SAP-123"
          valid={(v) => /^[A-Z][A-Z0-9_]*-\d+$/.test(v.trim().toUpperCase())}
          onClose={() => setDialog(null)}
          onSubmit={(v) => addIssue(v.trim().toUpperCase())}
        />
      )}
    </div>
  );
}

const worldTransform = (v: View) => `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
/** The dot grid's spacing on screen: coarser when far out. */
function gridStepOf(zoom: number): number {
  let step = GRID * zoom;
  while (step < 12) step *= 5;
  return step;
}
/** The grid is its own layer, shifted by less than one step (never repainted while panning). */
function gridTransform(v: View): string {
  const step = gridStepOf(v.zoom);
  return `translate(${(v.x % step) - step}px, ${(v.y % step) - step}px)`;
}

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Choose pages for note cards: a filter over the page tree. */
function NotePicker({ onClose, onPick, exclude }: { onClose: () => void; onPick: (ids: number[]) => void; exclude: number }) {
  const pages = useApp((s) => s.pages);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const all = [...pages.values()].filter((p) => p.id !== exclude && p.kind !== "canvas" && !p.system);
  const needle = q.trim().toLowerCase();
  const list = (needle ? all.filter((p) => p.title.toLowerCase().includes(needle)) : [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at))).slice(0, 40);
  const pick = (id: number) => {
    onPick([id]);
    onClose();
  };
  return (
    <Dialog open title={t("canvas.add.note")} onClose={onClose}>
      <div className="cv-picker">
        <Input
          autoFocus
          value={q}
          placeholder={t("canvas.note.search")}
          aria-label={t("canvas.note.search")}
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === "ArrowDown") setIndex((i) => Math.min(list.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
            else if (e.key === "Enter" && list[index]) pick(list[index].id);
            else return;
            e.preventDefault();
          }}
        />
        <ul className="cv-picker-list" role="listbox">
          {list.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === index} className={i === index ? "is-active" : ""} onMouseEnter={() => setIndex(i)} onClick={() => pick(p.id)}>
              <FileText size={14} aria-hidden />
              <span>{p.title}</span>
            </li>
          ))}
          {!list.length && <li className="faint">{t("canvas.note.none")}</li>}
        </ul>
      </div>
    </Dialog>
  );
}

function PromptDialog({ title, label, placeholder, valid, onClose, onSubmit }: { title: string; label: string; placeholder: string; valid: (v: string) => boolean; onClose: () => void; onSubmit: (v: string) => void }) {
  const [v, setV] = useState("");
  const ok = valid(v);
  const submit = () => {
    if (!ok) return;
    onSubmit(v);
    onClose();
  };
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!ok} onClick={submit}>
            {t("canvas.add.submit")}
          </Button>
        </>
      }
    >
      <form
        className="cv-prompt"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input autoFocus value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)} />
      </form>
    </Dialog>
  );
}
