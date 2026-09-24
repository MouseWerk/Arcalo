import { describe, expect, it } from "vitest";
import { anchorMenu } from "./ui";

const view = { width: 1000, height: 800 };
const size = { width: 200, height: 300 };

describe("anchorMenu", () => {
  it("opens below the trigger, left-aligned, with a 4px gap", () => {
    expect(anchorMenu({ left: 100, right: 128, top: 50, bottom: 78 }, size, view)).toEqual({ x: 100, y: 82 });
  });
  it("right-aligns to the trigger near the right edge", () => {
    expect(anchorMenu({ left: 900, right: 928, top: 50, bottom: 78 }, size, view)).toEqual({ x: 728, y: 82 });
  });
  it("opens above the trigger when there is no room below", () => {
    expect(anchorMenu({ left: 100, right: 128, top: 700, bottom: 728 }, size, view)).toEqual({ x: 100, y: 396 });
  });
  it("stays inside the window when neither side fits", () => {
    expect(anchorMenu({ left: 100, right: 128, top: 200, bottom: 228 }, { width: 200, height: 700 }, view)).toEqual({ x: 100, y: 92 });
  });
});
