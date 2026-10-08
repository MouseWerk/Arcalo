import { afterEach, describe, expect, it, vi } from "vitest";
import { UNSAVED_RETRY_MS, flushAllEditors, keepUnsaved, retryUnsaved, takeUnsaved, unsavedPages } from "./saves";

afterEach(() => {
  for (const id of unsavedPages()) takeUnsaved(id);
  vi.useRealTimers();
});

describe("edits of closed editors whose save failed", () => {
  it("are saved again until it works and then handed to open editors", async () => {
    vi.useFakeTimers();
    let disk = "full";
    const stored: [number, string][] = [];
    const save = vi.fn(async (id: number, content: string) => {
      if (disk === "full") throw new Error("Der Datenträger ist voll");
      stored.push([id, content]);
    });
    const seen: unknown[] = [];
    const onSaved = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("arcalo:page-saved", onSaved);
    keepUnsaved(7, "# Bericht\n\nletzter Absatz", save);
    expect(unsavedPages()).toEqual([7]);
    await vi.advanceTimersByTimeAsync(UNSAVED_RETRY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(unsavedPages()).toEqual([7]);
    // Quitting meanwhile: the flush says so (the app asks before it quits).
    await expect(flushAllEditors()).rejects.toThrow();
    disk = "free";
    await vi.advanceTimersByTimeAsync(UNSAVED_RETRY_MS);
    expect(stored).toEqual([[7, "# Bericht\n\nletzter Absatz"]]);
    expect(unsavedPages()).toEqual([]);
    expect(seen).toEqual([{ id: 7, content: "# Bericht\n\nletzter Absatz", from: "unsaved" }]);
    await expect(flushAllEditors()).resolves.toBeUndefined();
    window.removeEventListener("arcalo:page-saved", onSaved);
  });

  it("go to an editor that opens the page again, newest text first", async () => {
    const save = vi.fn(async () => {
      throw new Error("schreibgeschützt");
    });
    keepUnsaved(3, "alt", save);
    keepUnsaved(3, "neu", save);
    expect(takeUnsaved(3)).toBe("neu");
    expect(takeUnsaved(3)).toBeUndefined();
    await retryUnsaved();
    expect(save).not.toHaveBeenCalled();
  });
});
