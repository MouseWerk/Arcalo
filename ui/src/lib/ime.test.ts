import { describe, expect, it } from "vitest";
import { isComposing } from "./ime";

describe("isComposing", () => {
  it("sees a composition by its flag or, in WebKit, by keyCode 229", () => {
    expect(isComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    // WebKit: the Enter that commits the composition comes after compositionend.
    expect(isComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isComposing({ isComposing: false, keyCode: 27 })).toBe(false);
    expect(isComposing({})).toBe(false);
  });
});
