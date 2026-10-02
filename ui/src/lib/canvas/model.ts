// The canvas document: JSON Canvas (jsoncanvas.org), as Obsidian writes it. Nodes and edges are
// kept as the objects read from the file, so fields Arcalo does not know (and their order) stay;
// edits replace the known fields of a node with a spread copy. Arcalo's own fields: `issue` on a
// link node (a Jira issue card), `title` on a link node (the page title fetched for the URL) and
// `path` on an edge (`straight`; curved when absent).

export type Side = "top" | "right" | "bottom" | "left";
export const SIDES: Side[] = ["top", "right", "bottom", "left"];

export interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  /** text node: Markdown. */
  text?: string;
  /** file node: vault path (`Ordner/Seite.md`, `attachments/bild.png`). */
  file?: string;
  subpath?: string;
  /** link node. */
  url?: string;
  title?: string;
  issue?: string;
  /** group node. */
  label?: string;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
  path?: "straight" | "curved";
  [key: string]: unknown;
}

export interface CanvasDoc {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}

/** What a card shows. */
export type CardKind = "text" | "note" | "image" | "file" | "link" | "issue" | "group";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
export const isImagePath = (path: string) => IMAGE_EXT.test(path);

export function cardKind(n: CanvasNode): CardKind {
  switch (n.type) {
    case "text":
      return "text";
    case "group":
      return "group";
    case "link":
      return typeof n.issue === "string" && n.issue ? "issue" : "link";
    case "file": {
      const f = n.file ?? "";
      if (/\.md$/i.test(f)) return "note";
      return isImagePath(f) ? "image" : "file";
    }
    default:
      // Node types of a later format version: shown as a plain card, kept as they are.
      return "text";
  }
}

/** The last path component (`Ordner/Plan.md` → `Plan.md`). */
export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** The page a note card shows (`Ordner/Plan.md` → `Plan`). */
export const noteTitle = (path: string) => baseName(path).replace(/\.md$/i, "");

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/**
 * Whether the text is a canvas the board can show and save: empty (a new board) or a JSON
 * object. Anything else (a Git conflict, a broken file) must not be replaced by an empty board.
 */
export function isReadableCanvas(text: string): boolean {
  if (!text.trim()) return true;
  try {
    const raw: unknown = JSON.parse(text);
    return !!raw && typeof raw === "object" && !Array.isArray(raw);
  } catch {
    return false;
  }
}

/**
 * Entries of the file the board cannot show (an edge whose card is missing, a node without an
 * id): kept on the document under this key and written back by `serializeCanvas`, so a save
 * never drops them silently (another app or a merge may bring the missing card back).
 */
export const KEPT = "\u0000kept";

/** The entries `parseCanvas` set aside (see `KEPT`). */
export function keptItems(doc: CanvasDoc): { nodes: unknown[]; edges: unknown[] } {
  const k = doc[KEPT] as { nodes: unknown[]; edges: unknown[] } | undefined;
  return k ?? { nodes: [], edges: [] };
}

/** Reads a canvas; anything unreadable becomes an empty board (the file stays as it was until saved). */
export function parseCanvas(text: string): CanvasDoc {
  let raw: unknown = null;
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    raw = {};
  }
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const isNode = (n: unknown): n is Record<string, unknown> => !!n && typeof n === "object" && typeof (n as { id?: unknown }).id === "string";
  const rawNodes: unknown[] = Array.isArray(obj.nodes) ? obj.nodes : [];
  const nodes = rawNodes.filter(isNode).map((n) => ({ ...n, x: num(n.x, 0), y: num(n.y, 0), width: num(n.width, 250), height: num(n.height, 60) }) as CanvasNode);
  const ids = new Set(nodes.map((n) => n.id));
  const rawEdges: unknown[] = Array.isArray(obj.edges) ? obj.edges : [];
  const shown = (e: unknown): e is CanvasEdge =>
    !!e && typeof e === "object" && typeof (e as CanvasEdge).id === "string" && ids.has((e as CanvasEdge).fromNode) && ids.has((e as CanvasEdge).toNode);
  const edges = rawEdges.filter(shown);
  const doc: CanvasDoc = { ...obj, nodes, edges };
  delete doc[KEPT];
  const kept = { nodes: rawNodes.filter((n) => !isNode(n)), edges: rawEdges.filter((e) => !shown(e)) };
  if (kept.nodes.length || kept.edges.length) doc[KEPT] = kept;
  return doc;
}

/** The file text: tab-indented JSON like Obsidian writes, with the entries the board set aside. */
export function serializeCanvas(doc: CanvasDoc): string {
  const { [KEPT]: _kept, ...rest } = doc;
  const kept = keptItems(doc);
  return JSON.stringify({ ...rest, nodes: [...doc.nodes, ...kept.nodes], edges: [...doc.edges, ...kept.edges] }, null, "\t");
}

/** A fresh id: 16 hex digits, like Obsidian's. */
export function newId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** JSON Canvas preset colors 1–6 (red, orange, yellow, green, cyan, purple). */
export const PRESET_COLORS = ["1", "2", "3", "4", "5", "6"] as const;

/** The CSS color of a node or edge color: presets follow the theme, `#rrggbb` is used as is. */
export function colorValue(color: string | undefined): string | null {
  if (!color) return null;
  if ((PRESET_COLORS as readonly string[]).includes(color)) return `var(--cv-c${color})`;
  return /^#[0-9a-f]{3,8}$/i.test(color) ? color : null;
}

/** Default card sizes (canvas units) per kind. */
export const DEFAULT_SIZE: Record<CardKind, { width: number; height: number }> = {
  text: { width: 260, height: 120 },
  note: { width: 400, height: 400 },
  image: { width: 320, height: 220 },
  file: { width: 280, height: 72 },
  link: { width: 320, height: 96 },
  issue: { width: 320, height: 104 },
  group: { width: 600, height: 400 },
};

/** Replaces one node by a copy with `patch` (unknown fields kept). */
export function patchNode(doc: CanvasDoc, id: string, patch: Partial<CanvasNode>): CanvasDoc {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? withoutUndefined({ ...n, ...patch }) : n)) };
}

export function patchEdge(doc: CanvasDoc, id: string, patch: Partial<CanvasEdge>): CanvasDoc {
  return { ...doc, edges: doc.edges.map((e) => (e.id === id ? withoutUndefined({ ...e, ...patch }) : e)) };
}

/** `undefined` in a patch removes the field (JSON has no undefined). */
function withoutUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Removes nodes (with their edges) and edges. */
export function removeItems(doc: CanvasDoc, nodeIds: Set<string>, edgeIds: Set<string> = new Set()): CanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: doc.edges.filter((e) => !edgeIds.has(e.id) && !nodeIds.has(e.fromNode) && !nodeIds.has(e.toNode)),
  };
}

/** Groups first, so they are drawn below the cards (JSON Canvas: later nodes on top). */
export function withNode(doc: CanvasDoc, node: CanvasNode): CanvasDoc {
  if (node.type !== "group") return { ...doc, nodes: [...doc.nodes, node] };
  const firstCard = doc.nodes.findIndex((n) => n.type !== "group");
  const nodes = [...doc.nodes];
  nodes.splice(firstCard < 0 ? nodes.length : firstCard, 0, node);
  return { ...doc, nodes };
}
