import { describe, expect, it } from "vitest";
import { buildResult, chooseAll, conflictIndexes, joinBlocks, type Choice } from "./conflict";
import type { MergeChunk } from "./types";

const CHUNKS: MergeChunk[] = [
  { kind: "stable", text: "# Titel\n\n" },
  { kind: "conflict", base: "Absatz.\n\n", mine: "Absatz, meins.\n\n", theirs: "Absatz, deren.\n\n" },
  { kind: "merged", text: "- Punkt vom Server\n", from: "theirs" },
  { kind: "conflict", base: "Ende.\n", mine: "", theirs: "Ende, bearbeitet.\n" },
];

describe("conflict result", () => {
  it("needs a choice for every conflict", () => {
    expect(conflictIndexes(CHUNKS)).toEqual([1, 3]);
    expect(buildResult(CHUNKS, new Map([[1, { kind: "mine" }]]))).toBeNull();
  });
  it("takes mine, theirs or both per conflict", () => {
    expect(buildResult(CHUNKS, chooseAll(CHUNKS, "mine"))).toBe("# Titel\n\nAbsatz, meins.\n\n- Punkt vom Server\n");
    expect(buildResult(CHUNKS, chooseAll(CHUNKS, "theirs"))).toBe("# Titel\n\nAbsatz, deren.\n\n- Punkt vom Server\nEnde, bearbeitet.\n");
    const both = new Map<number, Choice>([
      [1, { kind: "both" }],
      [3, { kind: "theirs" }],
    ]);
    expect(buildResult(CHUNKS, both)).toBe("# Titel\n\nAbsatz, meins.\n\nAbsatz, deren.\n\n- Punkt vom Server\nEnde, bearbeitet.\n");
  });
  it("keeps edited blocks on their own lines", () => {
    const edited = new Map<number, Choice>([
      [1, { kind: "edit", text: "Eigener Text" }],
      [3, { kind: "mine" }],
    ]);
    expect(buildResult(CHUNKS, edited)).toBe("# Titel\n\nEigener Text\n\n- Punkt vom Server\n");
    expect(buildResult(CHUNKS, new Map<number, Choice>([[1, { kind: "edit", text: "  \n" }], [3, { kind: "edit", text: "Ende neu" }]]))).toBe("# Titel\n\n- Punkt vom Server\nEnde neu\n");
    expect(joinBlocks("a", "b")).toBe("a\nb");
    expect(joinBlocks("a\n", "b")).toBe("a\nb");
    expect(joinBlocks("", "b")).toBe("b");
    expect(joinBlocks("a", "")).toBe("a");
  });
  it("a merge without conflicts is the result as it is", () => {
    const clean: MergeChunk[] = [
      { kind: "stable", text: "a\n" },
      { kind: "merged", text: "b\n", from: "both" },
    ];
    expect(buildResult(clean, new Map())).toBe("a\nb\n");
  });
});
