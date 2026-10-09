import { describe, expect, it } from "vitest";
import { isComposing, isKey } from "./ime";

describe("isComposing", () => {
  it("sees a composition by its flag or, in WebKit, by keyCode 229", () => {
    expect(isComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    // WebKit: the Enter that commits the composition comes after compositionend.
    expect(isComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isComposing({ isComposing: false, keyCode: 27 })).toBe(false);
    expect(isComposing({})).toBe(false);
  });

  it("reads React events through nativeEvent; isKey is the key outside a composition", () => {
    expect(isComposing({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: true, keyCode: 13 } })).toBe(true);
    expect(isComposing({ key: "Enter", nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true);
    expect(isKey({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } }, "Enter")).toBe(true);
    expect(isKey({ key: "Enter", keyCode: 229 }, "Enter")).toBe(false);
    expect(isKey({ key: "Escape", isComposing: true }, "Escape")).toBe(false);
    expect(isKey({ key: "Tab" }, "Enter")).toBe(false);
  });
});
