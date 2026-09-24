import { describe, expect, it } from "vitest";
import { merge3 } from "./merge3";

describe("merge3", () => {
  it("takes the one side that changed", () => {
    expect(merge3("A\n", "A\n", "A\nB\n")).toBe("A\nB\n");
    expect(merge3("A\n", "A\nB\n", "A\n")).toBe("A\nB\n");
  });
  it("keeps both sides' additions at different places", () => {
    expect(merge3("A\n\nB\n", "X\n\nA\n\nB\n", "A\n\nB\n\nY\n")).toBe("X\n\nA\n\nB\n\nY\n");
  });
  it("keeps both additions at the same place (ours first, as separate paragraphs)", () => {
    expect(merge3("A\n", "A\n\nXXX\n", "A\n\nYYY\n")).toBe("A\n\nXXX\n\nYYY\n");
  });
  it("applies a change on one side and an addition on the other", () => {
    expect(merge3("eins\nzwei\ndrei\n", "eins\nZWEI\ndrei\n", "eins\nzwei\ndrei\nvier\n")).toBe("eins\nZWEI\ndrei\nvier\n");
  });
  it("keeps both versions of a line changed on both sides", () => {
    expect(merge3("a\nb\n", "a\nb1\n", "a\nb2\n")).toBe("a\nb1\nb2\n");
  });
  it("applies deletions", () => {
    expect(merge3("a\nb\nc\n", "a\nc\n", "a\nb\nc\nd\n")).toBe("a\nc\nd\n");
  });
});
