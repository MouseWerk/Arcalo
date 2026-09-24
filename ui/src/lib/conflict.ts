// The conflict view's result: the block merge from the shell (`merge::merge3`) plus the
// user's choice per conflict – this computer's blocks („Meine“), the server's („Andere“),
// both one after the other („Beide“), or an edited text.

import type { MergeChunk } from "./types";

export type Choice = { kind: "mine" | "theirs" | "both" } | { kind: "edit"; text: string };

/** `a` then `b`, on separate lines. */
export function joinBlocks(a: string, b: string): string {
  if (!a || !b) return a + b;
  return a.endsWith("\n") ? a + b : `${a}\n${b}`;
}

/** The text a choice gives for a conflict. */
export function choiceText(c: Extract<MergeChunk, { kind: "conflict" }>, choice: Choice): string {
  switch (choice.kind) {
    case "mine":
      return c.mine;
    case "theirs":
      return c.theirs;
    case "both":
      return joinBlocks(c.mine, c.theirs);
    case "edit": {
      // The edited block keeps the separation the versions had (a blank line after a
      // paragraph), so it does not run into the next block.
      const text = choice.text.replace(/\s+$/, "");
      if (!text) return "";
      const blank = /\n\s*\n$/.test(c.mine) || /\n\s*\n$/.test(c.theirs);
      return text + (blank ? "\n\n" : "\n");
    }
  }
}

/** Indexes (into `chunks`) of the conflicts, in order. */
export const conflictIndexes = (chunks: MergeChunk[]) => chunks.flatMap((c, i) => (c.kind === "conflict" ? [i] : []));

/** The merged note, or null while a conflict is undecided. `choices` by chunk index. */
export function buildResult(chunks: MergeChunk[], choices: Map<number, Choice>): string | null {
  let out = "";
  for (const [i, c] of chunks.entries()) {
    const choice = choices.get(i);
    if (c.kind === "conflict" && !choice) return null;
    // An edited block without its final line break must not glue itself to the next block.
    out = joinBlocks(out, c.kind === "conflict" ? choiceText(c, choice!) : c.text);
  }
  return out;
}

/** The same choice for every conflict. */
export function chooseAll(chunks: MergeChunk[], kind: "mine" | "theirs"): Map<number, Choice> {
  return new Map(conflictIndexes(chunks).map((i) => [i, { kind }]));
}
