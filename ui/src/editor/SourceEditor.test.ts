import { describe, expect, it } from "vitest";
import { continuation } from "./SourceEditor";

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
