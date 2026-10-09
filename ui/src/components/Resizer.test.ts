import { describe, expect, it } from "vitest";
import { RESIZE_STEP, RESIZE_STEP_BIG, resizeKey } from "./Resizer";

const key = (k: string, mods: { shift?: boolean; ctrl?: boolean } = {}) => ({ key: k, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: false, metaKey: false });

describe("resizeKey", () => {
  it("moves a focused splitter with the arrows (Shift further) and resets it with Enter or Home", () => {
    expect(resizeKey(key("ArrowRight"))).toEqual({ dx: RESIZE_STEP });
    expect(resizeKey(key("ArrowLeft"))).toEqual({ dx: -RESIZE_STEP });
    expect(resizeKey(key("ArrowRight", { shift: true }))).toEqual({ dx: RESIZE_STEP_BIG });
    expect(resizeKey(key("Enter"))).toBe("reset");
    expect(resizeKey(key("Home"))).toBe("reset");
    // Shortcuts (Ctrl+…) and other keys pass through.
    expect(resizeKey(key("ArrowLeft", { ctrl: true }))).toBeNull();
    expect(resizeKey(key("Tab"))).toBeNull();
  });
});
