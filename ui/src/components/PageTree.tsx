// The page tree of the sidebar: open folders, reveal of the open page, filter with highlighted
// hits, multi-selection with its actions, drag and drop (into folders, between pages, onto the
// empty area, into an editor or a pane), renaming in place and the context menu.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown, ArrowDownUp, ArrowUp, ArrowUpToLine, Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, ClipboardCopy, Columns2, Copy, CornerDownRight, CornerLeftUp, FileDown, FilePlus2, FileText,
  FolderInput, FolderTree, Hash, Link2, MoreHorizontal, MoveVertical, Palette, PencilLine, Plus, Shapes, Star, StarOff, Trash2, Type, Wand2, X,
} from "lucide-react";
import { api, errorParts } from "../lib/api";
import { cleanTitleChars } from "../lib/links";
import { renamePageWithUndo } from "../editor/rename";
import { useApp } from "../store/app";
import { PAGE_ICONS, PageIcon, iconLabel } from "./icons";
import { Button, Dialog, IconButton, Input, anchorMenu, useMenu, type MenuEntry, type MenuItem } from "./ui";
import type { LucideIcon } from "lucide-react";
import { deletePage } from "../views/PageView";
import { isCanvas } from "../views/canvas/create";
import { COLLAPSED_EVENT, migrateCollapsed, pruneIds, readExpanded, readOldCollapsed, writeExpanded } from "../lib/collapsed";
import type { PageNode } from "../lib/types";
import { t as tStatic, type TKey } from "../lib/i18n";
import { keys } from "../lib/shortcut";
import { PAGE_MIME, PAGES_MIME } from "../lib/blocks";
import {
  DEFAULT_STYLE, FOLDER_COLORS, FOLDER_SORTS, filingApi, filterIds, isWithin, matchRanges, planDrop, rangeIds, renameProblem, sortNodes, topSelected, typeahead,
  type DropPlan, type DropPos, type FolderStyle,
} from "../lib/filing";
import { movePages, openMoveTo, openTidyUp } from "./FilingDialogs";
import { isComposing } from "../lib/ime";
import { withTag } from "../lib/frontmatter";
import { newMenuItems, TREE_RENAME_EVENT, createNew } from "./newItems";
import { isTypeaheadKey, titleIfCut, typeaheadText } from "./treeKeys";
import { treeWindow as treeWindowOf } from "../lib/treeWindow";

/** Trees with this many visible rows render only the rows in view (plus a margin). */
const VIRTUAL_ROWS = 150;
/** A collapsed folder held under a dragged page this long opens. */
const DRAG_OPEN_MS = 650;
/** While dragging, this close to the top or bottom edge the tree scrolls. */
const DRAG_SCROLL_EDGE = 28;

const s = useApp.getState;
const parentOf = (id: number) => s().pages.get(id)?.parent_id;

// ------------------------------------------------------------------ open folders

export interface TreeOpen {
  /** Open folders: opened by hand (stored) or for the open page (until another page opens). */
  open: Set<number>;
  toggle: (id: number) => void;
  /** Opens folders for good (a drop into them, a new subpage). */
  expand: (ids: number[]) => void;
  /** Opens the ancestors of the open page; `add` keeps the ones opened so before. */
  reveal: (ids: number[], add?: boolean) => void;
  setAll: (ids: number[]) => void;
}

/**
 * The open folders of the tree. Folders start collapsed; the stored list holds the ones opened
 * by hand, revealing the open page opens its ancestors only until another page is revealed,
 * and pages that are gone leave the list.
 */
export function useTreeOpen(tree: PageNode[]): TreeOpen {
  const [expanded, setExpanded] = useState<Set<number>>(() => readExpanded() ?? new Set());
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const stored = useRef(readExpanded() != null);
  const save = (next: Set<number>) => {
    stored.current = true;
    setExpanded(next);
    writeExpanded(next);
  };
  useEffect(() => {
    const on = () => setExpanded(readExpanded() ?? new Set());
    window.addEventListener(COLLAPSED_EVENT, on);
    return () => window.removeEventListener(COLLAPSED_EVENT, on);
  }, []);
  useEffect(() => {
    if (!tree.length) return;
    const pages = s().pages;
    if (!stored.current) {
      // The first start (or the first after 1.18): the folders there are now stay as they were
      // (open, the daily notes collapsed); folders that come later start collapsed.
      const dailyFolder = s().settings?.settings.notes?.daily_folder || tStatic("fl.default.journal");
      const daily = (p: PageNode) => p.system === "journal" || (p.parent_id == null && p.title === dailyFolder);
      const folders = [...pages.values()].filter((p) => p.children.length);
      save(migrateCollapsed(readOldCollapsed() ?? folders.filter(daily).map((p) => p.id), folders.map((p) => p.id)));
      return;
    }
    const alive = (id: number) => pages.has(id);
    const kept = pruneIds(expanded, alive);
    if (kept !== expanded) save(kept);
    setRevealed((r) => pruneIds(r, alive));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree]);
  const open = useMemo(() => (revealed.size ? new Set([...expanded, ...revealed]) : expanded), [expanded, revealed]);
  return {
    open,
    toggle: (id) => {
      if (open.has(id)) {
        const next = new Set(expanded);
        next.delete(id);
        save(next);
        if (revealed.has(id)) setRevealed((r) => new Set([...r].filter((x) => x !== id)));
      } else save(new Set(expanded).add(id));
    },
    expand: (ids) => {
      if (ids.every((id) => expanded.has(id))) return;
      save(new Set([...expanded, ...ids]));
    },
    reveal: (ids, add) =>
      setRevealed((r) => {
        const next = new Set(add ? [...r, ...ids] : ids);
        return next.size === r.size && [...next].every((id) => r.has(id)) ? r : next;
      }),
    setAll: (ids) => {
      save(new Set(ids));
      setRevealed(new Set());
    },
  };
}

// ------------------------------------------------------------------ helpers

/** Renames a page with its links rewritten; the toast undoes it. */
const renameInTree = (n: PageNode, title: string) => renamePageWithUndo(n.id, n.title, title);

/** The stored order of a page's siblings (the top level for `null`). */
const childrenOf = (parent: number | null | undefined) => (parent == null ? s().tree : (s().pages.get(parent)?.children ?? []));
/** The style of a folder's children (the top level for `null`). */
const styleOf = (parent: number | null | undefined, rootStyle: FolderStyle) => (parent == null ? rootStyle : (s().pages.get(parent)?.style ?? DEFAULT_STYLE));
const isSorted = (style: FolderStyle) => style.sort !== "manual";
const sortName = (style: FolderStyle) => tStatic(`fl.sort.${style.sort}` as TKey);
const folderName = (id: number | null | undefined) => (id == null ? tStatic("fl.topLevel") : (s().pages.get(id)?.title ?? ""));

/** „Sortieren“: the order of a folder's children and „Ordner zuerst“. */
export function sortMenu(style: FolderStyle, set: (s: FolderStyle) => void): MenuItem[] {
  return [
    ...FOLDER_SORTS.map((sort) => ({ label: tStatic(`fl.sort.${sort}` as TKey), checked: style.sort === sort, onSelect: () => set({ ...style, sort }) })),
    { label: tStatic("fl.foldersFirst"), icon: FolderTree, checked: style.folders_first, onSelect: () => set({ ...style, folders_first: !style.folders_first }) },
  ];
}

/** Color dots for the „Farbe“ menu (theme tokens, so they follow light and dark). */
const SWATCHES = Object.fromEntries(
  FOLDER_COLORS.map((c) => [c, (({ size = 14 }: { size?: number }) => <span className={`tree-swatch tint-${c}`} style={{ width: size - 4, height: size - 4 }} aria-hidden />) as unknown as LucideIcon]),
) as Record<string, LucideIcon>;

const copyText = (text: string, what: string) =>
  navigator.clipboard.writeText(text).then(
    () => s().toast({ tone: "success", title: tStatic("sb.copied", { what }) }),
    (e) => s().error(tStatic("sb.copyFailed"), e),
  );

/** Moves through „Verschieben“: one path for every move, each with its „Rückgängig“. */
const moveTo = (ids: number[], parent: number | null, position: number | null) => movePages(ids, parent, position);

async function setStyles(ids: number[], change: (st: FolderStyle) => FolderStyle) {
  try {
    for (const id of ids) await filingApi.setFolderStyle(id, change(s().pages.get(id)?.style ?? DEFAULT_STYLE));
    await s().refreshTree();
  } catch (e) {
    s().error(tStatic("fl.styleFailed"), e);
  }
}

async function setIcon(id: number, icon: string) {
  try {
    await api.setIcon(id, icon);
    await s().refreshTree();
  } catch (e) {
    s().error(tStatic("sb.iconFailed"), e);
  }
}

/** A copy of the page right after it (a canvas stays a canvas); returns it. */
async function duplicate(n: PageNode): Promise<number | null> {
  try {
    const doc = await api.page(n.id);
    const title = tStatic("sb.copyTitle", { title: n.title });
    const p = isCanvas(n) ? await api.createCanvas(title, n.parent_id) : await api.createPage(title, n.parent_id, n.icon, doc.content);
    if (isCanvas(n)) await api.savePage(p.id, doc.content);
    const i = childrenOf(n.parent_id).findIndex((x) => x.id === n.id);
    await api.movePage(p.id, n.parent_id, i + 1);
    return p.id;
  } catch (e) {
    s().error(tStatic("sb.duplicateFailed"), e);
    return null;
  }
}

/** Favorite on for all of them, or off when all are favorites already. */
async function favoriteMany(ids: number[]) {
  const on = !ids.every((id) => s().pages.get(id)?.favorite);
  try {
    for (const id of ids) await api.setFavorite(id, on);
    await s().refreshTree();
    s().toast({ tone: "success", title: tStatic(on ? "sb.favoritedMany" : "sb.unfavoritedMany", { n: ids.length }) });
  } catch (e) {
    s().error(tStatic("sb.favoriteFailed"), e);
  }
}

async function duplicateMany(ids: number[]) {
  let n = 0;
  for (const id of ids) {
    const node = s().pages.get(id);
    if (node && (await duplicate(node)) != null) n++;
    // The next copy goes after its page in the order as it is now.
    await s().refreshTree();
  }
  if (n) s().toast({ tone: "success", title: tStatic("sb.duplicatedMany", { n }) });
}

/** The tag goes into the pages' properties (`tags`); canvases have none. */
async function tagMany(ids: number[], tag: string) {
  const clean = tag.trim().replace(/^#/, "");
  if (!clean) return;
  const { updateFrontmatter } = await import("../views/collection/write");
  let n = 0;
  try {
    for (const id of ids) {
      const node = s().pages.get(id);
      if (!node || isCanvas(node)) continue;
      await updateFrontmatter(id, (fm) => withTag(fm, clean));
      n++;
    }
    await s().refreshTree();
    s().toast({ tone: "success", title: tStatic("sb.taggedMany", { tag: clean, n }) });
  } catch (e) {
    s().error(tStatic("sb.tagFailed"), e);
  }
}

async function exportMany(ids: number[]) {
  const { sharePageAsHtml } = await import("../editor/shareHtml");
  await sharePageAsHtml(ids, false);
}

/** The title with the filter's matches marked. */
function marked(title: string, query: string, fuzzy: boolean): ReactNode {
  const ranges = matchRanges(title, query, fuzzy);
  if (!ranges.length) return title;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], k) => {
    if (a > at) out.push(title.slice(at, a));
    out.push(<mark key={k} className="tree-mark">{title.slice(a, b)}</mark>);
    at = b;
  });
  if (at < title.length) out.push(title.slice(at));
  return out;
}

// ------------------------------------------------------------------ the tree

/** Handlers of a tree row; one stable object, so rows can skip re-rendering. Rows pass their id:
 *  the handlers take the page as it is now (a row may skip a refresh that changed nothing it shows). */
interface RowActions {
  toggle: (id: number) => void;
  open: (id: number, e: React.MouseEvent) => void;
  menu: (id: number, e: React.MouseEvent) => void;
  menuAt: (id: number, e: React.MouseEvent) => void;
  key: (id: number, e: React.KeyboardEvent<HTMLDivElement>) => void;
  focus: (id: number) => void;
  dragStart: (id: number, e: DragEvent) => void;
  dragEnd: () => void;
  dragOver: (id: number, e: DragEvent<HTMLDivElement>) => void;
  dragLeave: (id: number) => void;
  drop: (id: number, e: DragEvent<HTMLDivElement>) => void;
  /** Starts renaming the row in place (F2, double click on the title). */
  rename: (id: number) => void;
  /** Ends renaming; `refocus` puts the focus back on the row (Enter, Escape). */
  renameDone: (id: number, refocus: boolean) => void;
  subpage: (id: number) => void;
}

/** What the sidebar can ask of the tree (the filter's Enter, „Im Baum zeigen“). */
export interface TreeHandle {
  openFirstHit: (opts: { newTab?: boolean; split?: boolean }) => boolean;
  revealActive: () => void;
}

interface DragState {
  /** The row dragged. */
  id: number;
  /** The pages moved: the selection when the row is part of it. */
  ids: number[];
  plan?: DropPlan;
  /** The row the pointer is over (`root`: the empty area below the rows). */
  over?: number | "root";
}

/**
 * The visible rows are rendered flat (with `aria-level`), each memoized: switching tabs only
 * re-renders the old and the new active row, collapsing one folder only that row. A large tree
 * renders only the rows in view, positioned in a box of the full height.
 */
export function PageTree({
  nodes,
  activePageId,
  elsewhere,
  tree: treeOpen,
  filter = "",
  rootStyle = DEFAULT_STYLE,
  selectionSlot,
  handle,
}: {
  nodes: PageNode[];
  activePageId?: number;
  /** Pages shown in another pane. */
  elsewhere: Set<number>;
  tree: TreeOpen;
  /** Shows the matching pages and their ancestors. */
  filter?: string;
  /** Sort of the top level. */
  rootStyle?: FolderStyle;
  /** Where the bar of the multi-selection goes (below the scrolling rows). */
  selectionSlot: HTMLElement | null;
  handle: MutableRefObject<TreeHandle | null>;
}) {
  const { open, toggle } = treeOpen;
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDragState] = useState<DragState | null>(null);
  const setDrag = (d: DragState | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  // Multi-select: Shift-click (range), Ctrl/Cmd-click, Shift+arrows, Ctrl+Space.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  // The row renamed in place (its title is an input until Enter, Escape or leaving it).
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menu, openMenu, openMenuAt] = useMenu();
  const [stylePop, setStylePop] = useState<{ ids: number[]; anchor: DOMRect } | null>(null);
  const [tagging, setTagging] = useState<number[] | null>(null);
  // The page opened from the tree itself: revealing it keeps the folders open that were.
  const openedHere = useRef<number | null>(null);

  const selection = () => topSelected(selected, parentOf);
  const clearSelection = () => setSelected(new Set());

  // ------------------------------------------------------------ rows

  // Visible rows in document order, each folder in its own sort; recomputed only when the tree,
  // the open folders or the filter change. A filter shows the hits with their ancestors open.
  const filtered = useMemo(() => filterIds(nodes, filter), [nodes, filter]);
  const rows = useMemo(() => {
    const out: { node: PageNode; depth: number; pos: number; size: number }[] = [];
    const walk = (list: PageNode[], depth: number, style: FolderStyle | null | undefined) => {
      const shown = filtered ? sortNodes(list, style).filter((n) => filtered.shown.has(n.id)) : sortNodes(list, style);
      shown.forEach((n, k) => {
        out.push({ node: n, depth, pos: k + 1, size: shown.length });
        if (n.children.length && (filtered ? true : open.has(n.id))) walk(n.children, depth + 1, n.style);
      });
    };
    walk(nodes, 0, rootStyle);
    return out;
  }, [nodes, open, filtered, rootStyle]);
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.node.id, i])), [rows]);

  // A selection keeps only pages that still exist.
  useEffect(() => {
    if (selected.size && [...selected].some((id) => !s().pages.has(id))) setSelected(new Set([...selected].filter((id) => s().pages.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes]);

  const focusable = activePageId != null && rowIndex.has(activePageId) ? activePageId : rows[0]?.node.id;

  // ------------------------------------------------------------ scrolling and focus

  const treeRef = useRef<HTMLDivElement>(null);
  const scroller = () => treeRef.current?.closest<HTMLElement>(".sidebar-scroll") ?? null;
  // Large trees: the scroll position of the sidebar decides which rows exist.
  const virtual = rows.length >= VIRTUAL_ROWS;
  const [view, setView] = useState({ top: 0, height: 900, rowH: 28 });
  useLayoutEffect(() => {
    const tree = treeRef.current;
    const sc = scroller();
    if (!virtual || !tree || !sc) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const offset = tree.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const rowH = parseFloat(getComputedStyle(tree).getPropertyValue("--tree-row-h")) || 28;
      const next = { top: sc.scrollTop - offset, height: sc.clientHeight, rowH };
      setView((v) => (v.top === next.top && v.height === next.height && v.rowH === next.rowH ? v : next));
    };
    const schedule = () => (frame ||= requestAnimationFrame(update));
    update();
    sc.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(sc);
    // Density (Settings → Darstellung) changes the row height.
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true });
    return () => {
      cancelAnimationFrame(frame);
      sc.removeEventListener("scroll", schedule);
      ro.disconnect();
      mo.disconnect();
    };
  }, [virtual]);

  // WebKit anchors the scroll position to a row when the rendered rows change (overflow-anchor
  // is not supported there): the position before the commit is the one to keep, unless a row is
  // being scrolled into view.
  // `rows`: the rows when it was asked for; a row still missing after they changed is not coming (a filter hides it).
  const pendingScroll = useRef<{ id: number; focus: boolean; rows?: unknown } | null>(null);
  const beforeCommit = useRef<number | null>(null);
  beforeCommit.current = virtual && !pendingScroll.current ? (scroller()?.scrollTop ?? null) : null;
  useLayoutEffect(() => {
    const sc = scroller();
    if (sc && beforeCommit.current != null && sc.scrollTop !== beforeCommit.current) sc.scrollTop = beforeCommit.current;
  });

  /** Scrolls row `i` into view: to the middle when it is out of view, not at all when it is in view. */
  const scrollToRow = (i: number) => {
    const tree = treeRef.current;
    const sc = scroller();
    if (!tree || !sc) return;
    const rowH = parseFloat(getComputedStyle(tree).getPropertyValue("--tree-row-h")) || 28;
    const el = tree.querySelector<HTMLElement>(`.tree-row[data-id="${rows[i]?.node.id}"]`);
    const offset = tree.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const top = virtual || !el ? offset + i * rowH : el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    if (top >= sc.scrollTop && top + rowH <= sc.scrollTop + sc.clientHeight) return;
    sc.scrollTop = Math.max(0, top - sc.clientHeight / 2 + rowH / 2);
  };

  // A row to scroll to (and focus) once it is rendered.
  useLayoutEffect(() => {
    const want = pendingScroll.current;
    if (!want) return;
    const i = rowIndex.get(want.id);
    if (i == null) {
      if (want.rows === undefined) want.rows = rows;
      else if (want.rows !== rows) pendingScroll.current = null;
      return;
    }
    scrollToRow(i);
    const el = treeRef.current?.querySelector<HTMLElement>(`.tree-row[data-id="${want.id}"]`);
    if (!el) return; // rendered once the scroll position is taken over (virtual tree)
    pendingScroll.current = null;
    if (want.focus) el.focus({ preventScroll: true });
  });

  const [focusedId, setFocusedId] = useState<number | null>(null);
  const focusRow = (id: number | null | undefined) => {
    if (id == null) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`.tree-row[data-id="${id}"]`);
    if (el) {
      el.focus();
      if (virtual) el.scrollIntoView({ block: "nearest" });
      return;
    }
    pendingScroll.current = { id, focus: true };
    setFocusedId(id);
  };

  // Keep the open page in view: its ancestors open, the tree scrolled to it (also for a page
  // opened in another pane, which becomes the active one).
  const ancestors = (id: number) => {
    const out: number[] = [];
    for (let p = s().pages.get(id)?.parent_id; p != null; p = s().pages.get(p)?.parent_id) out.push(p);
    return out;
  };
  const [, setScrollTick] = useState(0);
  const reveal = (id: number, focus: boolean) => {
    treeOpen.reveal(ancestors(id), openedHere.current === id);
    pendingScroll.current = { id, focus };
    // Rendered again even when no folder had to open (the row may be scrolled away).
    setScrollTick((n) => n + 1);
  };
  useEffect(() => {
    if (activePageId == null || filter) return;
    reveal(activePageId, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId]);

  // The filter starts at the top of the list.
  useEffect(() => {
    const sc = scroller();
    if (sc) sc.scrollTop = 0;
  }, [filter]);

  handle.current = {
    openFirstHit: (opts) => {
      const first = filtered && rows.find((r) => filtered.hits.has(r.node.id));
      if (!first) return false;
      openedHere.current = first.node.id;
      s().openPage(first.node.id, opts);
      return true;
    },
    revealActive: () => {
      if (activePageId == null) return;
      reveal(activePageId, true);
      // Already open and in view: the focus goes there now.
      setFocusedId(activePageId);
    },
  };

  // A new folder is named in the tree (newItems.tsx).
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ id: number }>).detail?.id;
      if (id == null) return;
      const parents = ancestors(id);
      if (parents.length) treeOpen.expand(parents);
      pendingScroll.current = { id, focus: false };
      setRenaming(id);
    };
    window.addEventListener(TREE_RENAME_EVENT, on);
    return () => window.removeEventListener(TREE_RENAME_EVENT, on);
  });

  // ------------------------------------------------------------ moves

  const runDrop = async (d: DragState) => {
    const plan = d.plan;
    if (!plan || plan.kind === "refused") return;
    const ids = d.ids;
    if (ids.length > 1) clearSelection();
    if (plan.kind === "into") {
      // Into a sorted folder (it orders the pages), or onto the empty area: last at the top level.
      const position = plan.parent == null && !isSorted(rootStyle) ? childrenOf(null).filter((x) => !ids.includes(x.id)).length : null;
      await moveTo(ids, plan.parent, position);
      return;
    }
    if (plan.pos === "inside") {
      const out = await moveTo(ids, plan.row, null);
      if (out) treeOpen.expand([plan.row]);
      return;
    }
    // Before or after a page: there, among the pages that stay.
    const staying = childrenOf(plan.parent).filter((x) => !ids.includes(x.id));
    await moveTo(ids, plan.parent, staying.findIndex((x) => x.id === plan.row) + (plan.pos === "after" ? 1 : 0));
  };

  const movingFrom = (ids: number[]) => ids.map((id) => ({ parent_id: s().pages.get(id)?.parent_id ?? null }));
  /** The drop onto the empty area below the rows: the top level (refused when sorted and all are there). */
  const rootPlan = (ids: number[]): DropPlan =>
    isSorted(rootStyle) && movingFrom(ids).every((m) => m.parent_id == null) ? { kind: "refused", folder: null } : { kind: "into", parent: null };

  const setPlan = (plan: DropPlan | undefined, over: number | "root" | undefined) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.over === over && JSON.stringify(d.plan) === JSON.stringify(plan)) return;
    setDrag({ ...d, plan, over });
  };

  // A collapsed folder held under the pointer opens; near the edges the tree scrolls.
  const openTimer = useRef<{ id: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const holdOpen = (id: number | null) => {
    if (openTimer.current?.id === id) return;
    if (openTimer.current) clearTimeout(openTimer.current.timer);
    openTimer.current = id == null ? null : { id, timer: setTimeout(() => treeOpen.reveal([id], true), DRAG_OPEN_MS) };
  };
  useEffect(() => {
    const sc = scroller();
    if (!drag || !sc) return;
    // In the next frame: the row under the pointer works out the drop from where it is now.
    let frame = 0;
    const onOver = (e: globalThis.DragEvent) => {
      const r = sc.getBoundingClientRect();
      const step = e.clientY < r.top + DRAG_SCROLL_EDGE ? -12 : e.clientY > r.bottom - DRAG_SCROLL_EDGE ? 12 : 0;
      if (step && !frame) frame = requestAnimationFrame(() => ((frame = 0), (sc.scrollTop += step)));
    };
    sc.addEventListener("dragover", onOver);
    return () => {
      cancelAnimationFrame(frame);
      sc.removeEventListener("dragover", onOver);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag]);

  // ------------------------------------------------------------ menus

  const menuItems = (n: PageNode): MenuEntry[] => {
    if (selected.size > 1 && selected.has(n.id)) return selectionMenu(selection());
    const style = n.style ?? DEFAULT_STYLE;
    const sibs = childrenOf(n.parent_id);
    const i = sibs.findIndex((x) => x.id === n.id);
    const parent = n.parent_id != null ? s().pages.get(n.parent_id) : undefined;
    const here = styleOf(n.parent_id, rootStyle);
    // In a sorted folder the order follows from the sort: „Nach oben/unten“ would do nothing.
    const sortedHint = isSorted(here) ? tStatic("sb.sortedBy", { by: sortName(here) }) : undefined;
    const descendants = (x: PageNode): number[] => x.children.flatMap((c) => (c.children.length ? [c.id, ...descendants(c)] : []));
    return [
      { label: tStatic("sb.openNewTab"), icon: CornerDownRight, shortcut: tStatic("sb.middleClick"), onSelect: () => s().openPage(n.id, { newTab: true }) },
      { label: tStatic("sb.openRight"), icon: Columns2, shortcut: keys(`Alt ${tStatic("sb.click")}`), onSelect: () => s().openPage(n.id, { split: true }) },
      "separator",
      {
        label: tStatic("qs.new"),
        icon: FilePlus2,
        submenu: [
          ...newMenuItems(n.id, () => treeOpen.expand([n.id])),
          {
            label: tStatic("sb.sibling"),
            icon: CornerDownRight,
            onSelect: async () => {
              try {
                const p = await api.createPage(tStatic("page.untitled"), n.parent_id, s().settings?.settings.editor?.default_icon ?? "file-text");
                await api.movePage(p.id, n.parent_id, i + 1);
                await s().refreshTree();
                s().openPage(p.id);
              } catch (e) {
                s().error(tStatic("sb.createFailed"), e);
              }
            },
          },
        ],
      },
      { label: tStatic("att.renameButton"), icon: PencilLine, shortcut: "F2", onSelect: () => setRenaming(n.id) },
      { label: tStatic("dash.duplicate"), icon: Copy, onSelect: () => void duplicate(n).then(async (id) => (await s().refreshTree(), id != null && s().openPage(id))) },
      { label: tStatic("sb.changeIconMenu"), icon: Shapes, onSelect: () => openStyle([n.id]) },
      {
        label: tStatic("fl.color"),
        icon: Palette,
        submenu: colorItems([n.id]),
      },
      ...(n.children.length ? [{ label: tStatic("fl.sort"), icon: ArrowDownUp, submenu: sortMenu(style, (st) => void setStyles([n.id], () => st)) }] : []),
      {
        label: tStatic("sb.move"),
        icon: MoveVertical,
        submenu: [
          { label: tStatic("fl.moveTo"), icon: FolderInput, onSelect: () => openMoveTo([n.id]) },
          { label: tStatic("sb.moveUp"), icon: ArrowUp, disabled: !!sortedHint || i <= 0, hint: sortedHint, onSelect: () => void moveTo([n.id], n.parent_id, i - 1) },
          { label: tStatic("sb.moveDown"), icon: ArrowDown, disabled: !!sortedHint || i < 0 || i >= sibs.length - 1, hint: sortedHint, onSelect: () => void moveTo([n.id], n.parent_id, i + 1) },
          {
            label: tStatic("sb.levelUp"),
            icon: CornerLeftUp,
            disabled: !parent,
            onSelect: () => {
              if (!parent) return;
              const up = childrenOf(parent.parent_id);
              void moveTo([n.id], parent.parent_id, up.findIndex((x) => x.id === parent.id) + 1);
            },
          },
          { label: tStatic("sb.toTop"), icon: ArrowUpToLine, disabled: n.parent_id == null, onSelect: () => void moveTo([n.id], null, s().tree.length) },
        ],
      },
      {
        label: tStatic("common.copy"),
        icon: ClipboardCopy,
        submenu: [
          { label: tStatic("sb.copyLink"), icon: Link2, onSelect: () => copyText(`[[${n.title}]]`, tStatic("sb.what.link")) },
          { label: tStatic("sb.what.title"), icon: Type, onSelect: () => copyText(n.title, tStatic("sb.what.title")) },
          { label: tStatic("sb.copyMarkdown"), icon: FileText, onSelect: () => api.page(n.id).then((d) => copyText(d.content, tStatic("sb.what.content")), (e) => s().error(tStatic("sb.copyFailed"), e)) },
        ],
      },
      ...(n.children.length
        ? [
            { label: tStatic("fl.tidy"), icon: Wand2, onSelect: () => openTidyUp(n.id, n.title) },
            {
              label: tStatic("sb.subpages"),
              icon: FolderTree,
              submenu: [
                { label: tStatic("sb.expandAll"), icon: ChevronsUpDown, onSelect: () => treeOpen.expand([n.id, ...descendants(n)]) },
                { label: tStatic("sb.collapseAll"), icon: ChevronsDownUp, onSelect: () => treeOpen.setAll([...open].filter((id) => !descendants(n).includes(id))) },
              ],
            },
          ]
        : []),
      "separator",
      {
        label: n.favorite ? tStatic("sb.unfavorite") : tStatic("sb.favorite"),
        icon: n.favorite ? StarOff : Star,
        onSelect: async () => {
          try {
            await api.setFavorite(n.id, !n.favorite);
            await s().refreshTree();
          } catch (e) {
            s().error(tStatic("sb.favoriteFailed"), e);
          }
        },
      },
      "separator",
      { label: tStatic("common.delete"), icon: Trash2, danger: true, shortcut: tStatic("sb.keyDelete"), onSelect: () => deletePage(n) },
    ];
  };

  /** The actions for several pages at once (context menu and the selection bar). */
  const selectionMenu = (ids: number[]): MenuEntry[] => [
    { label: tStatic("fl.moveN", { n: ids.length }), icon: FolderInput, onSelect: () => openMoveTo(ids) },
    { label: ids.every((id) => s().pages.get(id)?.favorite) ? tStatic("sb.unfavorite") : tStatic("sb.favorite"), icon: Star, onSelect: () => void favoriteMany(ids) },
    { label: tStatic("fl.color"), icon: Palette, submenu: colorItems(ids) },
    { label: tStatic("sb.addTag"), icon: Hash, onSelect: () => setTagging(ids) },
    { label: tStatic("dash.duplicate"), icon: Copy, onSelect: () => void duplicateMany(ids) },
    { label: tStatic("sb.exportHtml"), icon: FileDown, onSelect: () => void exportMany(ids) },
    { label: tStatic("fl.clearSelection"), icon: X, onSelect: clearSelection },
    "separator",
    { label: tStatic("sb.deleteMany", { n: ids.length }), icon: Trash2, danger: true, shortcut: tStatic("sb.keyDelete"), onSelect: () => void deleteSelection() },
  ];
  const colorItems = (ids: number[]): MenuItem[] => {
    const current = ids.map((id) => s().pages.get(id)?.style?.color ?? null);
    const all = (c: string | null) => current.every((x) => x === c);
    return [
      { label: tStatic("fl.color.none"), checked: all(null), onSelect: () => void setStyles(ids, (st) => ({ ...st, color: null })) },
      ...FOLDER_COLORS.map((c) => ({ label: tStatic(`fl.color.${c}` as TKey), icon: SWATCHES[c], checked: all(c), onSelect: () => void setStyles(ids, (st) => ({ ...st, color: c })) })),
    ];
  };
  const openStyle = (ids: number[]) => {
    const el = treeRef.current?.querySelector(`.tree-row[data-id="${ids[0]}"]`);
    if (el) setStylePop({ ids, anchor: el.getBoundingClientRect() });
  };

  /** Several pages to the trash at once (their subpages go with them); one toast undoes all. */
  const deleteSelection = async () => {
    const ids = selection();
    const pages = s().pages;
    const list = ids.map((id) => pages.get(id)).filter((p): p is PageNode => !!p);
    if (!list.length) return;
    const days = s().settings?.settings.notes?.trash_retention_days ?? 30;
    if (!(await s().confirm({ title: tStatic("sb.deleteManyTitle", { n: list.length }), message: tStatic("sb.deleteManyText", { n: list.length, days }), confirmLabel: tStatic("common.delete"), danger: true })))
      return;
    const done: PageNode[] = [];
    for (const p of list) {
      try {
        await api.deletePage(p.id);
        done.push(p);
      } catch (e) {
        s().error(tStatic("pv.deleteFailed"), e);
      }
    }
    clearSelection();
    await s().refreshTree();
    if (!done.length) return;
    s().toast({
      tone: "info",
      title: tStatic("sb.deletedMany", { n: done.length }),
      action: {
        label: tStatic("common.undo"),
        run: async () => {
          for (const p of done) await api.restorePage(p.id).catch((e) => s().error(tStatic("trash.restoreFailed"), e));
          await s().refreshTree();
        },
      },
    });
  };

  // ------------------------------------------------------------ keyboard and clicks

  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>, n: PageNode) => {
    if (menu || e.target !== e.currentTarget || isComposing(e)) return;
    const i = rowIndex.get(n.id) ?? -1;
    const at = (k: number) => rows[k]?.node.id;
    const isOpen = n.children.length > 0 && (filtered ? true : open.has(n.id));
    const key = e.key;
    if ((e.shiftKey && key === "F10") || key === "ContextMenu") {
      openMenuAt(e, menuItems(n));
      return;
    }
    const handled = () => e.preventDefault();
    // Alt+←/→ go back and forward (keymap), Ctrl+arrows belong to the window: not the tree's.
    if (/^(Arrow|Home$|End$)/.test(key) && (e.altKey || e.ctrlKey || e.metaKey)) return;
    if (key === "Escape" && selected.size) return (handled(), clearSelection());
    if (key === " " && (e.ctrlKey || e.metaKey)) return (handled(), toggleSelected(n.id));
    if (e.shiftKey && (key === "ArrowDown" || key === "ArrowUp")) {
      handled();
      const next = at(i + (key === "ArrowDown" ? 1 : -1));
      if (next == null) return;
      // A range from the anchor, as in the file managers: going back shrinks it again.
      if (!selected.size || anchor.current == null || !rowIndex.has(anchor.current)) anchor.current = n.id;
      setSelected(new Set(rangeIds(rows.map((r) => r.node.id), anchor.current, next)));
      focusRow(next);
      return;
    }
    if (key === "a" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      handled();
      setSelected(new Set(rows.map((r) => r.node.id)));
      return;
    }
    if (key === "F2" && !selected.size) return (handled(), setRenaming(n.id));
    if (key === "Delete" || (key === "Backspace" && e.metaKey)) {
      handled();
      const many = selected.size > 1 && selected.has(n.id);
      // The focus goes on to the next row that stays (else the one before), not to the page.
      const gone = many ? [...selected] : [n.id];
      const inside = (id: number) => {
        for (let p: number | null | undefined = id; p != null; p = s().pages.get(p)?.parent_id) if (gone.includes(p)) return true;
        return false;
      };
      const after = rows.slice(i + 1).find((r) => !inside(r.node.id)) ?? [...rows.slice(0, i)].reverse().find((r) => !inside(r.node.id));
      void (many ? deleteSelection() : deletePage(n)).then(() => !s().pages.has(n.id) && requestAnimationFrame(() => focusRow(after?.node.id)));
      return;
    }
    if (isTypeaheadKey(e)) {
      // Letters go to the next row starting with them (as in the file managers); a space within a search is part of it.
      handled();
      const k = typeahead(
        rows.map((r) => r.node.title),
        i,
        typeaheadText(key),
      );
      if (k >= 0) focusRow(at(k));
      return;
    }
    if (key === "Enter" || key === " ") {
      handled();
      // A folder of the filing (Tagesnotizen, a year, a month) is no page to read: it opens and closes.
      if (n.system && n.children.length && !e.ctrlKey && !e.metaKey && !e.altKey) return toggle(n.id);
      openedHere.current = n.id;
      s().openPage(n.id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey });
    } else if (key === "ArrowDown") (handled(), focusRow(at(i + 1)));
    else if (key === "ArrowUp") (handled(), focusRow(at(i - 1)));
    else if (key === "Home") (handled(), focusRow(at(0)));
    else if (key === "End") (handled(), focusRow(at(rows.length - 1)));
    else if (key === "ArrowRight") {
      handled();
      if (n.children.length && !isOpen) toggle(n.id);
      else if (isOpen) focusRow(at(i + 1));
    } else if (key === "ArrowLeft") {
      handled();
      if (isOpen && !filtered) toggle(n.id);
      else focusRow(n.parent_id);
    }
  };

  const toggleSelected = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
    anchor.current = id;
  };
  const click = (n: PageNode, e: React.MouseEvent) => {
    // Only the primary button (some engines also send a click for the right one).
    if (e.button !== 0) return;
    if (e.shiftKey) {
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      setSelected(new Set(rangeIds(rows.map((r) => r.node.id), anchor.current ?? activePageId ?? null, n.id)));
      return;
    }
    // Ctrl/Cmd+click selects, as in the file managers; the open page joins a new selection.
    // A new tab is the middle click or the context menu.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (!selected.size && activePageId != null && activePageId !== n.id && rowIndex.has(activePageId)) {
        setSelected(new Set([activePageId, n.id]));
        anchor.current = n.id;
        return;
      }
      return toggleSelected(n.id);
    }
    if (selected.size) clearSelection();
    anchor.current = n.id;
    // A folder of the filing opens and closes instead of showing its empty page.
    if (n.system && n.children.length && !e.altKey) return toggle(n.id);
    openedHere.current = n.id;
    s().openPage(n.id, { split: e.altKey });
  };

  // The latest closures, reached through one stable object.
  const node = (id: number) => s().pages.get(id);
  const latest = useRef({ toggle, onRowKey, menuItems, openMenu, openMenuAt, setFocusedId, click, selected, focusRow, runDrop, setPlan, holdOpen, rootStyle, treeOpen });
  latest.current = { toggle, onRowKey, menuItems, openMenu, openMenuAt, setFocusedId, click, selected, focusRow, runDrop, setPlan, holdOpen, rootStyle, treeOpen };
  const actions = useMemo<RowActions>(
    () => ({
      toggle: (id) => latest.current.toggle(id),
      open: (id, e) => {
        const n = node(id);
        if (n) latest.current.click(n, e);
      },
      menu: (id, e) => {
        const n = node(id);
        if (n) latest.current.openMenu(e, latest.current.menuItems(n));
      },
      menuAt: (id, e) => {
        const n = node(id);
        if (n) latest.current.openMenuAt(e, latest.current.menuItems(n));
      },
      key: (id, e) => {
        const n = node(id);
        if (n) latest.current.onRowKey(e, n);
      },
      focus: (id) => latest.current.setFocusedId(id),
      dragStart: (id, e) => {
        const sel = latest.current.selected;
        const ids = sel.size > 1 && sel.has(id) ? topSelected(sel, parentOf) : [id];
        // Moves in the tree; a link in an editor; opens in a pane.
        e.dataTransfer.effectAllowed = "all";
        // Own types, so dropping into the editor does not paste the id as text.
        e.dataTransfer.setData(PAGE_MIME, String(id));
        e.dataTransfer.setData(PAGES_MIME, ids.join(","));
        const d = { id, ids };
        dragRef.current = d;
        setDragState(d);
      },
      dragEnd: () => {
        latest.current.holdOpen(null);
        dragRef.current = null;
        setDragState(null);
      },
      dragOver: (id, e) => {
        const d = dragRef.current;
        const n = node(id);
        if (!d || !n) return;
        // Not onto itself or into the dragged pages' own subtrees (the move would be refused).
        if (d.ids.some((m) => isWithin(id, m, parentOf))) return latest.current.setPlan(undefined, undefined);
        const r = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - r.top) / (r.height || 1);
        const sorted = isSorted(styleOf(n.parent_id, latest.current.rootStyle));
        const plan = planDrop(y, n, sorted, d.ids.map((m) => ({ parent_id: s().pages.get(m)?.parent_id ?? null })));
        if (plan.kind !== "refused") {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
        latest.current.setPlan(plan, id);
        latest.current.holdOpen(plan.kind === "at" && plan.pos === "inside" && n.children.length && !latest.current.treeOpen.open.has(id) ? id : null);
      },
      dragLeave: (id) => {
        if (dragRef.current?.over === id) latest.current.setPlan(undefined, undefined);
      },
      drop: (_id, e) => {
        e.preventDefault();
        e.stopPropagation();
        const d = dragRef.current;
        latest.current.holdOpen(null);
        dragRef.current = null;
        setDragState(null);
        if (d) void latest.current.runDrop(d);
      },
      rename: (id) => {
        if (latest.current.selected.size > 1) return;
        setRenaming(id);
      },
      renameDone: (id, refocus) => {
        setRenaming((x) => (x === id ? null : x));
        if (refocus) requestAnimationFrame(() => latest.current.focusRow(id));
      },
      subpage: (id) => {
        latest.current.treeOpen.expand([id]);
        void createNew("page", id);
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // The empty area below the rows: the top level (drops, „Neu“).
  const [emptyMenu, openEmptyMenu] = useMenu();
  const endDragOver = (e: DragEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const plan = rootPlan(d.ids);
    if (plan.kind !== "refused") {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
    setPlan(plan, "root");
  };
  const endDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const d = dragRef.current;
    holdOpen(null);
    setDrag(null);
    if (d?.plan) void runDrop(d);
  };

  // Shared by all rows (one store subscription instead of one per row).
  const conflicts = useApp((st) => st.conflicts);
  const conflictIds = useMemo(() => new Set(conflicts.map((c) => c.page_id)), [conflicts]);

  // The dragged, the focused and the tab-reachable row stay rendered when scrolled away.
  const shown = virtual
    ? treeWindowOf(rows.length, view, [drag?.id, focusedId, focusable, renaming, pendingScroll.current?.id].map((id) => (id == null ? -1 : (rowIndex.get(id) ?? -1))))
    : null;
  const multi = selected.size > 0;
  const plan = drag?.plan;
  const dropOf = (id: number): DropPos | undefined =>
    !plan ? undefined : plan.kind === "at" && plan.row === id ? plan.pos : plan.kind === "into" && plan.parent === id ? "inside" : undefined;
  const row = (i: number) => {
    const { node: n, depth, pos, size } = rows[i];
    const hit = !!filtered?.hits.has(n.id);
    return (
      <TreeRow
        key={n.id}
        node={n}
        depth={depth}
        pos={pos}
        size={size}
        top={shown ? i * view.rowH : undefined}
        active={activePageId === n.id}
        open={filtered ? n.children.some((c) => filtered.shown.has(c.id)) : open.has(n.id)}
        selected={selected.has(n.id)}
        multi={multi}
        mark={hit ? filter : ""}
        fuzzy={!!filtered?.fuzzy}
        drop={dropOf(n.id)}
        focusable={focusable === n.id}
        conflict={conflictIds.has(n.id)}
        renaming={renaming === n.id}
        elsewhere={elsewhere.has(n.id)}
        act={actions}
      />
    );
  };
  const refused = plan?.kind === "refused" ? plan.folder : undefined;
  const sel = multi ? selection() : [];

  return (
    <>
      {filtered && rows.length === 0 && <div className="side-empty tree-filter-empty">{tStatic("fl.filterEmpty", { q: filter.trim() })}</div>}
      {filtered?.fuzzy && rows.length > 0 && <div className="tree-filter-note" role="status">{tStatic("fl.filterSimilar")}</div>}
      <div
        className={`tree ${shown ? "is-virtual" : ""}`}
        role="tree"
        aria-label={tStatic("sb.pages")}
        aria-multiselectable={multi || undefined}
        ref={treeRef}
        style={shown ? { height: rows.length * view.rowH } : undefined}
      >
        {shown ? shown.map(row) : rows.map((_, i) => row(i))}
      </div>
      <div
        className={`tree-end ${plan?.kind === "into" && plan.parent == null ? "drop-root" : ""}`}
        onDragOver={endDragOver}
        onDragLeave={() => dragRef.current?.over === "root" && setPlan(undefined, undefined)}
        onDrop={endDrop}
        onContextMenu={(e) =>
          openEmptyMenu(e, [
            { label: tStatic("qs.new"), icon: Plus, submenu: newMenuItems(null) },
            { label: tStatic("sidebar.collapseAll"), icon: ChevronsDownUp, onSelect: () => treeOpen.setAll([]) },
          ])
        }
        aria-hidden
      />
      {refused !== undefined && (
        <div className="tree-drop-hint" role="status">
          {tStatic("sb.dropSorted", { folder: folderName(refused), by: sortName(styleOf(refused, rootStyle)) })}
        </div>
      )}
      {menu}
      {emptyMenu}
      {stylePop && <StylePopover ids={stylePop.ids} anchor={stylePop.anchor} onClose={() => setStylePop(null)} />}
      <TagDialog ids={tagging} onClose={() => setTagging(null)} />
      {multi &&
        selectionSlot &&
        createPortal(
          <SelectionBar
            count={selected.size}
            onClear={clearSelection}
            onMove={() => openMoveTo(sel)}
            onFavorite={() => void favoriteMany(sel)}
            colors={() => colorItems(sel)}
            onTag={() => setTagging(sel)}
            onDuplicate={() => void duplicateMany(sel)}
            onExport={() => void exportMany(sel)}
            onDelete={() => void deleteSelection()}
            allFavorite={sel.every((id) => s().pages.get(id)?.favorite)}
          />,
          selectionSlot,
        )}
    </>
  );
}

/** A row re-renders only when something it shows changed (a refresh brings new page objects). */
function sameRow(a: RowProps, b: RowProps): boolean {
  for (const k of Object.keys(b) as (keyof RowProps)[]) if (k !== "node" && a[k] !== b[k]) return false;
  const x = a.node;
  const y = b.node;
  return (
    x === y ||
    (x.id === y.id && x.title === y.title && x.icon === y.icon && x.children.length === y.children.length && x.style?.color === y.style?.color && x.system === y.system && x.kind === y.kind && x.favorite === y.favorite)
  );
}

interface RowProps {
  node: PageNode;
  depth: number;
  /** Place among its visible siblings (1-based) and their number. */
  pos: number;
  size: number;
  /** Position in a virtualized tree. */
  top?: number;
  active: boolean;
  open: boolean;
  /** Part of the multi-selection. */
  selected: boolean;
  /** A multi-selection exists (rows then say whether they are selected). */
  multi: boolean;
  /** The filter text, for a row that matches it. */
  mark: string;
  fuzzy: boolean;
  drop?: DropPos;
  focusable: boolean;
  conflict: boolean;
  renaming: boolean;
  /** Shown in another pane. */
  elsewhere: boolean;
  act: RowActions;
}

const TreeRow = memo(function TreeRow({ node: n, depth, pos, size, top, active, open, selected, multi, mark, fuzzy, drop, focusable, conflict, renaming, elsewhere, act }: RowProps) {
  // The action buttons exist only while the row is hovered or has the focus.
  const [hot, setHot] = useState(false);
  const folder = n.children.length > 0;
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-setsize={size}
      aria-posinset={pos}
      aria-expanded={folder ? open : undefined}
      aria-selected={multi ? selected : undefined}
      aria-current={active ? "page" : undefined}
      className={`tree-row ${active ? "active" : ""} ${selected ? "selected" : ""} ${mark ? "hit" : ""} ${drop ? `drop-${drop}` : ""} ${renaming ? "renaming" : ""} ${elsewhere ? "elsewhere" : ""}`}
      style={(top == null ? { "--depth": depth } : { "--depth": depth, position: "absolute", top, left: 0, right: 0 }) as unknown as React.CSSProperties}
      data-id={n.id}
      tabIndex={focusable ? 0 : -1}
      onMouseEnter={(e) => {
        setHot(true);
        titleIfCut(e);
      }}
      onMouseLeave={(e) => !e.currentTarget.contains(document.activeElement) && setHot(false)}
      onFocus={(e) => {
        setHot(true);
        if (e.target === e.currentTarget) act.focus(n.id);
      }}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover") && setHot(false)}
      draggable={!renaming}
      onDragStart={(e) => act.dragStart(n.id, e)}
      onDragEnd={act.dragEnd}
      onDragOver={(e) => act.dragOver(n.id, e)}
      onDragLeave={() => act.dragLeave(n.id)}
      onDrop={(e) => act.drop(n.id, e)}
      onClick={(e) => act.open(n.id, e)}
      onAuxClick={(e) => e.button === 1 && useApp.getState().openPage(n.id, { newTab: true })}
      onContextMenu={(e) => act.menu(n.id, e)}
      onKeyDown={(e) => act.key(n.id, e)}
    >
      <span
        className={`tree-twisty ${folder ? "" : "leaf"}`}
        onClick={(e) => {
          e.stopPropagation();
          act.toggle(n.id);
        }}
      >
        {folder && <ChevronRightIcon open={open} />}
      </span>
      {selected && multi ? <Check size={15} strokeWidth={2} className="tree-icon tree-check" aria-hidden /> : <PageIcon name={n.icon} size={15} className={`tree-icon ${n.style?.color ? `tint-${n.style.color}` : ""}`} />}
      {renaming ? (
        <TreeRename node={n} onDone={(refocus) => act.renameDone(n.id, refocus)} />
      ) : (
        <span
          className="tree-label"
          onDoubleClick={(e) => {
            // Renames in place; the first click already opened the page as a single click does.
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            e.stopPropagation();
            act.rename(n.id);
          }}
        >
          {mark ? marked(n.title, mark, fuzzy) : n.title}
        </span>
      )}
      {conflict && <span className="tree-conflict" title={tStatic("sb.conflictTip")} aria-label={tStatic("cf.conflict")} />}
      {elsewhere && !renaming && (
        <span className="tree-elsewhere" title={tStatic("sb.openElsewhere")} role="img" aria-label={tStatic("sb.openElsewhere")}>
          <Columns2 size={12} strokeWidth={1.75} aria-hidden />
        </span>
      )}
      {/* Drawn by CSS from the attribute: the row's text stays its title (tests and screen readers read it). */}
      {folder && !renaming && <span className="tree-count" data-count={n.children.length} aria-hidden />}
      {hot && !renaming && (
        <span className="tree-row-actions">
          <IconButton
            icon={MoreHorizontal}
            label={tStatic("sidebar.pageActions")}
            size="sm"
            tooltipSide="right"
            onClick={(e) => {
              e.stopPropagation();
              act.menuAt(n.id, e);
            }}
          />
          <IconButton
            icon={Plus}
            label={tStatic("sidebar.subpage")}
            size="sm"
            tooltipSide="right"
            onClick={(e) => {
              e.stopPropagation();
              act.subpage(n.id);
            }}
          />
        </span>
      )}
    </div>
  );
}, sameRow);

const ChevronRightIcon = ({ open }: { open: boolean }) => <ChevronRight size={12} className={`chev ${open ? "open" : ""}`} />;

/** The title of a tree row as an input: Enter saves (links rewritten), Escape cancels. */
function TreeRename({ node, onDone }: { node: PageNode; onDone: (refocus: boolean) => void }) {
  const [value, setValue] = useState(node.title);
  // `[ ] | # ^` were typed and replaced (they belong to the link syntax).
  const [charsHint, setCharsHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const done = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.select();
    // A deep row leaves little room: the field reaches back over the indent (not past the row).
    const min = parseFloat(getComputedStyle(el).getPropertyValue("--tree-rename-min")) || 0;
    const row = el.closest<HTMLElement>(".tree-row");
    if (row && el.offsetWidth < min) {
      const room = el.getBoundingClientRect().left - row.getBoundingClientRect().left - 4;
      el.style.marginLeft = `${-Math.min(room, min - el.offsetWidth)}px`;
    }
  }, []);
  const finish = (refocus: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(refocus);
  };
  const commit = async (fromBlur: boolean) => {
    if (busy.current || done.current) return;
    const name = value.trim();
    if (name === node.title) return finish(!fromBlur);
    const problem = renameProblem(node.id, name, useApp.getState().pages);
    if (problem) {
      // Leaving the field with a name that cannot be used keeps the old one.
      if (fromBlur) return finish(false);
      setError(problem);
      return;
    }
    busy.current = true;
    try {
      await renameInTree(node, name);
      finish(!fromBlur);
    } catch (e) {
      busy.current = false;
      if (fromBlur) {
        finish(false);
        useApp.getState().error(tStatic("page.renameFailed"), e);
      } else setError(errorParts(e).text);
    }
  };
  const message = error ?? (charsHint ? tStatic("pv.titleHint") : null);
  const msgId = `tree-rename-msg-${node.id}`;
  return (
    <>
      <input
        ref={input}
        className="tree-rename"
        value={value}
        spellCheck={false}
        aria-label={tStatic("sb.renameAria", { title: node.title })}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? msgId : undefined}
        onChange={(e) => {
          const typedText = e.target.value;
          const clean = cleanTitleChars(typedText);
          setValue(clean);
          if (clean !== typedText) setCharsHint(true);
          setError(null);
        }}
        onKeyDown={(e) => {
          // The row's keys (arrows, Delete, F2, Ctrl+A) stay with the text field.
          e.stopPropagation();
          if (isComposing(e)) return;
          if (e.key === "Enter") (e.preventDefault(), void commit(false));
          else if (e.key === "Escape") (e.preventDefault(), finish(true));
        }}
        onBlur={() => void commit(true)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
      {message && (
        <span id={msgId} className={`tree-rename-msg ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
          {message}
        </span>
      )}
    </>
  );
}

// ------------------------------------------------------------------ selection bar

function SelectionBar({
  count,
  onClear,
  onMove,
  onFavorite,
  colors,
  onTag,
  onDuplicate,
  onExport,
  onDelete,
  allFavorite,
}: {
  count: number;
  onClear: () => void;
  onMove: () => void;
  onFavorite: () => void;
  colors: () => MenuItem[];
  onTag: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  allFavorite: boolean;
}) {
  const [menu, , openMenuAt] = useMenu();
  return (
    <div className="tree-selection" role="toolbar" aria-label={tStatic("fl.selectionActions")}>
      <span className="tree-selection-count" role="status">
        {tStatic("fl.selected", { n: count })}
      </span>
      <IconButton icon={X} size="sm" label={tStatic("fl.clearSelection")} tooltipSide="top" onClick={onClear} />
      <div className="tree-selection-actions">
        <Button size="sm" variant="ghost" icon={FolderInput} onClick={onMove}>
          {tStatic("fl.moveTo")}
        </Button>
        <IconButton icon={allFavorite ? StarOff : Star} size="md" label={allFavorite ? tStatic("sb.unfavorite") : tStatic("sb.favorite")} tooltipSide="top" onClick={onFavorite} />
        <IconButton icon={Palette} size="md" label={tStatic("fl.color")} tooltipSide="top" aria-haspopup="menu" onClick={(e) => openMenuAt(e, colors())} />
        <IconButton icon={Hash} size="md" label={tStatic("sb.addTag")} tooltipSide="top" onClick={onTag} />
        <IconButton icon={Copy} size="md" label={tStatic("dash.duplicate")} tooltipSide="top" onClick={onDuplicate} />
        <IconButton icon={FileDown} size="md" label={tStatic("sb.exportHtml")} tooltipSide="top" onClick={onExport} />
        <IconButton icon={Trash2} size="md" label={tStatic("sb.deleteMany", { n: count })} tooltipSide="top" className="danger" onClick={onDelete} />
      </div>
      {menu}
    </div>
  );
}

// ------------------------------------------------------------------ icon and color

/** „Symbol ändern…“: the icon grid as a popover (a submenu of 50 icons made the menu as tall as the window). */
function StylePopover({ ids, anchor, onClose }: { ids: number[]; anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.left, y: anchor.bottom + 4 });
  const pages = useApp((st) => st.pages);
  const first = pages.get(ids[0]);
  const opener = useRef<Element | null>(document.activeElement);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(anchorMenu(anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
    el.querySelector<HTMLElement>("button.on, button")?.focus();
  }, [anchor]);
  useEffect(() => {
    const close = () => {
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus({ preventScroll: true });
      onClose();
    };
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e) || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  // Arrows move through the grid (eight per row), as in the page header's picker.
  const onGridKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 8 : e.key === "ArrowUp" ? -8 : 0;
    if (!step || i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + step))]?.focus();
  };
  return createPortal(
    <div className="tree-style-pop" ref={ref} role="dialog" aria-label={tStatic("sb.changeIcon")} style={{ left: pos.x, top: pos.y }}>
      <div className="icon-picker inline tree-style-icons" role="listbox" aria-label={tStatic("sb.changeIcon")} onKeyDown={onGridKey}>
        {Object.entries(PAGE_ICONS).map(([name, Icon]) => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={first?.icon === name}
            aria-label={iconLabel(name)}
            title={iconLabel(name)}
            className={first?.icon === name ? "on" : ""}
            onClick={() => {
              onClose();
              void Promise.all(ids.map((id) => setIcon(id, name)));
            }}
          >
            <Icon size={16} strokeWidth={1.75} />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ tag dialog

/** „Tag hinzufügen…“ for the selection: the tag goes into each page's properties. */
function TagDialog({ ids, onClose }: { ids: number[] | null; onClose: () => void }) {
  const [tag, setTag] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    if (!ids) return;
    setTag("");
    api.tags().then((list) => setKnown(list.map(([t]) => t)), () => {});
  }, [ids]);
  const add = () => {
    if (!ids || !tag.trim()) return;
    onClose();
    void tagMany(ids, tag);
  };
  return (
    <Dialog
      open={!!ids}
      onClose={onClose}
      title={tStatic("sb.addTagTitle", { n: ids?.length ?? 0 })}
      description={tStatic("sb.addTagHint")}
      width={400}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tStatic("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!tag.trim()} onClick={add}>
            {tStatic("sb.addTagButton")}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        value={tag}
        list="tree-tag-list"
        placeholder={tStatic("sb.tagPlaceholder")}
        aria-label={tStatic("sb.tagLabel")}
        onChange={(e) => setTag(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === "Enter") (e.preventDefault(), add());
        }}
      />
      <datalist id="tree-tag-list">
        {known.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
    </Dialog>
  );
}
