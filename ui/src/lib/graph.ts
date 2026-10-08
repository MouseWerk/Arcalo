// Graph view (1.9): the data from the core (`graph_data`, filtered in SQL), what the view adds on
// top (ghost nodes for unresolved links, tag and file nodes, orphans, depth from a node), color
// groups and the stored view settings and presets. Pure, so it can be tested; the canvas and the
// force layout live in `components/graph`.

export type GraphDateField = "created" | "modified";

/** Filters that run in SQL (`arcalo_core::graph::GraphFilter`). */
export interface GraphFilter {
  tags: string[];
  folder: number | null;
  netzplan: string | null;
  jira_project: string | null;
  date_field: GraphDateField;
  from: string | null;
  to: string | null;
  daily: boolean;
  attachments: boolean;
}

export interface GraphNodeData {
  id: number;
  title: string;
  icon: string | null;
  parent_id: number | null;
  /** `Projekte/Kunde X`, empty at the top level. */
  folder: string;
  tags: string[];
  netzplan: string[];
  jira: string | null;
  created_at: string;
  updated_at: string;
  daily: boolean;
  links_in: number;
  links_out: number;
}

export interface GraphData {
  nodes: GraphNodeData[];
  links: { from: number; to: number }[];
  unresolved: { from: number; key: string; title: string }[];
  files: { from: number; name: string }[];
  removed: number[];
}

/** What the view adds on top of the data. */
export interface GraphOptions {
  orphans: boolean;
  unresolved: boolean;
  tagNodes: boolean;
  /** Only nodes up to this many links away from `focus` (0: off). */
  depth: number;
}

export type GroupKind = "tag" | "folder" | "query";
/** Theme colors (tokens.css): the chart series, checked for color-blind separation per theme. */
export const GROUP_COLORS = ["series-1", "series-2", "series-3", "series-4", "series-5", "series-6", "series-7", "series-8"] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export interface GroupRule {
  id: string;
  kind: GroupKind;
  value: string;
  color: GroupColor;
}

export interface GraphDisplay {
  /** Bigger nodes for more links. */
  sizeByLinks: boolean;
  nodeSize: number;
  linkWidth: number;
  center: number;
  repel: number;
  linkDistance: number;
  animate: boolean;
  /** Default colors by top-level folder where no rule matches. */
  folderColors: boolean;
}

export interface GraphSettings {
  filter: GraphFilter;
  options: GraphOptions;
  groups: GroupRule[];
  display: GraphDisplay;
}

export interface GraphPreset {
  id: string;
  name: string;
  filter: GraphFilter;
  options: GraphOptions;
  groups: GroupRule[];
}

export const defaultFilter = (): GraphFilter => ({ tags: [], folder: null, netzplan: null, jira_project: null, date_field: "modified", from: null, to: null, daily: true, attachments: false });
export const defaultOptions = (): GraphOptions => ({ orphans: true, unresolved: false, tagNodes: false, depth: 0 });
export const defaultDisplay = (): GraphDisplay => ({ sizeByLinks: true, nodeSize: 1, linkWidth: 1, center: 0.5, repel: 0.5, linkDistance: 0.5, animate: true, folderColors: true });
export const defaultSettings = (): GraphSettings => ({ filter: defaultFilter(), options: defaultOptions(), groups: [], display: defaultDisplay() });

const clamp = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x.trim() : null);
const bool = (x: unknown, d: boolean) => (typeof x === "boolean" ? x : d);
const isoDay = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);

/** Settings or a preset as stored by any version: unknown fields dropped, ranges enforced. */
export function normalizeFilter(raw: unknown): GraphFilter {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = defaultFilter();
  return {
    tags: Array.isArray(r.tags) ? [...new Set(r.tags.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().replace(/^#/, "").toLowerCase()))] : d.tags,
    folder: typeof r.folder === "number" && Number.isInteger(r.folder) ? r.folder : null,
    netzplan: str(r.netzplan),
    jira_project: str(r.jira_project),
    date_field: r.date_field === "created" ? "created" : "modified",
    from: isoDay(r.from),
    to: isoDay(r.to),
    daily: bool(r.daily, d.daily),
    attachments: bool(r.attachments, d.attachments),
  };
}

export function normalizeOptions(raw: unknown): GraphOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = defaultOptions();
  return { orphans: bool(r.orphans, d.orphans), unresolved: bool(r.unresolved, d.unresolved), tagNodes: bool(r.tagNodes, d.tagNodes), depth: Math.round(clamp(r.depth, 0, 5, 0)) };
}

export function normalizeGroups(raw: unknown): GroupRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g, i): GroupRule | null => {
      const r = (g ?? {}) as Record<string, unknown>;
      const kind = r.kind === "tag" || r.kind === "folder" || r.kind === "query" ? r.kind : null;
      const value = str(r.value);
      if (!kind || !value) return null;
      const color = GROUP_COLORS.includes(r.color as GroupColor) ? (r.color as GroupColor) : GROUP_COLORS[i % GROUP_COLORS.length];
      return { id: str(r.id) ?? `g${i}`, kind, value, color };
    })
    .filter((g): g is GroupRule => !!g)
    .slice(0, 24);
}

export function normalizeDisplay(raw: unknown): GraphDisplay {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = defaultDisplay();
  return {
    sizeByLinks: bool(r.sizeByLinks, d.sizeByLinks),
    nodeSize: clamp(r.nodeSize, 0.5, 2, d.nodeSize),
    linkWidth: clamp(r.linkWidth, 0.25, 3, d.linkWidth),
    center: clamp(r.center, 0, 1, d.center),
    repel: clamp(r.repel, 0, 1, d.repel),
    linkDistance: clamp(r.linkDistance, 0, 1, d.linkDistance),
    animate: bool(r.animate, d.animate),
    folderColors: bool(r.folderColors, d.folderColors),
  };
}

export function normalizeSettings(raw: unknown): GraphSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { filter: normalizeFilter(r.filter), options: normalizeOptions(r.options), groups: normalizeGroups(r.groups), display: normalizeDisplay(r.display) };
}

export function normalizePresets(raw: unknown): GraphPreset[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p, i): GraphPreset | null => {
      const r = (p ?? {}) as Record<string, unknown>;
      const name = str(r.name);
      if (!name) return null;
      return { id: str(r.id) ?? `p${i}`, name: name.slice(0, 80), filter: normalizeFilter(r.filter), options: normalizeOptions(r.options), groups: normalizeGroups(r.groups) };
    })
    .filter((p): p is GraphPreset => !!p)
    .slice(0, 50);
}

/** How many filters differ from the defaults (the badge on „Filter“). */
export function activeFilterCount(f: GraphFilter, o: GraphOptions): number {
  const d = defaultFilter();
  const od = defaultOptions();
  return (
    (f.tags.length ? 1 : 0) +
    (f.folder != null ? 1 : 0) +
    (f.netzplan ? 1 : 0) +
    (f.jira_project ? 1 : 0) +
    (f.from || f.to ? 1 : 0) +
    (f.daily !== d.daily ? 1 : 0) +
    (o.orphans !== od.orphans ? 1 : 0) +
    (o.depth ? 1 : 0)
  );
}

// ---- the graph the view draws

export type NodeKind = "page" | "ghost" | "tag" | "file";

export interface VNode {
  /** `p:12`, `u:fehlt noch`, `t:projekt`, `f:bild.png`: stable across loads (the layout cache). */
  key: string;
  kind: NodeKind;
  label: string;
  page?: GraphNodeData;
  /** Links in the drawn graph. */
  degree: number;
}

export interface GraphModel {
  nodes: VNode[];
  /** Pairs of node indexes, each undirected pair once. */
  edges: Uint32Array;
  index: Map<string, number>;
}

export const pageKey = (id: number) => `p:${id}`;

/**
 * The nodes and edges to draw: the pages of `data` plus ghost, tag and file nodes as switched
 * on; without orphans the nodes without any edge go; with a depth only the nodes up to `depth`
 * links from `focus` stay.
 */
export function buildModel(data: GraphData, o: GraphOptions, focus?: string | null): GraphModel {
  let nodes: VNode[] = [];
  const index = new Map<string, number>();
  const add = (n: Omit<VNode, "degree">) => {
    let i = index.get(n.key);
    if (i == null) {
      i = nodes.length;
      index.set(n.key, i);
      nodes.push({ ...n, degree: 0 });
    }
    return i;
  };
  for (const p of data.nodes) add({ key: pageKey(p.id), kind: "page", label: p.title, page: p });
  const pairs = new Set<string>();
  let list: number[] = [];
  const link = (a: number, b: number) => {
    if (a === b) return;
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    if (pairs.has(k)) return;
    pairs.add(k);
    list.push(a, b);
  };
  for (const l of data.links) {
    const a = index.get(pageKey(l.from));
    const b = index.get(pageKey(l.to));
    if (a != null && b != null) link(a, b);
  }
  if (o.unresolved)
    for (const u of data.unresolved) {
      const a = index.get(pageKey(u.from));
      if (a != null) link(a, add({ key: `u:${u.key}`, kind: "ghost", label: u.title }));
    }
  for (const f of data.files) {
    const a = index.get(pageKey(f.from));
    if (a != null) link(a, add({ key: `f:${f.name.toLowerCase()}`, kind: "file", label: f.name }));
  }
  if (o.tagNodes)
    for (const p of data.nodes) {
      const a = index.get(pageKey(p.id))!;
      for (const t of p.tags) link(a, add({ key: `t:${t}`, kind: "tag", label: `#${t}` }));
    }
  for (let i = 0; i < list.length; i++) nodes[list[i]].degree++;

  // Which nodes stay: depth from the focus, then the orphans.
  let keep: boolean[] | null = null;
  const fi = focus != null ? index.get(focus) : undefined;
  if (o.depth > 0 && fi != null) {
    const adj = adjacency(nodes.length, list);
    const dist = bfs(adj, fi, o.depth);
    keep = dist.map((d) => d >= 0);
  }
  if (!o.orphans) {
    keep ??= nodes.map(() => true);
    for (let i = 0; i < nodes.length; i++) if (nodes[i].degree === 0 && i !== fi) keep[i] = false;
  }
  if (keep) {
    const remap = new Int32Array(nodes.length).fill(-1);
    const kept: VNode[] = [];
    nodes.forEach((n, i) => {
      if (keep![i]) {
        remap[i] = kept.length;
        kept.push({ ...n, degree: 0 });
      }
    });
    const next: number[] = [];
    for (let i = 0; i < list.length; i += 2) {
      const a = remap[list[i]];
      const b = remap[list[i + 1]];
      if (a >= 0 && b >= 0) {
        next.push(a, b);
        kept[a].degree++;
        kept[b].degree++;
      }
    }
    nodes = kept;
    list = next;
    index.clear();
    nodes.forEach((n, i) => index.set(n.key, i));
  }
  return { nodes, edges: Uint32Array.from(list), index };
}

export function adjacency(n: number, edges: ArrayLike<number>): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < edges.length; i += 2) {
    adj[edges[i]].push(edges[i + 1]);
    adj[edges[i + 1]].push(edges[i]);
  }
  return adj;
}

/** Link distance of every node from `from` (-1: farther than `max` or not connected). */
export function bfs(adj: number[][], from: number, max: number): number[] {
  const dist = new Array<number>(adj.length).fill(-1);
  dist[from] = 0;
  let frontier = [from];
  for (let d = 1; d <= max && frontier.length; d++) {
    const next: number[] = [];
    for (const i of frontier)
      for (const j of adj[i])
        if (dist[j] < 0) {
          dist[j] = d;
          next.push(j);
        }
    frontier = next;
  }
  return dist;
}

/**
 * Merges a `graph_patch` answer: its nodes replace (or join) the old ones with all their
 * outgoing links, unresolved links and files; `removed` nodes go with their links.
 */
export function applyPatch(data: GraphData, patch: GraphData): GraphData {
  const touched = new Set([...patch.nodes.map((n) => n.id), ...patch.removed]);
  const gone = new Set(patch.removed);
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  for (const id of gone) byId.delete(id);
  for (const n of patch.nodes) byId.set(n.id, n);
  const nodes = [...byId.values()].sort((a, b) => a.id - b.id);
  return {
    nodes,
    links: [...data.links.filter((l) => !touched.has(l.from) && !gone.has(l.to)), ...patch.links.filter((l) => byId.has(l.to))],
    unresolved: [...data.unresolved.filter((u) => !touched.has(u.from)), ...patch.unresolved],
    files: [...data.files.filter((f) => !touched.has(f.from)), ...patch.files],
    removed: [],
  };
}

/** Pages to ask `graph_patch` about for changed `ids`: they and the pages linking to them now. */
export function patchScope(data: GraphData, ids: number[]): number[] {
  const set = new Set(ids);
  for (const l of data.links) if (set.has(l.to)) set.add(l.from);
  return [...set];
}

// ---- search and groups

/** Lower case without accents: „Übersicht“ is found by „ubersicht“. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Indexes of the nodes whose label contains `q` (accents ignored), best first: prefix, then by links. */
export function searchNodes(nodes: VNode[], q: string, limit = 50): number[] {
  const f = fold(q.trim());
  if (!f) return [];
  const hits: [number, number][] = [];
  nodes.forEach((n, i) => {
    const l = fold(n.label);
    const at = l.indexOf(f);
    if (at >= 0) hits.push([i, (at === 0 ? 1e6 : 0) + n.degree]);
  });
  return hits
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([i]) => i);
}

/**
 * Whether a page matches a query of a color group: words that all must match; `tag:x`,
 * `path:x` (folder), `title:x`, `jira:x`, `netzplan:x` look at one field, a plain word at the
 * title and the folder.
 */
export function matchesQuery(p: GraphNodeData, query: string): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.every((w) => {
    const m = /^(tag|path|title|jira|netzplan):(.+)$/i.exec(w);
    const v = fold((m ? m[2] : w).replace(/^#/, ""));
    switch (m?.[1].toLowerCase()) {
      case "tag":
        return p.tags.some((t) => t === v || t.startsWith(`${v}/`));
      case "path":
        return fold(p.folder).includes(v);
      case "title":
        return fold(p.title).includes(v);
      case "jira":
        return !!p.jira && fold(p.jira).startsWith(v);
      case "netzplan":
        return p.netzplan.some((n) => fold(n).includes(v));
      default:
        return w.startsWith("#") ? p.tags.some((t) => t === v || t.startsWith(`${v}/`)) : fold(p.title).includes(v) || fold(p.folder).includes(v);
    }
  });
}

export function matchesRule(p: GraphNodeData, r: GroupRule): boolean {
  switch (r.kind) {
    case "tag": {
      const v = r.value.replace(/^#/, "").toLowerCase();
      return p.tags.some((t) => t === v || t.startsWith(`${v}/`));
    }
    case "folder": {
      const v = fold(r.value.replace(/^\/+|\/+$/g, ""));
      const f = fold(p.folder);
      return f === v || f.startsWith(`${v}/`);
    }
    case "query":
      return matchesQuery(p, r.value);
  }
}

export const topFolder = (p: GraphNodeData) => p.folder.split("/")[0] ?? "";

/**
 * The default colors: one per top-level folder, the biggest first. A top folder holding most
 * of the workspace (an imported vault, „Arbeit“) is split by its subfolders instead.
 */
export interface FolderPalette {
  colors: Map<string, GroupColor>;
  /** Top folders split one level deeper. */
  deep: Set<string>;
}

export function paletteKey(p: GraphNodeData, deep: Set<string>): string {
  const parts = p.folder ? p.folder.split("/") : [];
  if (!parts.length) return "";
  return deep.has(parts[0]) && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

export function folderPalette(pages: GraphNodeData[]): FolderPalette {
  const tops = new Map<string, number>();
  for (const p of pages) {
    const f = topFolder(p);
    if (f) tops.set(f, (tops.get(f) ?? 0) + 1);
  }
  const deep = new Set<string>();
  for (const [f, n] of tops) if (n > pages.length * 0.5 && pages.some((p) => p.folder.startsWith(`${f}/`))) deep.add(f);
  const count = new Map<string, number>();
  for (const p of pages) {
    const k = paletteKey(p, deep);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const order = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
  return { colors: new Map(order.slice(0, GROUP_COLORS.length).map((f, i) => [f, GROUP_COLORS[i]])), deep };
}

/** The color of each node: the first matching rule, else its folder's default (if on), else none. */
export function nodeColors(nodes: VNode[], groups: GroupRule[], palette: FolderPalette | null): (GroupColor | null)[] {
  return nodes.map((n) => {
    if (!n.page) return null;
    for (const g of groups) if (matchesRule(n.page, g)) return g.color;
    return palette?.colors.get(paletteKey(n.page, palette.deep)) ?? null;
  });
}

/** The pages of the drawn graph for „Als Liste anzeigen“: most links first, then by title. */
export function listRows(model: GraphModel): VNode[] {
  return model.nodes.filter((n) => n.kind === "page").sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
}

/**
 * Where a node label goes, in screen pixels: centered under the node but kept inside the
 * canvas (`w` wide, `margin` from each edge), shortened with „…“ when it is wider than the
 * canvas. `measure` gives the drawn width of a text.
 */
export function placeLabel(text: string, sx: number, w: number, measure: (t: string) => number, margin = 4): { text: string; x: number; width: number } {
  const room = Math.max(0, w - margin * 2);
  let width = measure(text);
  if (width > room) {
    const chars = Array.from(text);
    let n = chars.length;
    while (n > 1 && width > room) {
      n--;
      text = `${chars.slice(0, n).join("").trimEnd()}…`;
      width = measure(text);
    }
  }
  const half = width / 2;
  const x = width >= room ? w / 2 : Math.min(Math.max(sx, margin + half), w - margin - half);
  return { text, x, width };
}

/** Radius of a node in graph units. */
export function nodeRadius(n: VNode, d: Pick<GraphDisplay, "sizeByLinks" | "nodeSize">): number {
  const base = n.kind === "page" ? 4.5 : 3.5;
  return (d.sizeByLinks ? base + Math.sqrt(n.degree) * 2 : base + 1.5) * d.nodeSize;
}

/** The node nearest to node `from` in an arrow key's direction (keyboard navigation), or -1. */
export function nearestInDirection(pos: ArrayLike<number>, count: number, from: number, dir: "left" | "right" | "up" | "down"): number {
  const x0 = pos[from * 2];
  const y0 = pos[from * 2 + 1];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < count; i++) {
    if (i === from) continue;
    const dx = pos[i * 2] - x0;
    const dy = pos[i * 2 + 1] - y0;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    // Straight ahead counts more than off to the side.
    const score = along + across * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
