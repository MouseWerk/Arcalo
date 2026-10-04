// The attachment manager's list logic: filter, search, sort and the rename check. The shell
// checks names again (attachment_manager::check_new_name); this only gives early feedback.

import { fileExtension } from "../editor/fileEmbed";
import type { AttachmentInfo, AttachmentKind } from "./types";
import { t } from "./i18n";

export type KindFilter = "all" | AttachmentKind;
export type SortKey = "name" | "size" | "date" | "usage";

/** Files from this size on count as large. */
export const LARGE_BYTES = 5 * 1000 * 1000;

export interface ListFilter {
  query: string;
  kind: KindFilter;
  unused: boolean;
  large: boolean;
  sort: SortKey;
}

export const DEFAULT_FILTER: ListFilter = { query: "", kind: "all", unused: false, large: false, sort: "name" };

/**
 * Not embedded in any page (trashed pages included, deleting it could break a restore), in no
 * older version of a page and not a stored e-mail.
 */
export const isUnused = (f: AttachmentInfo) => f.used_in.length === 0 && !f.mail && !f.in_versions?.length;

/** Embedded only by older versions of pages: deleting it leaves a hole when such a version comes back. */
export const onlyInVersions = (f: AttachmentInfo) => f.used_in.length === 0 && !f.mail && !!f.in_versions?.length;

const collator = new Intl.Collator("de", { sensitivity: "base", numeric: true });

export function filterAttachments(files: AttachmentInfo[], f: ListFilter): AttachmentInfo[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out = files.filter(
    (x) =>
      (f.kind === "all" || x.kind === f.kind) &&
      (!f.unused || isUnused(x)) &&
      (!f.large || x.size >= LARGE_BYTES) &&
      words.every((w) => x.name.toLowerCase().includes(w) || x.used_in.some((u) => u.title.toLowerCase().includes(w))),
  );
  const time = (x: AttachmentInfo) => (x.modified ? Date.parse(x.modified) : 0);
  const byName = (a: AttachmentInfo, b: AttachmentInfo) => collator.compare(a.name, b.name);
  const cmp: Record<SortKey, (a: AttachmentInfo, b: AttachmentInfo) => number> = {
    name: byName,
    size: (a, b) => b.size - a.size || byName(a, b),
    date: (a, b) => time(b) - time(a) || byName(a, b),
    usage: (a, b) => b.used_in.length - a.used_in.length || byName(a, b),
  };
  return out.sort(cmp[f.sort]);
}

export const totalSize = (files: AttachmentInfo[]) => files.reduce((n, f) => n + f.size, 0);

const RESERVED = /[\\/:*?"<>|[\]#^\u0000-\u001f]/;
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/**
 * Why `next` cannot replace `old` in `names` (the folder's files), or null. Same rules as the
 * shell: no folders or reserved characters, no leading dot, same extension (drawings keep
 * `.excalidraw`), not taken by another file (case-insensitive, like Windows).
 */
export function renameProblem(old: string, next: string, names: string[]): string | null {
  const name = next.trim();
  if (!name) return t("files.nameEmpty");
  if (name === old) return null;
  if (RESERVED.test(name)) return t("files.nameReserved");
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(" ")) return t("files.nameDot");
  if (DEVICE.test(name)) return t("files.nameWindows");
  const drawing = /\.excalidraw$/i.test(old);
  const oldExt = fileExtension(old);
  if (drawing ? !/\.excalidraw$/i.test(name) : fileExtension(name) !== oldExt) return t("files.nameExtension", { ext: drawing ? ".excalidraw" : `.${oldExt}` });
  if (new TextEncoder().encode(name).length > 150) return t("files.nameLong");
  const lower = name.toLowerCase();
  if (names.some((n) => n !== old && (n.toLowerCase() === lower || (drawing && n.toLowerCase() === `${lower}.svg`)))) return t("files.nameExists", { name });
  return null;
}

/** The part of a file name before its extension (selected when renaming). */
export function stemLength(name: string): number {
  if (/\.excalidraw$/i.test(name)) return name.length - ".excalidraw".length;
  const i = name.lastIndexOf(".");
  return i > 0 ? i : name.length;
}
