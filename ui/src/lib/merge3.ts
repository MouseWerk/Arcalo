// Line-based three-way merge for two editors of the same page (two panes, visual and
// source): both sides' changes against the last common state are kept. Where both changed
// the same place, both versions stay (ours first); nothing typed is dropped.

import { lineDiff } from "./linediff";

interface Side {
  /** Base line i is kept. */
  keep: boolean[];
  /** Lines inserted before base line i (index n: at the end). */
  ins: string[][];
}

function side(base: string[], other: string): Side {
  const keep = base.map(() => false);
  const ins: string[][] = Array.from({ length: base.length + 1 }, () => []);
  let i = 0;
  for (const d of lineDiff(base.join("\n"), other)) {
    if (d.kind === "same") keep[i++] = true;
    else if (d.kind === "del") i++;
    else ins[i].push(d.text);
  }
  return { keep, ins };
}

const lines = (t: string) => t.replace(/\n$/, "").split("\n");

/** `mine` and `theirs` both started from `base`: the text with both sides' changes. */
export function merge3(base: string, mine: string, theirs: string): string {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const b = lines(base);
  const m = side(b, mine);
  const t = side(b, theirs);
  const out: string[] = [];
  for (let i = 0; i <= b.length; i++) {
    const a = m.ins[i];
    const c = t.ins[i];
    if (a.join("\n") === c.join("\n")) out.push(...a);
    // Both inserted here: ours, then theirs.
    else out.push(...a, ...c);
    // A base line survives only when neither side removed (or changed) it.
    if (i < b.length && m.keep[i] && t.keep[i]) out.push(b[i]);
  }
  const text = out.join("\n");
  return mine.endsWith("\n") || theirs.endsWith("\n") ? `${text}\n` : text;
}
