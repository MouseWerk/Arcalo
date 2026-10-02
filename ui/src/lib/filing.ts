// Ordner & Ablage: the IPC of the filing (tidy-up, moving many pages, folder styles, smart
// folders) and the pure helpers of the page tree: per-folder sorting, the filter that keeps
// ancestors, the fuzzy folder picker and range selection.

import { invoke } from "@tauri-apps/api/core";
import type { Page, PageNode } from "./types";

export type FileType = "journal" | "meeting" | "voice" | "jira" | "mail" | "bookmarks" | "inbox";
export type Granularity = "none" | "year" | "month" | "week" | "series";
export type RuleKind = "tag" | "property" | "jira" | "netzplan" | "title";
export type FolderSort = "manual" | "name" | "modified" | "created";
export type FolderColor = "accent" | "info" | "success" | "warning" | "danger" | "violet" | "muted";

export const FILE_TYPES: FileType[] = ["journal", "meeting", "voice", "jira", "mail", "bookmarks", "inbox"];
export const FOLDER_SORTS: FolderSort[] = ["manual", "name", "modified", "created"];
export const FOLDER_COLORS: FolderColor[] = ["accent", "info", "success", "warning", "danger", "violet", "muted"];

export interface TypeFiling {
  folder: string;
  granularity: Granularity;
}
export interface FilingRule {
  id: string;
  kind: RuleKind;
  key: string;
  value: string;
  folder: string;
  enabled: boolean;
}
export interface FilingSettings {
  types: Partial<Record<FileType, TypeFiling>>;
  rules: FilingRule[];
}
export interface FolderStyle {
  sort: FolderSort;
  folders_first: boolean;
  color: FolderColor | null;
}
export interface TidyMove {
  page_id: number;
  title: string;
  icon: string | null;
  from: string;
  to: string;
  kind: FileType | null;
  rule: string | null;
  creates: boolean;
}
export interface MoveOutcome {
  moved: number;
  folders: number;
}
export interface LastMove {
  label: "tidy" | "move";
  pages: number;
}
export interface FilingPreview {
  kind: FileType | null;
  rule: string | null;
  path: string | null;
  current: string;
}
export type SmartKind = "recent" | "favorites" | "unfiled" | "orphans" | "tags" | "jira" | "netzplan";
export type SmartCounts = Record<SmartKind, number>;
export interface SmartPage {
  id: number;
  title: string;
  icon: string | null;
  updated_at: string;
}
export interface SmartGroup {
  key: string;
  label: string;
  count: number;
}

/** Granularity of a type when not set (as in the core). */
export const DEFAULT_GRANULARITY: Record<FileType, Granularity> = {
  journal: "month",
  meeting: "month",
  voice: "month",
  jira: "none",
  mail: "month",
  bookmarks: "none",
  inbox: "none",
};

export const typeFiling = (f: FilingSettings | undefined, kind: FileType): TypeFiling => f?.types?.[kind] ?? { folder: "", granularity: DEFAULT_GRANULARITY[kind] };

export const filingApi = {
  tidyPlan: (scope: number | null = null) => invoke<TidyMove[]>("filing_tidy_plan", { scope }),
  tidyApply: (scope: number | null, pageIds: number[]) => invoke<MoveOutcome>("filing_tidy_apply", { scope, pageIds }),
  movePages: (pageIds: number[], parentId: number | null) => invoke<MoveOutcome>("pages_move", { pageIds, parentId }),
  lastMove: () => invoke<LastMove | null>("move_last"),
  undoMove: () => invoke<number>("move_undo"),
  preview: (pageId: number, filing: FilingSettings) => invoke<FilingPreview>("filing_preview", { pageId, filing }),
  folderStyle: (pageId: number) => invoke<FolderStyle>("folder_style_get", { pageId }),
  setFolderStyle: (pageId: number, style: FolderStyle) => invoke<void>("folder_style_set", { pageId, style }),
  smartCounts: () => invoke<SmartCounts>("smart_counts"),
  smartPages: (kind: SmartKind, key: string | null = null) => invoke<SmartPage[]>("smart_pages", { kind, key }),
  smartGroups: (kind: SmartKind) => invoke<SmartGroup[]>("smart_groups", { kind }),
  createFiled: (kind: FileType, title: string, icon: string | null, content?: string) =>
    invoke<{ page: Page; folders: number[] }>("page_create_filed", { kind, title, icon, content: content ?? null }),
};

export const DEFAULT_STYLE: FolderStyle = { sort: "manual", folders_first: false, color: null };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The children in the order of the folder's style (`manual` keeps the stored order). */
export function sortNodes(nodes: PageNode[], style: FolderStyle | null | undefined): PageNode[] {
  const s = style ?? DEFAULT_STYLE;
  if (s.sort === "manual" && !s.folders_first) return nodes;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const by: Record<FolderSort, (a: PageNode, b: PageNode) => number> = {
    manual: (a, b) => index.get(a.id)! - index.get(b.id)!,
    name: (a, b) => collator.compare(a.title, b.title) || index.get(a.id)! - index.get(b.id)!,
    // Newest first.
    modified: (a, b) => b.updated_at.localeCompare(a.updated_at) || index.get(a.id)! - index.get(b.id)!,
    created: (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || index.get(a.id)! - index.get(b.id)!,
  };
  const cmp = by[s.sort] ?? by.manual;
  return [...nodes].sort((a, b) => (s.folders_first ? Number(b.children.length > 0) - Number(a.children.length > 0) : 0) || cmp(a, b));
}

/** Folds case and accents (ä → a) for matching. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The tree filter: the ids of the pages whose title contains every word of `query`, plus their
 * ancestors (shown so the hit stays in context). `null` for an empty query.
 */
export function filterIds(nodes: PageNode[], query: string): { hits: Set<number>; shown: Set<number> } | null {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const hits = new Set<number>();
  const shown = new Set<number>();
  const walk = (list: PageNode[], line: number[]) => {
    for (const n of list) {
      const title = fold(n.title);
      if (words.every((w) => title.includes(w))) {
        hits.add(n.id);
        shown.add(n.id);
        line.forEach((a) => shown.add(a));
      }
      if (n.children.length) walk(n.children, [...line, n.id]);
    }
  };
  walk(nodes, []);
  return { hits, shown };
}

/**
 * Fuzzy score of `text` for `query` (higher is better, -1: no match): the letters in order,
 * consecutive letters and word starts count more, a shorter text wins a tie.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = fold(query).replace(/\s+/g, "");
  if (!q) return 0;
  const t = fold(text);
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    score += 1;
    if (at === prev + 1) score += 3;
    if (at === 0 || /[\s/\-_.]/.test(t[at - 1])) score += 2;
    prev = at;
    ti = at + 1;
  }
  return score * 10 - Math.min(t.length, 200) / 20;
}

export interface FolderOption {
  id: number | null;
  /** „Projekte / Kunde X“ */
  path: string;
  title: string;
  icon: string | null;
  depth: number;
}

/** Every page as a move target with its path, in tree order (the top level first). */
export function folderOptions(nodes: PageNode[]): FolderOption[] {
  const out: FolderOption[] = [];
  const walk = (list: PageNode[], line: string[]) => {
    for (const n of list) {
      const path = [...line, n.title];
      out.push({ id: n.id, path: path.join(" / "), title: n.title, icon: n.icon, depth: line.length });
      if (n.children.length) walk(n.children, path);
    }
  };
  walk(nodes, []);
  return out;
}

/** The targets matching `query`, best first; folders (pages with children) before pages on a tie. */
export function pickFolders(options: FolderOption[], query: string, folders: Set<number>, limit = 50): FolderOption[] {
  if (!query.trim()) return options.filter((o) => o.id != null && folders.has(o.id)).slice(0, limit);
  return options
    .map((o) => {
      const title = fuzzyScore(query, o.title);
      const best = Math.max(title < 0 ? -1 : title + 5, fuzzyScore(query, o.path));
      return { o, s: best < 0 ? -1 : best + (o.id != null && folders.has(o.id) ? 2 : 0) };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.o);
}

/** Shift-click: the ids from `anchor` to `to` in visible order (both included). */
export function rangeIds(order: number[], anchor: number | null, to: number): number[] {
  const b = order.indexOf(to);
  const a = anchor == null ? -1 : order.indexOf(anchor);
  if (b < 0) return [];
  if (a < 0) return [to];
  const [from, end] = a < b ? [a, b] : [b, a];
  return order.slice(from, end + 1);
}

/** Of the selected ids, the ones whose ancestor is not selected (they carry their subtree). */
export function topSelected(selected: Iterable<number>, parentOf: (id: number) => number | null | undefined): number[] {
  const set = new Set(selected);
  return [...set].filter((id) => {
    let p = parentOf(id);
    while (p != null) {
      if (set.has(p)) return false;
      p = parentOf(p);
    }
    return true;
  });
}
