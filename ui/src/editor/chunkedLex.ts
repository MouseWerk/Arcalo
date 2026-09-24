// Lexing long notes in pieces.
//
// marked's block lexer tries its rules (and the start() of every block extension) on the whole
// rest of the note after each block, which makes a note of a few thousand lines take many
// seconds. The note is cut into pieces of about 40 lines at blank lines where nothing can
// continue across the cut, and the pieces are lexed one after another into the same token list
// with the same lexer: reference definitions, the inline pass (which runs after all blocks) and
// every "previous token" check see exactly what they would see for the whole note, so the
// tokens are identical (see chunkedLex.test.ts).

import type { Lexer, Token, TokensList } from "marked";
import { COLUMNS_CLOSE, COLUMNS_OPEN } from "./blocks";

/** Lines per piece before the next possible cut. */
export const CHUNK_LINES = 40;

// A code fence as marked reads it: backticks (no backtick in the info string) or tildes.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})/;
/** Whether `line` closes the fence opened by `fence`, as marked decides it. */
const closesFence = (fence: string, line: string) => new RegExp(`^ {0,3}${fence}[~\`]* *$`).test(line);
// Raw HTML blocks that do not end at a blank line (CommonMark types 1 to 5) and their ends.
const HTML_OPEN: [RegExp, RegExp][] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];
// Lines after a blank line that may still belong to what came before: indented continuations,
// list items (bullets, numbers, letters, roman numerals) and footnote definitions.
const CONTINUES = /^(?:[ \t]|[-+*](?:[ \t]|$)|[A-Za-z0-9]+[.)](?:[ \t]|$)|\[\^)/;

/**
 * Offsets at which `md` may be cut: the start of a line after a blank line, outside code
 * fences, raw HTML blocks, column blocks and frontmatter, that cannot continue a list, quote,
 * footnote or indented block. At most one cut per `every` lines.
 */
export function chunkCuts(md: string, every = CHUNK_LINES): number[] {
  const cuts: number[] = [];
  let fence: string | null = null;
  let html: RegExp | null = null;
  let columns = 0;
  let frontmatter = md.startsWith("---\n");
  let prevBlank = false;
  let lines = 0;
  let at = 0;
  let first = true;
  while (at < md.length) {
    const nl = md.indexOf("\n", at);
    const end = nl < 0 ? md.length : nl;
    const line = md.slice(at, end);
    const blank = /^[ \t]*$/.test(line);
    if (lines >= every && prevBlank && !blank && !fence && !html && !columns && !frontmatter && !CONTINUES.test(line)) {
      cuts.push(at);
      lines = 0;
    }
    lines++;
    if (frontmatter) {
      if (!first && line === "---") frontmatter = false;
    } else if (fence) {
      if (closesFence(fence, line)) fence = null;
    } else if (html) {
      if (html.test(line)) html = null;
    } else {
      const f = FENCE_OPEN.exec(line);
      if (f) fence = f[1];
      else {
        const t = line.trim();
        if (t === COLUMNS_OPEN) columns++;
        else if (t === COLUMNS_CLOSE) columns = Math.max(0, columns - 1);
        for (const [open, close] of HTML_OPEN) {
          const m = open.exec(line);
          if (m) {
            if (!close.test(line.slice(m[0].length))) html = close;
            break;
          }
        }
      }
    }
    prevBlank = blank;
    first = false;
    at = end + 1;
  }
  return cuts;
}

/** A fenced code block or raw HTML block that the end of its piece cut short. */
function cutShort(token: Token): boolean {
  if (token.type === "code") {
    const f = FENCE_OPEN.exec(token.raw);
    if (!f) return false;
    const lines = token.raw.replace(/\n+$/, "").split("\n");
    return lines.length < 2 || !closesFence(f[1], lines[lines.length - 1]);
  }
  if (token.type === "html") {
    for (const [open, close] of HTML_OPEN) {
      const m = open.exec(token.raw);
      if (m) return !close.test(token.raw.slice(m[0].length));
    }
  }
  return false;
}

interface LexerState {
  tokens: TokensList;
  inlineQueue: { src: string; tokens: Token[] }[];
}

/** Lexes `src` like `lexer.lex(src)`, one piece at a time (see above). */
export function chunkedLex(lexer: Lexer, src: string, every = CHUNK_LINES): TokensList {
  src = src.replace(/\r\n|\r/g, "\n");
  const lx = lexer as unknown as Lexer & LexerState;
  const tokens = lx.tokens;
  let start = 0;
  for (const cut of chunkCuts(src, every)) {
    const count = tokens.length;
    const queued = lx.inlineQueue.length;
    const links = new Set(Object.keys(tokens.links));
    lx.blockTokens(src.slice(start, cut), tokens);
    let last = tokens.length - 1;
    while (last >= count && tokens[last].type === "space") last--;
    // A column block without its end in this piece is read as a lone HTML comment.
    const lostColumns = tokens.slice(count).some((t) => t.type === "html" && t.raw.trim() === COLUMNS_OPEN);
    if (lostColumns || (last >= count && cutShort(tokens[last]))) {
      // A fence or HTML block went on behind the cut: lex this piece again together with the next.
      tokens.length = count;
      lx.inlineQueue.length = queued;
      for (const k of Object.keys(tokens.links)) if (!links.has(k)) delete tokens.links[k];
      continue;
    }
    start = cut;
  }
  lx.blockTokens(src.slice(start), tokens);
  for (let i = 0; i < lx.inlineQueue.length; i++) {
    const next = lx.inlineQueue[i];
    lx.inlineTokens(next.src, next.tokens);
  }
  lx.inlineQueue = [];
  return tokens;
}
