// Page embeds and rich code blocks, the parts without DOM: `![[Seite]]`, `![[Seite#Überschrift]]`
// and `![[Seite#^block]]` (Obsidian syntax; files keep their own embeds, see fileEmbed.ts), the
// cycle and depth rules of nested embeds, the headings and block ids a `![[` autocomplete offers,
// and which fenced blocks render (```mermaid, ```query).

import { fileExtension } from "./fileEmbed";

/** Embeds inside embeds go this deep; the next level shows a notice instead. */
export const MAX_EMBED_DEPTH = 3;

export interface EmbedRef {
  target: string;
  /** `Überschrift` or `^block` (without the `#`), null for the whole page. */
  anchor: string | null;
  alt: string | null;
}

const EMBED_RE = /^!\[\[([^\]|#\n]+?)(?:#([^\]|\n]*))?(?:\|([^\]\n]*))?\]\]/;

/** Whether `![[name]]` embeds a page: names with a file extension embed the file. */
export const isPageEmbedName = (name: string) => !!name.trim() && fileExtension(name.trim()) == null;

/** The page embed at the start of `src` (with its raw text), or null (a file embed, no embed). */
export function parsePageEmbed(src: string): (EmbedRef & { raw: string }) | null {
  const m = EMBED_RE.exec(src);
  if (!m || !isPageEmbedName(m[1])) return null;
  const anchor = m[2]?.trim() || null;
  return { raw: m[0], target: m[1].trim(), anchor, alt: m[3] ?? null };
}

/** The embed as Markdown (a table cell escapes the alias pipe). */
export const pageEmbedMarkdown = (r: Partial<EmbedRef>, inCell = false) =>
  `![[${r.target ?? ""}${r.anchor ? "#" + r.anchor : ""}${r.alt != null ? (inCell ? "\\|" : "|") + r.alt : ""}]]`;

/** `Seite › Überschrift` (a block id shows as it is written). */
export const embedLabel = (r: Pick<EmbedRef, "target" | "anchor">) => (r.anchor ? `${r.target} › ${r.anchor}` : r.target);

/** Splits `Seite#Abschnitt` as typed in the autocomplete. */
export function splitTarget(q: string): { target: string; anchor: string | null } {
  const i = q.indexOf("#");
  return i < 0 ? { target: q.trim(), anchor: null } : { target: q.slice(0, i).trim(), anchor: q.slice(i + 1).trim() };
}

/**
 * Why a nested embed is not shown: `cycle` when its page is one of the pages around it (`stack`,
 * lower-cased titles from the open page inwards), `depth` beyond MAX_EMBED_DEPTH (`depth` is the
 * embed's own level, 1 in the page itself).
 */
export function embedProblem(stack: readonly string[], depth: number, target: string): "cycle" | "depth" | null {
  if (stack.includes(target.trim().toLowerCase())) return "cycle";
  if (depth > MAX_EMBED_DEPTH) return "depth";
  return null;
}

/** Lines outside fenced code, with their index. */
function proseLines(md: string): [string, number][] {
  const out: [string, number][] = [];
  let fence: string | null = null;
  md.split("\n").forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) fence = null;
      return;
    }
    if (m) {
      fence = m[1];
      return;
    }
    out.push([line, i]);
  });
  return out;
}

/** The ATX headings of a page (not in code), for `![[Seite#` completion. */
export function markdownHeadings(md: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const [line] of proseLines(md)) {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/\s+\^[A-Za-z0-9-]+$/, "").trim() });
  }
  return out.filter((h) => h.text);
}

/** The block ids (`^abc` at a line end or alone on a line) of a page, for `![[Seite#^` completion. */
export function blockIds(md: string): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const lines = proseLines(md);
  lines.forEach(([line], k) => {
    const m = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
    if (!m) return;
    let text = line.slice(0, m.index).trim();
    // `^id` alone: the text of the line above.
    if (!text) for (let j = k - 1; j >= 0 && !text; j--) text = lines[j][0].trim();
    out.push({ id: m[1], text: text.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?|^#+\s+|^>\s?/, "") });
  });
  return out;
}

/** The kinds of fenced blocks that render instead of showing code. */
export type RichKind = "mermaid" | "query";

/** The rich kind of a code block's language (`mermaid`, `query`; also `abfrage`). */
export function richKind(language: string | null | undefined): RichKind | null {
  const l = (language ?? "").trim().toLowerCase();
  if (l === "mermaid") return "mermaid";
  if (l === "query" || l === "abfrage") return "query";
  return null;
}

/** Fenced ```mermaid blocks in Markdown (outside other code): what loads the diagram library. */
export function countRichBlocks(md: string): Record<RichKind, number> {
  const out: Record<RichKind, number> = { mermaid: 0, query: 0 };
  let fence: string | null = null;
  for (const line of md.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2]) fence = null;
      continue;
    }
    if (!m) continue;
    fence = m[1];
    const k = richKind(m[2]);
    if (k) out[k]++;
  }
  return out;
}

/** The diagram type of Mermaid source: its first word (after front matter and comments). */
export function mermaidKind(src: string): string | null {
  let body = src.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "");
  body = body
    .split("\n")
    .filter((l) => !/^\s*%%/.test(l))
    .join("\n");
  const m = /^\s*([A-Za-z][\w-]*)/.exec(body);
  return m ? m[1] : null;
}
