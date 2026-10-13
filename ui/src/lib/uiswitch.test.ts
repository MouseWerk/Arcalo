import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ facts: null, choice: "full" })) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { DISPLAY_EVENT, followInterface } from "./uiswitch";

describe("following the window", () => {
  let replace: ReturnType<typeof vi.spyOn>;
  let off: (() => void) | null = null;
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    replace = vi.spyOn(window.location, "replace").mockImplementation(() => {});
  });
  afterEach(() => {
    off?.();
    off = null;
    replace.mockRestore();
    vi.useRealTimers();
  });

  it("does not go while text typed during the flush is unsaved; it flushes again first", async () => {
    const flush = vi.fn(async () => true);
    let typed = true;
    off = followInterface("phone", flush, () => typed);
    window.dispatchEvent(new Event(DISPLAY_EVENT));
    await vi.advanceTimersByTimeAsync(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    typed = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(flush).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith("index.html");
  });

  it("stays when the flush failed", async () => {
    const flush = vi.fn(async () => false);
    off = followInterface("phone", flush, () => false);
    window.dispatchEvent(new Event(DISPLAY_EVENT));
    await vi.advanceTimersByTimeAsync(50);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });
});
