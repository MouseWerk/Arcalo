import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SHOWN_PLACE, keepAlive, onHidden, type Kept } from "./keepalive";
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

describe("queries of the shown place", () => {
  const SRC = path.resolve(__dirname, "..");
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });

  it("go through SHOWN_PLACE: a hidden kept tab in the active pane has an editor and a title too", () => {
    // `.pane.active .x` finds the first match in the pane, which may be in a hidden kept place.
    const stray = sources(SRC).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => (/\.pane\.active\s+[^\s>"'`]/.test(line) ? [`${path.relative(SRC, f)}:${i + 1}`] : [])),
    );
    expect(stray).toEqual([]);
  });

  it("matches the shown place only", () => {
    document.body.innerHTML = `<section class="pane active"><div class="pane-content"><div class="ProseMirror" id="a"></div></div><div class="pane-content" hidden><div class="ProseMirror" id="b"></div></div></section>`;
    const pane = document.querySelector(".pane")!;
    // The shown one second in the document (a hidden one first).
    pane.append(pane.firstElementChild!);
    expect(document.querySelector(`${SHOWN_PLACE} .ProseMirror`)?.id).toBe("a");
    document.body.innerHTML = "";
  });
});

describe("onHidden", () => {
  it("tells when the element is no longer laid out, not while it is shown", () => {
    // The engine's observer, driven by hand: it calls back on every size change.
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {}
        observe() {
          observers.push(this.cb);
        }
        disconnect() {
          observers.splice(observers.indexOf(this.cb), 1);
        }
      },
    );
    const el = document.createElement("div");
    document.body.append(el);
    let shown = true;
    el.getClientRects = () => (shown ? [new DOMRect(0, 0, 10, 10)] : []) as unknown as DOMRectList;
    let hidden = 0;
    const off = onHidden(el, () => hidden++);
    observers.forEach((f) => f());
    expect(hidden).toBe(0);
    // Its kept place hidden (another tab shown).
    shown = false;
    observers.forEach((f) => f());
    expect(hidden).toBe(1);
    off();
    expect(observers).toEqual([]);
    el.remove();
    vi.unstubAllGlobals();
  });
});
