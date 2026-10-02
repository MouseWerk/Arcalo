// Live graph data for the graph view and the local graph: one source per filter, loaded once and
// kept while the app runs, updated in place after a page is saved, renamed, moved or deleted
// (`graph_patch` for just those pages), so reopening the view is instant. The layout cache
// (node positions per workspace) and the stored view settings live here too.

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { applyPatch, patchScope, type GraphData, type GraphFilter, type VNode } from "../../lib/graph";
import { useApp } from "../../store/app";
import type { PageNode } from "../../lib/types";
import { openFile, openPdfViewer } from "../../editor/files";
import { isPdfName } from "../../editor/fileEmbed";

type Listener = (d: GraphData) => void;

/** More changed pages than this at once: the whole graph is loaded again. */
const PATCH_MAX = 300;

class GraphSource {
  data: GraphData | null = null;
  error: unknown = null;
  private loading: Promise<void> | null = null;
  private listeners = new Set<Listener>();
  private pending = new Set<number>();
  private timer = 0;
  constructor(readonly filter: GraphFilter) {}

  load(): Promise<void> {
    this.loading ??= api.graphData(this.filter).then(
      (d) => {
        this.data = d;
        this.emit();
      },
      (e) => {
        this.error = e;
        this.loading = null;
        this.emit();
      },
    );
    return this.loading;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get used() {
    return this.listeners.size > 0;
  }

  private emit() {
    if (this.data) this.listeners.forEach((l) => l(this.data!));
  }

  /** Pages that changed: applied together a moment later. */
  changed(ids: number[]) {
    if (!this.data) return;
    ids.forEach((i) => this.pending.add(i));
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 250);
  }

  private async flush() {
    if (!this.data || !this.pending.size) return;
    const ids = [...this.pending];
    this.pending.clear();
    try {
      if (ids.length > PATCH_MAX) {
        this.data = await api.graphData(this.filter);
      } else {
        const patch = await api.graphPatch(patchScope(this.data, ids), this.filter);
        this.data = applyPatch(this.data, patch);
      }
      this.emit();
    } catch {
      // The next change or reopening loads it again.
      this.loading = null;
    }
  }
}

const sources = new Map<string, GraphSource>();

/** The source for `filter` (kept: at most a few, unused ones go first). */
export function graphSource(filter: GraphFilter): GraphSource {
  const key = JSON.stringify(filter);
  let s = sources.get(key);
  if (!s) {
    for (const [k, old] of sources) if (sources.size >= 4 && !old.used) sources.delete(k);
    s = new GraphSource(filter);
    sources.set(key, s);
    wire();
  }
  return s;
}

/** The graph for `filter`, live. `null` while it loads. */
export function useGraphData(filter: GraphFilter | null): { data: GraphData | null; error: unknown } {
  const src = filter ? graphSource(filter) : null;
  const [state, setState] = useState<{ src: GraphSource | null; data: GraphData | null }>({ src, data: src?.data ?? null });
  useEffect(() => {
    if (!src) return;
    setState({ src, data: src.data });
    const off = src.subscribe((d) => setState({ src, data: d }));
    void src.load();
    return () => {
      off();
    };
  }, [src]);
  return { data: state.src === src ? state.data : (src?.data ?? null), error: src?.error ?? null };
}

let wired = false;

function changed(ids: number[]) {
  if (ids.length) sources.forEach((s) => s.changed(ids));
}

/** Listens once for page saves (editor), reloads (sync) and tree changes (rename, move, delete). */
function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("annalo:page-saved", (e) => {
    const id = (e as CustomEvent<{ id: number }>).detail?.id;
    if (typeof id === "number") changed([id]);
  });
  window.addEventListener("annalo:reload-pages", (e) => {
    const ids = (e as CustomEvent<{ ids?: number[] }>).detail?.ids;
    if (Array.isArray(ids)) changed(ids);
  });
  useApp.subscribe((s, prev) => {
    if (s.pages !== prev.pages) changed(treeChanges(prev.pages, s.pages));
  });
}

/** Pages created, removed, renamed or moved between two trees. */
export function treeChanges(a: Map<number, PageNode>, b: Map<number, PageNode>): number[] {
  const out: number[] = [];
  for (const [id, p] of b) {
    const o = a.get(id);
    if (!o || o.title !== p.title || o.parent_id !== p.parent_id || o.updated_at !== p.updated_at) out.push(id);
  }
  for (const id of a.keys()) if (!b.has(id)) out.push(id);
  return out;
}

/** Opens a graph node: a page (Ctrl/Cmd: in a new tab), a tag view or a file; a missing page is created. */
export async function openGraphNode(n: VNode, newTab: boolean) {
  const s = useApp.getState();
  if (n.kind === "page" && n.page) s.openPage(n.page.id, { newTab });
  else if (n.kind === "tag") s.openTab({ kind: "tag", tag: n.label.replace(/^#/, "") }, { newTab });
  else if (n.kind === "file") void (isPdfName(n.label) ? openPdfViewer(n.label) : openFile(n.label));
  else if (n.kind === "ghost") {
    const page = await api.resolvePage(n.label, true);
    if (page) {
      await s.refreshTree();
      s.openPage(page.id, { newTab });
    }
  }
}

// ---- layout cache and stored view

let layout: Promise<Map<string, [number, number]>> | null = null;
let layoutTimer = 0;

/** Node positions of the last layout of this workspace. */
export function loadLayout(): Promise<Map<string, [number, number]>> {
  layout ??= api
    .graphStateGet("layout")
    .then((raw) => {
      const pos = (raw as { pos?: Record<string, [number, number]> } | null)?.pos ?? {};
      return new Map(Object.entries(pos).filter(([, p]) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));
    })
    .catch(() => new Map());
  return layout;
}

/** Stores positions (merged into the cache), a moment after the layout rests. */
export function saveLayout(pos: Map<string, [number, number]>) {
  void loadLayout().then((cache) => {
    for (const [k, p] of pos) cache.set(k, p);
    window.clearTimeout(layoutTimer);
    layoutTimer = window.setTimeout(() => {
      // Ghost and tag nodes come and go; at most this many positions are kept.
      const entries = [...cache.entries()].slice(-20000);
      void api.graphStateSet("layout", { v: 1, pos: Object.fromEntries(entries) }).catch(() => {});
    }, 800);
  });
}
