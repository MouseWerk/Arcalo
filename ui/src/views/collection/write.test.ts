import { describe, expect, it, vi } from "vitest";
import { registerFrontmatterOwner, updateFrontmatter } from "./write";

describe("updateFrontmatter", () => {
  it("writes through the view on screen when the page is open twice", async () => {
    // The first view was kept open behind another tab, the second one is shown.
    const hidden = { get: () => "status: offen\n", set: vi.fn(), shown: () => false };
    const shown = { get: () => "status: offen\n", set: vi.fn(), shown: () => true };
    const offA = registerFrontmatterOwner(5, hidden);
    const offB = registerFrontmatterOwner(5, shown);
    expect(await updateFrontmatter(5, () => "status: fertig\n")).toBe("status: fertig\n");
    expect(shown.set).toHaveBeenCalledWith("status: fertig\n");
    expect(hidden.set).not.toHaveBeenCalled();
    offB();
    // Only the hidden one left: it still writes (it saves, the page follows).
    await updateFrontmatter(5, () => "status: neu\n");
    expect(hidden.set).toHaveBeenCalledWith("status: neu\n");
    offA();
  });
});
