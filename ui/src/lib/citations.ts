// Citations in assistant answers: `[n]` markers become chips that point at the n-th
// retrieved source, and a chunk's Markdown yields the text to find it again in the editor.

const SKIP_TAGS = new Set(["code", "pre", "a", "sup"]);

/**
 * Turns `[n]` (1 ≤ n ≤ count) in the text of rendered HTML into citation chips
 * `<sup class="cite" data-cite="n">n</sup>`. Code, links and existing chips stay untouched;
 * `[1, 2]` and `[1][2]` become one chip per number.
 */
export function linkCitations(html: string, count: number): string {
  if (count <= 0) return html;
  const chip = (n: number) => `<sup class="cite" data-cite="${n}" role="button" tabindex="0" aria-label="Quelle ${n}">${n}</sup>`;
  let depth = 0;
  return html
    .split(/(<[^>]*>)/)
    .map((part) => {
      const tag = /^<(\/)?([a-zA-Z][\w-]*)/.exec(part);
      if (tag) {
        if (SKIP_TAGS.has(tag[2].toLowerCase()) && !part.endsWith("/>")) depth += tag[1] ? -1 : 1;
        depth = Math.max(0, depth);
        return part;
      }
      if (depth > 0 || !part.includes("[")) return part;
      return part.replace(/\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g, (m, list: string) => {
        const nums = list.split(/[,;]/).map((x) => Number(x.trim()));
        if (!nums.every((n) => Number.isInteger(n) && n >= 1 && n <= count)) return m;
        return nums.map(chip).join("");
      });
    })
    .join("");
}

/** The numbers cited in an answer, in order of first appearance. */
export function citedNumbers(text: string, count: number): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g))
    for (const x of m[1].split(/[,;]/)) {
      const n = Number(x.trim());
      if (n >= 1 && n <= count && !out.includes(n)) out.push(n);
    }
  return out;
}

/** Inline Markdown as the editor shows it: link labels, no emphasis markers, no chips. */
export function plainInline(md: string): string {
  return md
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|#\n]+)(?:#([^\]|\n]*))?(?:\|([^\]\n]+))?\]\]/g, (_m, t: string, a?: string, alias?: string) => alias ?? (a ? `${t} › ${a}` : t))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<time-entry[^>]*>[^<]*<\/time-entry>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/(\*\*|__|~~|==|`)/g, "")
    .replace(/(^|[\s(])[*_](?=\S)/g, "$1")
    .replace(/(\S)[*_](?=$|[\s).,;:!?])/g, "$1")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts text after `max` characters at a word boundary. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const i = s.lastIndexOf(" ", max);
  return s.slice(0, i > max / 2 ? i : max);
}

/**
 * Texts to look for, best first, to find a chunk in its page: the first sentence of its
 * first paragraph, the start of that paragraph, then its heading.
 */
export function citeNeedles(chunk: string): string[] {
  const body = chunk.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "");
  let heading = "";
  let para = "";
  let fence = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence || !line || /^\|?[\s:|-]+\|?$/.test(line) || /^(-{3,}|\*{3,})$/.test(line)) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (h) {
      if (!heading) heading = plainInline(h[1]);
      continue;
    }
    // A table row: its first cell.
    const row = line.startsWith("|") ? line.slice(1).split("|")[0] : line;
    const text = plainInline(
      row
        .replace(/^(>\s*)+/, "")
        .replace(/^\[![\w-]+\][+-]?\s*/, "")
        .replace(/^([-*+]|\d+[.)])\s+/, "")
        .replace(/^\[[ xX]\]\s+/, ""),
    );
    if (text.length >= 3) {
      para = text;
      break;
    }
  }
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim();
    if (t.length >= 3 && !out.includes(t)) out.push(t);
  };
  if (para) {
    const sentence = /^.{12,}?[.!?](?=\s|$)/.exec(para)?.[0] ?? para;
    add(cut(sentence, 90));
    add(cut(para.split(" ").slice(0, 5).join(" "), 60));
  }
  add(heading);
  return out;
}
