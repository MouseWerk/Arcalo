import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cycleRegion } from "./regions";

// happy-dom has no layout: everything not inside [hidden] counts as shown.
const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
beforeEach(() =>
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest("[hidden]") ? null : this.parentElement;
    },
  }),
);
afterEach(() => {
  if (desc) Object.defineProperty(HTMLElement.prototype, "offsetParent", desc);
  document.body.innerHTML = "";
});

describe("cycleRegion", () => {
  it("goes ribbon → sidebar (current row) → pane (the shown editor) → panel → newest toast and around", () => {
    document.body.innerHTML = `
      <div class="app">
        <nav class="ribbon"><button id="r1">R</button></nav>
        <aside class="sidebar"><input id="filter"><div class="tree-row" tabindex="-1" id="row1"></div><div class="tree-row" tabindex="0" id="row2"></div></aside>
        <div class="workspace"><section class="pane active">
          <div class="pane-content"><div class="ProseMirror" contenteditable="true" id="shown"></div></div>
          <div class="pane-content" hidden><div class="ProseMirror" contenteditable="true" id="kept"></div></div>
        </section></div>
        <aside class="panel"><button role="tab" aria-selected="false" id="t1"></button><button role="tab" aria-selected="true" id="t2"></button></aside>
        <div class="toasts"><div class="toast"><button id="old">x</button></div><div class="toast"><button id="undo">Rückgängig</button><button>x</button></div></div>
      </div>`;
    const order = [1, 1, 1, 1, 1, 1].map(() => cycleRegion(1)?.id);
    expect(order).toEqual(["r1", "row2", "shown", "t2", "undo", "r1"]);
    expect(cycleRegion(-1)?.id).toBe("undo");
    expect(cycleRegion(-1)?.id).toBe("t2");
  });

  it("skips regions that are not there (no panel, no messages)", () => {
    document.body.innerHTML = `<div class="app"><nav class="ribbon"><button id="r1">R</button></nav><div class="workspace"><section class="pane active"><div class="pane-content"><button id="b">B</button></div></section></div></div>`;
    expect(cycleRegion(1)?.id).toBe("r1");
    expect(cycleRegion(1)?.id).toBe("b");
    expect(cycleRegion(1)?.id).toBe("r1");
  });
});
