// „Lesezeichen importieren“: the bookmarks of a browser (or an HTML export) as a tree with a
// selection, and the plan of what goes where: folders become link groups, links of the
// bookmarks bar ribbon links, and what does not fit (or is chosen so) Markdown pages.
// Pure functions; the dialog (components/BookmarkImport.tsx) shows and applies the plan.

import { invoke } from "@tauri-apps/api/core";
import type { QuickLink } from "./types";
import { isGroup, isPath } from "./quicklinks";

// ------------------------------------------------------------------ data from the backend

export interface BmNode {
  title: string;
  /** A bookmark's address; none for a folder. */
  url?: string;
  /** Unix seconds. */
  added?: number;
  /** A browser's top folder: bar, menu, other, mobile, reading. */
  role?: string;
  children?: BmNode[];
}
export type SkipReason = "script" | "internal" | "other";
export interface BmTree {
  roots: BmNode[];
  skipped: { title: string; url: string; reason: SkipReason }[];
  links: number;
  truncated: boolean;
}
export interface BmLocation {
  id: string;
  browser: string;
  browser_name: string;
  profile: string;
  profile_dir: string;
  default: boolean;
  format: "chromium" | "firefox" | "safari";
  path: string;
}
export interface BmSource extends BmLocation {
  status: "ok" | "locked" | "permission" | "error";
  count: number;
  error: string | null;
}

export const bookmarksApi = {
  sources: () => invoke<BmSource[]>("bookmarks_sources"),
  read: (source: string) => invoke<{ source: BmLocation; tree: BmTree }>("bookmarks_read", { source }),
  readFile: (path: string) => invoke<BmTree>("bookmarks_read_file", { path }),
  readText: (text: string) => invoke<BmTree>("bookmarks_read_text", { text }),
};

/** The ribbon's limits (crates/annalo-core/src/settings.rs). */
export const MAX_RIBBON = 40;
export const MAX_GROUP = 60;

/** Files taken as bookmark exports. */
export const isBookmarksFile = (name: string) => /\.html?$/i.test(name.trim());

// ------------------------------------------------------------------ tree and selection

export interface Entry {
  /** Position in the tree: "0", "0.2", "0.2.1". */
  id: string;
  node: BmNode;
  parent: string | null;
  depth: number;
  folder: boolean;
  /** Shown title (top folders by their role). */
  title: string;
  /** Titles of the folders above, from the top. */
  path: string[];
  /** The bookmarks inside (a bookmark: itself). */
  leaves: string[];
  children: string[];
}
export interface TreeIndex {
  entries: Map<string, Entry>;
  roots: string[];
  /** Every id in reading order. */
  order: string[];
}

/** Indexes the tree; `label` names a top folder by its role (else the browser's title). */
export function indexTree(tree: BmTree, label: (n: BmNode) => string = (n) => n.title): TreeIndex {
  const entries = new Map<string, Entry>();
  const order: string[] = [];
  const walk = (n: BmNode, id: string, parent: string | null, path: string[]): Entry => {
    const folder = n.url === undefined || n.url === null;
    const title = (parent === null && n.role ? label(n) : n.title) || n.url || "";
    const e: Entry = { id, node: n, parent, depth: path.length, folder, title, path, leaves: [], children: [] };
    entries.set(id, e);
    order.push(id);
    if (!folder) e.leaves = [id];
    (n.children ?? []).forEach((c, i) => {
      const child = walk(c, `${id}.${i}`, id, [...path, title]);
      e.children.push(child.id);
      e.leaves.push(...child.leaves);
    });
    return e;
  };
  const roots = tree.roots.map((r, i) => walk(r, String(i), null, []).id);
  return { entries, roots, order };
}

export type Check = "all" | "none" | "some";

/** A folder's box: all, none or some of its (visible) bookmarks chosen. */
export function checkState(e: Entry, sel: ReadonlySet<string>, visible: ReadonlySet<string> | null = null): Check {
  const leaves = visible ? e.leaves.filter((l) => visible.has(l)) : e.leaves;
  let n = 0;
  for (const l of leaves) if (sel.has(l)) n++;
  return n === 0 ? "none" : n === leaves.length ? "all" : "some";
}

/** Ticks or clears an entry (a folder: all its visible bookmarks, cleared only when all were ticked). */
export function toggleEntry(idx: TreeIndex, id: string, sel: ReadonlySet<string>, visible: ReadonlySet<string> | null = null): Set<string> {
  const e = idx.entries.get(id);
  const next = new Set(sel);
  if (!e) return next;
  const leaves = visible ? e.leaves.filter((l) => visible.has(l)) : e.leaves;
  const on = checkState(e, sel, visible) !== "all";
  for (const l of leaves) if (on) next.add(l);
  else next.delete(l);
  return next;
}

export const allLeaves = (idx: TreeIndex) => idx.order.filter((id) => !idx.entries.get(id)!.folder);

/**
 * The entries a search shows: bookmarks whose title, address or folder path holds every word,
 * the folders above them, and everything in a folder whose title matches. `null` = no search.
 */
export function visibleFor(idx: TreeIndex, q: string): Set<string> | null {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const out = new Set<string>();
  const addUp = (id: string | null) => {
    for (let p = id; p !== null && !out.has(p); p = idx.entries.get(p)!.parent) out.add(p);
  };
  const addDown = (e: Entry) => {
    out.add(e.id);
    e.children.forEach((c) => addDown(idx.entries.get(c)!));
  };
  for (const id of idx.order) {
    const e = idx.entries.get(id)!;
    const own = `${e.title} ${e.node.url ?? ""}`.toLowerCase();
    const hay = `${e.path.join(" ")} ${own}`.toLowerCase();
    if (e.folder) {
      if (words.every((w) => own.includes(w))) {
        addDown(e);
        addUp(e.parent);
      }
    } else if (words.every((w) => hay.includes(w))) addUp(id);
  }
  return out;
}

// ------------------------------------------------------------------ icons and addresses

/** A named icon for a bookmark by its address (no favicons are read). */
export function bookmarkIcon(url: string): string {
  const u = url.toLowerCase();
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* a path or something odd */
  }
  if (u.startsWith("file:") || isPath(url)) return "folder";
  if (/fiori|\bsap\b|s4hana|\/sap\/|^s4[.-]|\.sap\./.test(host + " " + u)) return "briefcase";
  if (/(^|\.)(mail|webmail|owa)\.|outlook\.(office|live)|gmail\.|\/owa\b|\/mail\b/.test(host + u.replace(/^https?:\/\/[^/]+/, ""))) return "mail";
  if (/calendar|kalender/.test(u)) return "calendar";
  if (/jira|ticket|servicenow|redmine|youtrack/.test(u)) return "ticket";
  if (/git(hub|lab|ea)|bitbucket|azure\.com\/.*_git|dev\.azure\.com/.test(u)) return "code";
  if (/confluence|wiki|notion|docs\.|learn\.|support\./.test(u)) return "book-open";
  if (/teams|zoom|meet\.|webex/.test(u)) return "video";
  if (/grafana|kibana|powerbi|dashboard|tableau/.test(u)) return "chart";
  if (/news|zeitung|tagesschau|spiegel\.de|heise\.de/.test(u)) return "newspaper";
  if (/cloud|azure|aws\.|portal\./.test(host)) return "cloud";
  if (/intranet|sharepoint/.test(u)) return "home";
  return "globe";
}

/** An address as compared for duplicates: no scheme (http = https), host in lower case without „www.“, no trailing slash. */
export function urlKey(raw: string): string {
  let s = raw.trim();
  if (isPath(s) && !/^file:/i.test(s)) return s.replace(/[\\/]+$/, "").toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const scheme = u.protocol === "http:" || u.protocol === "https:" ? "" : u.protocol;
    return `${scheme}${host}${u.port ? `:${u.port}` : ""}${path}${u.search}${u.hash}`;
  } catch {
    return s.toLowerCase();
  }
}

/** Every address in the ribbon (links and the entries of groups). */
export function ribbonUrls(links: QuickLink[]): Set<string> {
  const out = new Set<string>();
  for (const l of links) {
    if (isGroup(l)) (l.items ?? []).forEach((i) => out.add(urlKey(i.url)));
    else out.add(urlKey(l.url));
  }
  return out;
}

// ------------------------------------------------------------------ the plan

export type Dest = "ribbon" | "page";
export interface PlanItem {
  name: string;
  url: string;
  icon: string;
  /** Folders below the unit's folder (a page lists them as headings). */
  sub: string[];
}
export interface Unit {
  /** The folder's entry id, or `loose:<id>` for the ribbon links of a top folder. */
  key: string;
  /** A group, or single links straight into the ribbon. */
  kind: "group" | "links";
  name: string;
  /** Chosen bookmarks, without duplicates of this import. */
  items: PlanItem[];
  dest: Dest;
  /** An existing group of that name takes the links. */
  merge: number | null;
  /** How many go into the ribbon, into a page, nowhere (over the limit, no pages), and were already there. */
  inRibbon: number;
  toPage: number;
  dropped: number;
  duplicates: number;
  /** Not everything fit into the ribbon. */
  over: boolean;
}
export interface PlannedPage {
  key: string;
  title: string;
  items: PlanItem[];
}
export interface Plan {
  units: Unit[];
  /** The ribbon after the import. */
  links: QuickLink[];
  pages: PlannedPage[];
  /** New ribbon entries and links. */
  newEntries: number;
  newLinks: number;
  /** Already in the ribbon (or twice in the selection), skipped. */
  duplicates: number;
  /** Did not fit and were left out. */
  dropped: number;
  /** Bookmarks that go to pages because they did not fit. */
  overflow: number;
}
export interface PlanOptions {
  /** Subfolders as groups of their own („Ordner / Unterordner“) instead of inside the group. */
  split: boolean;
  /** What does not fit: pages, or left out. */
  overflow: "pages" | "drop";
  /** Units the user sent somewhere. */
  dest: Record<string, Dest>;
  /** Name of the page for bookmarks at the top of a file. */
  topName?: string;
}

/** Ribbon links come from the bookmarks bar and from bookmarks at the top of a file. */
const LOOSE_AS_LINKS = new Set(["bar"]);

/**
 * Groups the chosen bookmarks: links at the top and directly in the bookmarks bar are ribbon
 * links, links directly in another top folder (Weitere Lesezeichen, Menü …) one group with its
 * name, and every folder a group (its subfolders inside, with their path before the name, or
 * as groups of their own with `split`).
 */
export function unitsOf(idx: TreeIndex, sel: ReadonlySet<string>, split: boolean, topName = "Lesezeichen"): Omit<Unit, "dest" | "merge" | "inRibbon" | "toPage" | "dropped" | "duplicates" | "over">[] {
  type Raw = { key: string; kind: "group" | "links"; name: string; ids: { id: string; sub: string[] }[] };
  const units: Raw[] = [];
  const looseTop: Raw = { key: "loose:top", kind: "links", name: topName, ids: [] };
  const groupOf = (folder: Entry, name: string) => {
    const u: Raw = { key: folder.id, kind: "group", name, ids: [] };
    units.push(u);
    const walk = (e: Entry, sub: string[]) => {
      for (const c of e.children) {
        const ce = idx.entries.get(c)!;
        if (!ce.folder) {
          if (sel.has(c)) u.ids.push({ id: c, sub });
        } else if (split) groupOf(ce, `${name} / ${ce.title}`);
        else walk(ce, [...sub, ce.title]);
      }
    };
    walk(folder, []);
  };
  for (const r of idx.roots) {
    const e = idx.entries.get(r)!;
    if (!e.folder) {
      if (sel.has(r)) looseTop.ids.push({ id: r, sub: [] });
      if (!units.includes(looseTop)) units.push(looseTop);
      continue;
    }
    if (!e.node.role) {
      groupOf(e, e.title);
      continue;
    }
    const loose: Raw = { key: `loose:${r}`, kind: LOOSE_AS_LINKS.has(e.node.role) ? "links" : "group", name: e.title, ids: [] };
    units.push(loose);
    for (const c of e.children) {
      const ce = idx.entries.get(c)!;
      if (!ce.folder) {
        if (sel.has(c)) loose.ids.push({ id: c, sub: [] });
      } else groupOf(ce, ce.title);
    }
  }
  return units
    .filter((u) => u.ids.length > 0)
    .map((u) => ({
      key: u.key,
      kind: u.kind,
      name: u.name,
      items: u.ids.map(({ id, sub }) => {
        const n = idx.entries.get(id)!.node;
        const url = n.url ?? "";
        return { name: n.title || url, url, icon: bookmarkIcon(url), sub };
      }),
    }));
}

/** The name in a group: with the subfolders before it („Unterordner / Titel“). */
export const itemName = (i: PlanItem) => [...i.sub, i.name].join(" / ");

/** What the import does with `existing` (the current ribbon). */
export function planImport(idx: TreeIndex, sel: ReadonlySet<string>, existing: QuickLink[], opts: PlanOptions): Plan {
  const links: QuickLink[] = existing.map((l) => (isGroup(l) ? { ...l, items: [...(l.items ?? [])] } : l));
  const inRibbon = ribbonUrls(existing);
  const taken = new Set<string>();
  let slots = MAX_RIBBON - existing.length;
  const plan: Plan = { units: [], links, pages: [], newEntries: 0, newLinks: 0, duplicates: 0, dropped: 0, overflow: 0 };
  for (const raw of unitsOf(idx, sel, opts.split, opts.topName)) {
    // Twice in the selection: once is enough.
    let duplicates = 0;
    const items = raw.items.filter((i) => {
      const k = urlKey(i.url);
      if (taken.has(k)) return (duplicates++, false);
      taken.add(k);
      return true;
    });
    const dest: Dest = opts.dest[raw.key] ?? "ribbon";
    const u: Unit = { ...raw, items, dest, merge: null, inRibbon: 0, toPage: 0, dropped: 0, duplicates, over: false };
    let rest: PlanItem[] = [];
    if (dest === "page") rest = items;
    else {
      // Already in the ribbon: skipped (a page lists them anyway).
      const fresh = items.filter((i) => {
        if (!inRibbon.has(urlKey(i.url))) return true;
        u.duplicates++;
        return false;
      });
      const toLink = (i: PlanItem): QuickLink => ({ name: u.kind === "group" ? itemName(i) : i.name, url: i.url, icon: i.icon });
      if (u.kind === "links") {
        const fit = Math.max(0, Math.min(fresh.length, slots));
        fresh.slice(0, fit).forEach((i) => links.push(toLink(i)));
        slots -= fit;
        u.inRibbon = fit;
        plan.newEntries += fit;
        rest = fresh.slice(fit);
      } else {
        const lower = u.name.trim().toLowerCase();
        // A group of that name (already there, or made by this import) takes the links.
        const at = links.findIndex((l) => isGroup(l) && l.name.trim().toLowerCase() === lower);
        let group: QuickLink | null = null;
        if (at >= 0) {
          if (at < existing.length) u.merge = at;
          group = links[at];
        } else if (slots > 0 && fresh.length > 0) {
          group = { name: u.name, url: "", icon: "folder", kind: "group", items: [] };
          links.push(group);
          slots--;
          plan.newEntries++;
        }
        const room = group ? MAX_GROUP - (group.items?.length ?? 0) : 0;
        const fit = Math.max(0, Math.min(fresh.length, room));
        if (group) group.items = [...(group.items ?? []), ...fresh.slice(0, fit).map(toLink)];
        u.inRibbon = fit;
        rest = fresh.slice(fit);
      }
      plan.newLinks += u.inRibbon;
      u.over = rest.length > 0;
    }
    plan.duplicates += u.duplicates;
    if (rest.length && (dest === "page" || opts.overflow === "pages")) {
      u.toPage = rest.length;
      if (dest !== "page") plan.overflow += rest.length;
      plan.pages.push({ key: u.key, title: u.name, items: rest });
    } else {
      u.dropped = rest.length;
      plan.dropped += rest.length;
    }
    plan.units.push(u);
  }
  return plan;
}

/** Brackets and line breaks that would end a Markdown link text. */
const mdText = (s: string) => s.replace(/\s+/g, " ").replace(/([[\]\\])/g, "\\$1");
/** Characters that would end a Markdown link target. */
const mdUrl = (s: string) => s.trim().replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/</g, "%3C").replace(/>/g, "%3E");

/** The page of a folder: an intro line, its own links as a list, then each subfolder's under a heading. */
export function pageMarkdown(items: PlanItem[], intro: string): string {
  const sections = new Map<string, PlanItem[]>([["", []]]);
  for (const i of items) {
    const head = i.sub.join(" / ");
    sections.set(head, [...(sections.get(head) ?? []), i]);
  }
  const out: string[] = [intro];
  for (const [head, list] of sections) {
    if (!list.length) continue;
    if (head) out.push(`## ${head}`);
    out.push(list.map((i) => `- [${mdText(i.name)}](${mdUrl(i.url)})`).join("\n"));
  }
  return `${out.join("\n\n")}\n`;
}
