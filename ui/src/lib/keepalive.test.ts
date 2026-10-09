import { describe, expect, it } from "vitest";
import { keepAlive, type Kept } from "./keepalive";
import type { Tab } from "../store/app";

const tab = (id: string, pageId?: number, kind: Tab["kind"] = "page"): Tab => ({ id, kind, pageId, back: [], forward: [] });

describe("keepAlive", () => {
  it("keeps the shown place first and the recently left ones after it", () => {
    let kept: Kept[] = [];
    kept = keepAlive(kept, tab("a", 1), ["a", "b"]);
    kept = keepAlive(kept, tab("b", 2), ["a", "b"]);
    expect(kept.map((k) => k.key)).toEqual(["b:page:2", "a:page:1"]);
    // Back to A: the same place (its editor) is shown again, not a new one.
    kept = keepAlive(kept, tab("a", 1), ["a", "b"]);
    expect(kept.map((k) => k.key)).toEqual(["a:page:1", "b:page:2"]);
    // Navigating in a tab keeps the place it left (back comes back to it).
    kept = keepAlive(kept, tab("a", 3), ["a", "b"]);
    expect(kept.map((k) => k.key)).toEqual(["a:page:3", "a:page:1", "b:page:2"]);
  });

  it("drops places of closed tabs and keeps at most the limit (memory with many tabs)", () => {
    let kept: Kept[] = [];
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    ids.forEach((id, i) => (kept = keepAlive(kept, tab(id, i + 1), ids)));
    expect(kept.length).toBe(5);
    expect(kept[0].key).toBe("g:page:7");
    kept = keepAlive(kept, tab("g", 7), ["g", "f"]);
    expect(kept.map((k) => k.key)).toEqual(["g:page:7", "f:page:6"]);
    // Tasks view tab: kept like a page.
    kept = keepAlive(kept, tab("t", undefined, "tasks"), ["g", "f", "t"]);
    expect(kept.map((k) => k.key)).toEqual(["t:tasks:", "g:page:7", "f:page:6"]);
  });
});
