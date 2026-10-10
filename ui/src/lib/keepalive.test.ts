import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import { SHOWN_PLACE, keepAlive, onHidden, slotKey, type Kept } from "./keepalive";
import type { Tab } from "../store/app";

const tab = (id: string, pageId?: number, kind: Tab["kind"] = "page"): Tab => ({ id, kind, pageId, back: [], forward: [] });

describe("keepAlive", () => {
  const keys = (kept: Kept[]) => kept.map((k) => k.key);

  it("keeps the recently left places where they are in the document; a new place goes first", () => {
    let kept: Kept[] = [];
    kept = keepAlive(kept, tab("a", 1), ["a", "b"]);
    kept = keepAlive(kept, tab("b", 2), ["a", "b"]);
    expect(keys(kept)).toEqual(["b:page:2", "a:page:1"]);
    // Back to A: the same place (its editor) is shown again, not a new one, and nothing moves.
    kept = keepAlive(kept, tab("a", 1), ["a", "b"]);
    expect(keys(kept)).toEqual(["b:page:2", "a:page:1"]);
    // Navigating in a tab keeps the place it left (back comes back to it).
    kept = keepAlive(kept, tab("a", 3), ["a", "b"]);
    expect(keys(kept)).toEqual(["a:page:3", "b:page:2", "a:page:1"]);
  });

  it("never reorders kept places while switching between them (no remount, no moved node)", () => {
    const ids = ["a", "b", "c", "d", "e"];
    let kept: Kept[] = [];
    ids.forEach((id, i) => (kept = keepAlive(kept, tab(id, i + 1), ids)));
    const order = keys(kept);
    expect(order).toEqual(["e:page:5", "d:page:4", "c:page:3", "b:page:2", "a:page:1"]);
    // Many switches in an irregular order, as with Ctrl+Tab, clicks and the back button.
    for (let n = 0; n < 200; n++) {
      const id = ids[(n * 7 + (n >> 2)) % ids.length];
      kept = keepAlive(kept, tab(id, ids.indexOf(id) + 1), ids);
      expect(keys(kept)).toEqual(order);
    }
  });

  it("drops places of closed tabs and keeps at most the limit, the least recently shown going first", () => {
    let kept: Kept[] = [];
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    ids.forEach((id, i) => (kept = keepAlive(kept, tab(id, i + 1), ids)));
    expect(kept.length).toBe(5);
    expect(keys(kept)).toEqual(["g:page:7", "f:page:6", "e:page:5", "d:page:4", "c:page:3"]);
    // C shown again, then a new tab: D (shown before C) is dropped, C stays in its slot.
    kept = keepAlive(kept, tab("c", 3), ids);
    kept = keepAlive(kept, tab("h", 8), [...ids, "h"]);
    expect(keys(kept)).toEqual(["h:page:8", "g:page:7", "f:page:6", "e:page:5", "c:page:3"]);
    kept = keepAlive(kept, tab("g", 7), ["g", "f"]);
    expect(keys(kept)).toEqual(["g:page:7", "f:page:6"]);
    // Tasks view tab: kept like a page.
    kept = keepAlive(kept, tab("t", undefined, "tasks"), ["g", "f", "t"]);
    expect(keys(kept)).toEqual(["t:tasks:", "g:page:7", "f:page:6"]);
  });

  it("gives the place shown the tab as it is now", () => {
    let kept: Kept[] = [];
    kept = keepAlive(kept, tab("a", 1), ["a", "b"]);
    kept = keepAlive(kept, tab("b", 2), ["a", "b"]);
    const pinned = { ...tab("a", 1), pinned: true };
    kept = keepAlive(kept, pinned, ["a", "b"]);
    expect(kept.find((k) => k.key === "a:page:1")?.tab).toBe(pinned);
  });
});

describe("kept places rendered as a pane renders them", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  it("are never moved or remounted by React while switching tabs", () => {
    const ids = ["a", "b", "c", "d", "e"];
    let kept: Kept[] = [];
    // As PaneView: one keyed box per kept place, hidden unless shown.
    const Pane = ({ shown }: { shown: Tab }) => {
      kept = keepAlive(kept, shown, ids);
      return createElement(
        "section",
        null,
        kept.map((k) => createElement("div", { key: k.key, hidden: k.key !== slotKey(shown), "data-key": k.key })),
      );
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    ids.forEach((id, i) => act(() => root.render(createElement(Pane, { shown: tab(id, i + 1) }))));
    const section = host.querySelector("section")!;
    const nodes = [...section.children];
    // A moved node shows as removed and added again.
    const removed: Node[] = [];
    const watch = new MutationObserver((records) => records.forEach((r) => removed.push(...r.removedNodes)));
    watch.observe(section, { childList: true });
    for (let n = 0; n < 60; n++) {
      const i = (n * 3 + (n >> 1)) % ids.length;
      act(() => root.render(createElement(Pane, { shown: tab(ids[i], i + 1) })));
      expect([...section.children]).toEqual(nodes);
      expect(section.querySelectorAll("div:not([hidden])").length).toBe(1);
      expect(section.querySelector<HTMLElement>("div:not([hidden])")?.dataset.key).toBe(`${ids[i]}:page:${i + 1}`);
    }
    watch.takeRecords().forEach((r) => removed.push(...r.removedNodes));
    watch.disconnect();
    expect(removed).toEqual([]);
    act(() => root.unmount());
    host.remove();
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
    // The next frame, at once (the reaction waits for it).
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 1));
    vi.stubGlobal("cancelAnimationFrame", () => {});
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
