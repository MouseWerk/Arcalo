import { describe, expect, it } from "vitest";
import { continuation, mapCaret } from "./SourceEditor";

describe("continuation", () => {
  it("continues bullets, numbers and tasks with the same indent", () => {
    expect(continuation("- Apfel")).toEqual({ prefix: "- ", empty: false });
    expect(continuation("  * Birne")).toEqual({ prefix: "  * ", empty: false });
    expect(continuation("9. Neun")).toEqual({ prefix: "10. ", empty: false });
    expect(continuation("- [x] erledigt")).toEqual({ prefix: "- [ ] ", empty: false });
  });
  it("marks an empty item (Enter there ends the list) and ignores other lines", () => {
    expect(continuation("- ")).toEqual({ prefix: "- ", empty: true });
    expect(continuation("- [ ] ")).toEqual({ prefix: "- [ ] ", empty: true });
    expect(continuation("Text")).toBeNull();
    expect(continuation("-kein Punkt")).toBeNull();
  });
});

describe("mapCaret (text from another pane)", () => {
  it("keeps the caret on its text when text is added before or after it", () => {
    expect(mapCaret("eins\nzwei", "neu\neins\nzwei", 7)).toBe(11);
    expect(mapCaret("eins\nzwei", "eins\nzwei\ndrei", 3)).toBe(3);
    expect(mapCaret("eins\nzwei", "eins\nzwei", 6)).toBe(6);
  });
  it("puts a caret inside the changed part behind the new text", () => {
    expect(mapCaret("a XX b", "a YYYY b", 3)).toBe(6);
  });
});
