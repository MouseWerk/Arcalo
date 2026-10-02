// Pure helpers of the link and tag suggestions, the duplicate hints and the PDF highlights
// (1.10): adding an accepted tag to the frontmatter, finding unlinked titles in editor text,
// reading a highlight link's anchor and turning a text selection into page-relative rects.

import { canonicalKey, edited, parseFrontmatter, serializeFrontmatter, type Property } from "./frontmatter";
import type { PdfRect } from "./types";

/** Adds `tag` to the `tags:` list of a frontmatter block (creates the list when there is none). */
export function addTagToFrontmatter(fm: string, tag: string): string {
  const clean = tag.replace(/^#/, "").trim();
  if (!clean) return fm;
  const props = parseFrontmatter(fm);
  const at = props.findIndex((p) => /^tags?$/i.test(canonicalKey(p.key)));
  if (at < 0) {
    const fresh: Property = { key: "tags", type: "list", value: "", items: [clean] };
    return serializeFrontmatter([...props, fresh]);
  }
  const p = props[at];
  const items = p.type === "list" ? p.items : p.value.split(/[,\s]+/).map((s) => s.replace(/^#/, "")).filter(Boolean);
  if (items.some((i) => i.toLowerCase() === clean.toLowerCase())) return fm;
  props[at] = edited(p, { type: "list", items: [...items, clean], value: "" });
  return serializeFrontmatter(props);
}

const WORD = /[\p{L}\p{N}_]/u;

export interface TextHit {
  from: number;
  to: number;
  title: string;
  text: string;
}

/**
 * Where the `terms` (the texts of unlinked mentions the core found, with their page titles)
 * occur in `text` at word boundaries, case-insensitively, longest first, without overlaps.
 * The editor's inline hints use it on each text block; the core decides what is a mention.
 */
export function findTerms(text: string, terms: { text: string; title: string }[]): TextHit[] {
  const lower = text.toLowerCase();
  const sorted = [...new Map(terms.map((t) => [t.text.toLowerCase(), t])).values()].sort((a, b) => b.text.length - a.text.length);
  const taken: TextHit[] = [];
  for (const term of sorted) {
    const needle = term.text.toLowerCase();
    if (!needle) continue;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      const end = at + needle.length;
      const before = at > 0 ? text[at - 1] : "";
      const after = end < text.length ? text[end] : "";
      if (!WORD.test(before) && !WORD.test(after) && !taken.some((h) => at < h.to && end > h.from)) {
        taken.push({ from: at, to: end, title: term.title, text: text.slice(at, end) });
      }
      at = lower.indexOf(needle, end);
    }
  }
  return taken.sort((a, b) => a.from - b.from);
}

/** `[[Title]]` for a mention written like the title, else `[[Title|text]]`. */
export function linkFor(title: string, text: string): { target: string; alias: string | null } {
  return { target: title, alias: text === title ? null : text };
}

/** The page and highlight of a PDF link anchor (`page=12&hl=7`). */
export function pdfAnchor(anchor: string | null | undefined): { page: number | null; highlight: number | null } {
  const a = (anchor ?? "").replace(/^#/, "");
  const page = /(?:^|&)page=(\d+)/.exec(a);
  const hl = /(?:^|&)hl=(\d+)/.exec(a);
  return { page: page ? Math.max(1, Number(page[1])) : null, highlight: hl ? Number(hl[1]) : null };
}

type Box = { left: number; top: number; width: number; height: number };

/**
 * The selection's client rects relative to its page box, as fractions of the page: rects on
 * one line are merged, tiny ones (line ends) dropped, so a highlight is one bar per line.
 */
export function pageRects(rects: Box[], page: Box): PdfRect[] {
  const lines: Box[] = [];
  for (const r of [...rects].filter((r) => r.width > 1 && r.height > 1).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines.find((l) => Math.abs(l.top + l.height / 2 - (r.top + r.height / 2)) < Math.min(l.height, r.height) / 2);
    if (line) {
      const right = Math.max(line.left + line.width, r.left + r.width);
      const bottom = Math.max(line.top + line.height, r.top + r.height);
      line.left = Math.min(line.left, r.left);
      line.top = Math.min(line.top, r.top);
      line.width = right - line.left;
      line.height = bottom - line.top;
    } else lines.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const round = (v: number) => Math.round(v * 10000) / 10000;
  return lines.map((l) => [
    round(clamp((l.left - page.left) / page.width)),
    round(clamp((l.top - page.top) / page.height)),
    round(Math.min(l.width / page.width, 1)),
    round(Math.min(l.height / page.height, 1)),
  ]);
}

/** Highlight colors in the order of the color picker (as the core accepts them). */
export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
