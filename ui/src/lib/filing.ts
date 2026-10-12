// Ordner & Ablage: the IPC of the filing (tidy-up, moving many pages, folder styles, smart
// folders) and the pure helpers of the page tree: per-folder sorting, the filter that keeps
// ancestors, the fuzzy folder picker and range selection.

import { invoke } from "@tauri-apps/api/core";
import { currentLang, t, type Lang } from "./i18n";
import type { Page, PageNode } from "./types";

export type FileType = "journal" | "meeting" | "voice" | "jira" | "mail" | "bookmarks" | "inbox" | "canvas";
export type Granularity = "none" | "year" | "month" | "week" | "series";
export type RuleKind = "tag" | "property" | "jira" | "netzplan" | "title";
export type FolderSort = "manual" | "name" | "modified" | "created";
export type FolderColor = "accent" | "info" | "success" | "warning" | "danger" | "violet" | "muted";

export const FILE_TYPES: FileType[] = ["journal", "meeting", "voice", "jira", "mail", "bookmarks", "inbox", "canvas"];
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
  canvas: "none",
};

export const typeFiling = (f: FilingSettings | undefined, kind: FileType): TypeFiling => f?.types?.[kind] ?? { folder: "", granularity: DEFAULT_GRANULARITY[kind] };

export const filingApi = {
  tidyPlan: (scope: number | null = null) => invoke<TidyMove[]>("filing_tidy_plan", { scope }),
  tidyApply: (scope: number | null, pageIds: number[]) => invoke<MoveOutcome>("filing_tidy_apply", { scope, pageIds }),
  movePages: (pageIds: number[], parentId: number | null, position: number | null = null) => invoke<MoveOutcome>("pages_move", { pageIds, parentId, position }),
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

// The app's language, not the system default: under a C/POSIX locale (LANG=C.UTF-8 on many Linux
// machines) the default collator sorts by code point, every capital before every small letter.
const collators: Partial<Record<Lang, Intl.Collator>> = {};
const collator = () => (collators[currentLang()] ??= new Intl.Collator(currentLang(), { numeric: true, sensitivity: "base" }));

/** The children in the order of the folder's style (`manual` keeps the stored order). */
export function sortNodes(nodes: PageNode[], style: FolderStyle | null | undefined): PageNode[] {
  const s = style ?? DEFAULT_STYLE;
  if (s.sort === "manual" && !s.folders_first) return nodes;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const by: Record<FolderSort, (a: PageNode, b: PageNode) => number> = {
    manual: (a, b) => index.get(a.id)! - index.get(b.id)!,
    name: (a, b) => collator().compare(a.title, b.title) || index.get(a.id)! - index.get(b.id)!,
    // Newest first.
    modified: (a, b) => b.updated_at.localeCompare(a.updated_at) || index.get(a.id)! - index.get(b.id)!,
    created: (a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || index.get(a.id)! - index.get(b.id)!,
  };
  const cmp = by[s.sort] ?? by.manual;
  return [...nodes].sort((a, b) => (s.folders_first ? Number(b.children.length > 0) - Number(a.children.length > 0) : 0) || cmp(a, b));
}

/** Folds case and accents (ä → a) for matching. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** What the tree filter found: the hits, the pages shown (hits and their ancestors) and whether
 *  the hits are only similar (no title contains the words, see `filterIds`). */
export interface TreeFilter {
  hits: Set<number>;
  shown: Set<number>;
  fuzzy: boolean;
}

/** The words of each part of a filter: „Kunde/Angebot“ is a path of two parts. */
export function filterParts(query: string): string[][] {
  return query
    .split("/")
    .map((part) => fold(part).split(/\s+/).filter(Boolean))
    .filter((words) => words.length);
}

/** Whether the parts before the last one name ancestors of the page, in order (each part all
 *  its words in one ancestor; ancestors may lie between them). `line`: folded titles from the top. */
function pathMatches(line: string[], parts: string[][]): boolean {
  let at = 0;
  for (const words of parts) {
    while (at < line.length && !words.every((w) => line[at].includes(w))) at++;
    if (at >= line.length) return false;
    at++;
  }
  return true;
}

/** The shortest stretch of `text` holding the letters of `q` in order (its length; -1: none). */
function fuzzySpan(q: string, text: string): number {
  let best = -1;
  for (let start = text.indexOf(q[0]); start >= 0; start = text.indexOf(q[0], start + 1)) {
    let at = start;
    for (let k = 1; k < q.length && at >= 0; k++) at = text.indexOf(q[k], at + 1);
    if (at < 0) break;
    if (best < 0 || at - start + 1 < best) best = at - start + 1;
  }
  return best;
}

/** Fuzzy hit (`title` folded): the letters in order within twice their number, mostly in runs or at word starts. */
function fuzzyHit(query: string, title: string): boolean {
  const q = query.replace(/\s+/g, "");
  if (q.length < 3) return false;
  const span = fuzzySpan(q, title);
  return span > 0 && span <= q.length * 2 && fuzzyScore(q, title) >= q.length * 20;
}

/**
 * The tree filter: the pages whose title contains every word of `query`, plus their ancestors
 * (shown so the hit stays in context). „Kunde/Angebot“ also asks the ancestors: a page with
 * „Angebot“ below one with „Kunde“. When no title contains the words, the titles with the
 * letters in order and close together count (`fuzzy`). `null` for an empty query.
 */
export function filterIds(nodes: PageNode[], query: string): TreeFilter | null {
  const parts = filterParts(query);
  if (!parts.length) return null;
  const words = parts[parts.length - 1];
  const above = parts.slice(0, -1);
  const hits = new Set<number>();
  const shown = new Set<number>();
  const ids: number[] = [];
  const line: string[] = [];
  const hit = (id: number) => {
    hits.add(id);
    shown.add(id);
    ids.forEach((a) => shown.add(a));
  };
  const walk = (list: PageNode[], test: (title: string) => boolean) => {
    for (const n of list) {
      const title = fold(n.title);
      if (test(title) && (!above.length || pathMatches(line, above))) hit(n.id);
      if (n.children.length) {
        ids.push(n.id);
        line.push(title);
        walk(n.children, test);
        ids.pop();
        line.pop();
      }
    }
  };
  walk(nodes, (title) => words.every((w) => title.includes(w)));
  if (hits.size || above.length) return { hits, shown, fuzzy: false };
  const q = words.join(" ");
  walk(nodes, (title) => fuzzyHit(q, title));
  return { hits, shown, fuzzy: true };
}

/** `text` folded as `fold` does, with the index in `text` of every folded character. */
function foldWithMap(text: string): { folded: string; at: number[] } {
  let folded = "";
  const at: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) at.push(i);
    folded += f;
    i += ch.length;
  }
  at.push(text.length);
  return { folded, at };
}

/** The parts of `title` the filter matched, as [start, end) ranges in order (for highlighting). */
export function matchRanges(title: string, query: string, fuzzy = false): [number, number][] {
  const parts = filterParts(query);
  if (!parts.length) return [];
  const words = parts[parts.length - 1];
  const { folded, at } = foldWithMap(title);
  const out: [number, number][] = [];
  if (fuzzy) {
    let from = 0;
    for (const ch of words.join("")) {
      const k = folded.indexOf(ch, from);
      if (k < 0) return [];
      out.push([at[k], at[k + 1]]);
      from = k + 1;
    }
  } else {
    for (const w of words) {
      const k = folded.indexOf(w);
      if (k >= 0) out.push([at[k], at[k + w.length]]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * Typeahead in the tree: the row to go to for the letters typed so far, -1 when none starts with
 * them. A new search (one letter) starts after `current`; a longer one may stay on it. The same
 * letter typed again („aaa“) cycles through the rows starting with it.
 */
export function typeahead(labels: string[], current: number, typed: string): number {
  const q = fold(typed);
  if (!q || !labels.length) return -1;
  const same = [...q].every((c) => c === q[0]);
  const want = same ? q[0] : q;
  const from = q.length === 1 || same ? current + 1 : Math.max(current, 0);
  for (let k = 0; k < labels.length; k++) {
    const i = (from + k) % labels.length;
    if (fold(labels[i]).startsWith(want)) return i;
  }
  return -1;
}

export type DropPos = "before" | "inside" | "after";
/** Where a dragged page lands: at a position next to a row, into a folder, or nowhere (and why). */
export type DropPlan = { kind: "at"; parent: number | null; pos: DropPos; row: number } | { kind: "into"; parent: number | null } | { kind: "refused"; folder: number | null };

/**
 * The drop for a pointer at `y` (0 top, 1 bottom) of `row`: the upper and lower quarter mean
 * before and after it, the middle into it. In a folder sorted by name or date a place between
 * two pages means nothing: pages from elsewhere go into that folder (it sorts them), and pages
 * already in it are refused.
 */
export function planDrop(y: number, row: { id: number; parent_id: number | null }, parentSorted: boolean, moving: { parent_id: number | null }[]): DropPlan {
  const pos: DropPos = y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
  if (pos === "inside") return { kind: "at", parent: row.id, pos, row: row.id };
  if (!parentSorted) return { kind: "at", parent: row.parent_id, pos, row: row.id };
  if (moving.every((m) => m.parent_id === row.parent_id)) return { kind: "refused", folder: row.parent_id };
  return { kind: "into", parent: row.parent_id };
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

/** Whether `id` is `ancestor` itself or lies below it (a page cannot be dropped into its own subtree). */
export function isWithin(id: number, ancestor: number, parentOf: (id: number) => number | null | undefined): boolean {
  for (let p: number | null | undefined = id, guard = 0; p != null && guard < 10_000; p = parentOf(p), guard++) if (p === ancestor) return true;
  return false;
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

/** Why `title` cannot name page `id` (empty, or another page has it, as the core checks it:
 *  case-insensitive), or null. Renaming in the tree shows it under the field. */
export function renameProblem(id: number, title: string, pages: Map<number, { id: number; title: string }>): string | null {
  const name = title.trim();
  if (!name) return t("sb.renameEmpty");
  const lower = name.toLowerCase();
  for (const p of pages.values()) if (p.id !== id && p.title.toLowerCase() === lower) return t("sb.renameTaken", { title: p.title });
  return null;
}
