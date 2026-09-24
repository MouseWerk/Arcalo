// Presentation mode: a note split into slides, speaker notes, and the Markdown prepared for
// the slide renderer.
//
// Slides are separated by horizontal rules (`---`, `***`, `___`) outside code blocks. A `---`
// directly below a line of text is a setext heading in Markdown, not a rule, so it only splits
// after a blank line, a heading or at the start. A note without rules is split before each
// level-1 heading (`# …`); without those it is one slide.
//
// Speaker notes: a callout `> [!notiz]` (also `[!notes]`, `[!speaker]`, `[!sprecher]`) with all its
// `>` lines, or a paragraph starting with `Notiz:`. They are hidden on the slide and shown in
// the presenter view. Both are plain Markdown, so the note reads normally outside the
// presentation.

import { FIRST_LINE_RE } from "./frontmatter";

export interface Slide {
  index: number;
  /** Markdown shown on the slide (notes removed). */
  markdown: string;
  /** Speaker notes (Markdown); "" without. */
  notes: string;
  /** First heading or first line, for the presenter view and the jump list. */
  title: string;
}

const RULE_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/;
const NOTE_CALLOUT_RE = /^ {0,3}>[ \t]?\[!(notiz|notizen|notes?|speaker|sprecher)\][+-]?[ \t]*(.*)$/i;
const NOTE_LINE_RE = /^ {0,3}(?:notiz|sprechernotiz|notes?):[ \t]*(.*)$/i;

/** The body of a note without its YAML frontmatter. */
export function stripFrontmatter(md: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (!m || !FIRST_LINE_RE.test(m[1].split(/\r?\n/)[0])) return md;
  return md.slice(m[0].length);
}

/** Tracks fenced code blocks line by line: true while inside one (the fence lines included). */
function fenceTracker() {
  let open: { ch: string; len: number } | null = null;
  return (line: string): boolean => {
    const m = FENCE_RE.exec(line);
    if (open) {
      // A closing fence: the same character, at least as long, nothing after it.
      if (m && m[1][0] === open.ch && m[1].length >= open.len && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line)) open = null;
      return true;
    }
    if (m) {
      open = { ch: m[1][0], len: m[1].length };
      return true;
    }
    return false;
  };
}

/** Line indexes where a slide ends (horizontal rules outside code; `---` under text is a heading). */
function ruleLines(lines: string[]): number[] {
  const inFence = fenceTracker();
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (inFence(line)) return;
    if (!RULE_RE.test(line)) return;
    const prev = i > 0 ? lines[i - 1] : "";
    const afterText = prev.trim() !== "" && !HEADING_RE.test(prev) && !RULE_RE.test(prev);
    // `***` and `___` are never setext underlines; `---` (or `- - -`) under text is.
    if (afterText && line.trim().startsWith("-")) return;
    out.push(i);
  });
  return out;
}

/** Line indexes of level-1 headings outside code (the fallback split). */
function h1Lines(lines: string[]): number[] {
  const inFence = fenceTracker();
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (!inFence(line) && /^ {0,3}#[ \t]+\S/.test(line)) out.push(i);
  });
  return out;
}

/** Separates the speaker notes from a slide's Markdown. */
export function extractNotes(md: string): { markdown: string; notes: string } {
  const lines = md.split("\n");
  const keep: string[] = [];
  const notes: string[] = [];
  const inFence = fenceTracker();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFence(line)) {
      keep.push(line);
      continue;
    }
    const callout = NOTE_CALLOUT_RE.exec(line);
    if (callout) {
      const block: string[] = [];
      if (callout[2].trim()) block.push(callout[2].trim());
      while (i + 1 < lines.length && /^ {0,3}>/.test(lines[i + 1])) {
        i++;
        block.push(lines[i].replace(/^ {0,3}>[ \t]?/, ""));
      }
      notes.push(block.join("\n").trim());
      continue;
    }
    const prev = keep.length ? keep[keep.length - 1] : "";
    const para = NOTE_LINE_RE.exec(line);
    // Only at the start of a paragraph (not in the middle of a sentence, a list or a quote).
    if (para && prev.trim() === "") {
      const block: string[] = [para[1]];
      while (i + 1 < lines.length && lines[i + 1].trim() !== "") {
        i++;
        block.push(lines[i]);
      }
      notes.push(block.join("\n").trim());
      continue;
    }
    keep.push(line);
  }
  return { markdown: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), notes: notes.filter(Boolean).join("\n\n") };
}

/** Title of a slide: its first heading, else its first line of text. */
function slideTitle(md: string, n: number): string {
  const lines = md.split("\n");
  const inFence = fenceTracker();
  for (const l of lines) {
    if (inFence(l)) continue;
    const h = HEADING_RE.exec(l);
    if (h && h[2].trim()) return plain(h[2]);
  }
  const first = lines.find((l) => l.trim() && !/^ {0,3}(```|~~~|!\[\[|\|)/.test(l));
  const text = first ? plain(first.replace(/^ {0,3}([-*+>]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")) : "";
  return text ? (text.length > 60 ? `${text.slice(0, 59)}…` : text) : `Folie ${n}`;
}

const plain = (s: string) =>
  s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~=]+/g, "")
    .trim();

/** Splits a note (with or without frontmatter) into slides. */
export function splitSlides(content: string): Slide[] {
  const lines = stripFrontmatter(content.replace(/\r\n?/g, "\n")).split("\n");
  const rules = ruleLines(lines);
  const chunks: string[] = [];
  if (rules.length) {
    let start = 0;
    for (const r of rules) {
      chunks.push(lines.slice(start, r).join("\n"));
      start = r + 1;
    }
    chunks.push(lines.slice(start).join("\n"));
  } else {
    const heads = h1Lines(lines).filter((i) => lines.slice(0, i).some((l) => l.trim()));
    let start = 0;
    for (const h of heads) {
      chunks.push(lines.slice(start, h).join("\n"));
      start = h;
    }
    chunks.push(lines.slice(start).join("\n"));
  }
  const slides: Slide[] = [];
  for (const chunk of chunks) {
    const { markdown, notes } = extractNotes(chunk);
    if (!markdown && !notes) continue;
    const n = slides.length + 1;
    slides.push({ index: slides.length, markdown, notes, title: slideTitle(markdown, n) });
  }
  return slides;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Markdown for the slide renderer: `![[name|300]]` embeds become placeholders the slide fills
 * (images, drawings, PDF cards, files), booked time (`<time-entry>`) its text. Code stays untouched.
 */
export function prepareSlideMarkdown(md: string): string {
  const lines = md.split("\n");
  const inFence = fenceTracker();
  return lines
    .map((line) => {
      if (inFence(line)) return line;
      return line
        .replace(/!\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, (_, name: string, opt?: string) => {
          const width = opt && /^\d+(x\d+)?$/.test(opt.trim()) ? ` data-width="${escapeAttr(opt.trim().split("x")[0])}"` : "";
          return `<span class="slide-embed" data-embed="${escapeAttr(name.trim())}"${width}></span>`;
        })
        .replace(/<time-entry\b([^>]*)>([^<]*)<\/time-entry>/g, (_, attrs: string, text: string) => {
          const hours = /\bhours="?([^"\s>]+)"?/.exec(attrs)?.[1];
          return `<span class="slide-zeit">${hours ? `${escapeAttr(hours)} h · ` : ""}${escapeAttr(text)}</span>`;
        });
    })
    .join("\n");
}

/** Slide number from typed digits (1-based) clamped to the deck; null for nothing typed. */
export function jumpTarget(typed: string, count: number): number | null {
  const n = parseInt(typed, 10);
  if (!typed || Number.isNaN(n) || count === 0) return null;
  return Math.min(Math.max(n, 1), count) - 1;
}

/** `mm:ss` or `h:mm:ss` for the presentation timer. */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (x: number) => String(x).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** The scale that fits content of `content` size into `box` without cutting it (never above 1). */
export function fitScale(content: { width: number; height: number }, box: { width: number; height: number }): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  return Math.min(1, box.width / content.width, box.height / content.height);
}
