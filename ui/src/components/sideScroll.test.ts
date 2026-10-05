import { describe, expect, it } from "vitest";
import { scrollEdges } from "./SideScroll";

describe("scrollEdges (tables in narrow panes)", () => {
  it("marks the edges that hide columns", () => {
    expect(scrollEdges({ scrollLeft: 0, clientWidth: 400, scrollWidth: 836 })).toEqual({ left: false, right: true });
    expect(scrollEdges({ scrollLeft: 200, clientWidth: 400, scrollWidth: 836 })).toEqual({ left: true, right: true });
    expect(scrollEdges({ scrollLeft: 436, clientWidth: 400, scrollWidth: 836 })).toEqual({ left: true, right: false });
    // Sub-pixel rounding at the end is not a hidden column.
    expect(scrollEdges({ scrollLeft: 435.5, clientWidth: 400, scrollWidth: 836 })).toEqual({ left: true, right: false });
    expect(scrollEdges({ scrollLeft: 0, clientWidth: 900, scrollWidth: 900 })).toEqual({ left: false, right: false });
  });
});
