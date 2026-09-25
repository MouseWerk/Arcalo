// Ribbon links and groups of links: pure operations on the saved list (the component saves the
// result through `quick_links_save`). A place is `{ group, index }`: `group` is the index of a
// group in the ribbon, or null for the ribbon itself.

import type { QuickLink } from "./types";

export type LinkKind = "link" | "app" | "group";
export interface Loc {
  group: number | null;
  index: number;
}

/** Group colors (the option colors of collections, same order and names). */
export const LINK_COLORS: { id: string; label: string; hex: string }[] = [
  { id: "grau", label: "Grau", hex: "#9ca3af" },
  { id: "braun", label: "Braun", hex: "#b0845c" },
  { id: "orange", label: "Orange", hex: "#f97316" },
  { id: "gelb", label: "Gelb", hex: "#eab308" },
  { id: "grün", label: "Grün", hex: "#22c55e" },
  { id: "blau", label: "Blau", hex: "#3b82f6" },
  { id: "lila", label: "Lila", hex: "#a855f7" },
  { id: "rosa", label: "Rosa", hex: "#ec4899" },
  { id: "rot", label: "Rot", hex: "#ef4444" },
];
export const colorHex = (id: string | undefined) => LINK_COLORS.find((c) => c.id === id)?.hex;

/** Above this many links, „Alle öffnen“ asks first. */
export const OPEN_ALL_CONFIRM = 5;
/** Above this many entries the group's list gets a filter field. */
export const FILTER_FROM = 8;

export const kindOf = (l: QuickLink): LinkKind => (l.kind === "app" || l.kind === "group" ? l.kind : "link");
export const isGroup = (l: QuickLink | undefined) => !!l && kindOf(l) === "group";

/** Whether the address is a local folder or file (the shell decides for real when opening). */
export const isPath = (u: string) => /^(file:|[A-Za-z]:[\\/]|\\\\|\/|~\/)/i.test(u.trim());

/**
 * Settings of any age in today's shape: links without a kind are links, groups have a list,
 * groups inside groups (only by hand) hand their links to the outer one.
 */
export function normalizeLinks(raw: QuickLink[] | null | undefined): QuickLink[] {
  return (raw ?? []).map((l) => {
    if (kindOf(l) !== "group") return plain(l);
    const items = (l.items ?? []).flatMap((i) => (isGroup(i) ? (i.items ?? []) : [i])).filter((i) => !isGroup(i)).map(plain);
    return { name: l.name, url: "", icon: l.icon ?? "", kind: "group", ...(l.color ? { color: l.color } : {}), items };
  });
}

/** A link or program without group fields (links keep the 1.4 shape: no `kind`). */
function plain(l: QuickLink): QuickLink {
  const out: QuickLink = { name: l.name ?? "", url: l.url ?? "", icon: l.icon ?? "" };
  if (kindOf(l) === "app") out.kind = "app";
  return out;
}

export function newGroup(name: string, icon = "folder", color = ""): QuickLink {
  return { name, url: "", icon, kind: "group", ...(color ? { color } : {}), items: [] };
}

export function itemAt(links: QuickLink[], at: Loc): QuickLink | undefined {
  return at.group === null ? links[at.index] : links[at.group]?.items?.[at.index];
}

/** The list a place is in (a copy of the ribbon is returned for `null`). */
const listOf = (links: QuickLink[], group: number | null) => (group === null ? links : (links[group]?.items ?? []));

/** Replaces the list of `group` (or the ribbon) in a copy of `links`. */
function withList(links: QuickLink[], group: number | null, list: QuickLink[]): QuickLink[] {
  if (group === null) return list;
  return links.map((l, i) => (i === group ? { ...l, items: list } : l));
}

/** Adds `item` at the end of `group` (or the ribbon), or at `index`. Groups do not go into groups. */
export function insertItem(links: QuickLink[], item: QuickLink, group: number | null, index?: number): QuickLink[] {
  if (group !== null && (isGroup(item) || !isGroup(links[group]))) return links;
  const list = [...listOf(links, group)];
  list.splice(index ?? list.length, 0, item);
  return withList(links, group, list);
}

export function updateItem(links: QuickLink[], at: Loc, item: QuickLink): QuickLink[] {
  const list = [...listOf(links, at.group)];
  if (!list[at.index]) return links;
  list[at.index] = item;
  return withList(links, at.group, list);
}

export function removeItem(links: QuickLink[], at: Loc): QuickLink[] {
  const list = listOf(links, at.group).filter((_, i) => i !== at.index);
  return withList(links, at.group, list);
}

/**
 * Moves the entry at `from` to `to` (`to.index` counts in the target list as it is before the
 * move; the end of the list is `length`). A group can only move within the ribbon; moving an
 * entry out of the ribbon shifts the groups after it, which is accounted for.
 */
export function moveItem(links: QuickLink[], from: Loc, to: Loc): QuickLink[] {
  const item = itemAt(links, from);
  if (!item) return links;
  if (to.group !== null && (isGroup(item) || !isGroup(links[to.group]))) return links;
  if (from.group === to.group) {
    const list = [...listOf(links, from.group)];
    list.splice(from.index, 1);
    const at = to.index > from.index ? to.index - 1 : to.index;
    list.splice(Math.max(0, Math.min(at, list.length)), 0, item);
    return withList(links, from.group, list);
  }
  // Across lists: find the target group again by identity after the removal.
  const target = to.group === null ? null : links[to.group];
  const without = removeItem(links, from);
  const group = target === null ? null : without.findIndex((l) => l === target);
  if (group === -1) return links;
  const list = listOf(without, group);
  // An entry leaving the ribbon before the insertion point shifts it.
  const index = to.group === null && from.group === null && from.index < to.index ? to.index - 1 : to.index;
  return insertItem(without, item, group, Math.max(0, Math.min(index, list.length)));
}

/** The groups as choices („In Gruppe“): index in the ribbon and name. */
export function groupChoices(links: QuickLink[]): { index: number; name: string }[] {
  return links.flatMap((l, index) => (isGroup(l) ? [{ index, name: l.name }] : []));
}

/** Entries whose name or address contains every word of `q` (case-insensitive), with their index. */
export function filterItems(items: QuickLink[], q: string): { item: QuickLink; index: number }[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const hay = `${item.name} ${item.url}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
}

/** Every link and program with its place and group name (command palette). */
export function flatLinks(links: QuickLink[]): { item: QuickLink; at: Loc; group: string | null }[] {
  return links.flatMap((l, i): { item: QuickLink; at: Loc; group: string | null }[] =>
    isGroup(l) ? (l.items ?? []).map((item, j) => ({ item, at: { group: i, index: j }, group: l.name })) : [{ item: l, at: { group: null, index: i }, group: null }],
  );
}

/** Web links of a group (what „Alle öffnen“ opens; programs and folders are left out). */
export function webItems(group: QuickLink): number[] {
  return (group.items ?? []).flatMap((l, i) => (kindOf(l) === "link" && !isPath(l.url) ? [i] : []));
}

/** Short form of an address for the second line: no scheme, no trailing slash. */
export function shortUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}
