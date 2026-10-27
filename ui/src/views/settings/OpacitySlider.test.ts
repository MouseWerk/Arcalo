import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { OpacitySlider } from "./OpacitySlider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the opacity slider saves what it shows once let go", () => {
  let host: HTMLElement;
  let root: Root;
  let saved: number[];
  const render = (value: number) => root.render(createElement(OpacitySlider, { value, disabled: false, label: "Deckkraft", onCommit: (v: number) => saved.push(v) }));
  const slider = () => host.querySelector("input")!;
  /** The thumb moved to `v` and let go, as the browser does it: the value first, then the events. */
  const drag = (v: number) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(slider(), String(v));
    slider().dispatchEvent(new Event("input", { bubbles: true }));
    slider().dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  };
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    saved = [];
    act(() => render(80));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("saves the value let go at, and shows it", () => {
    act(() => drag(55));
    expect(saved).toEqual([55]);
    expect(host.querySelector("output")!.textContent).toBe("55 %");
  });

  it("keeps the moved thumb when the page renders before the change is handled", () => {
    // WebKit runs pending work (a settings save that just finished, its render) between the
    // listeners of one event: the slider renders again after the browser moved the thumb and
    // before React's change handler saw it.
    const between = () => flushSync(() => render(80));
    window.addEventListener("input", between, true);
    try {
      act(() => drag(40));
    } finally {
      window.removeEventListener("input", between, true);
    }
    expect(slider().value).toBe("40");
    expect(saved).toEqual([40]);
    expect(host.querySelector("output")!.textContent).toBe("40 %");
  });

  it("follows a value saved elsewhere, and does not save it again", () => {
    act(() => render(65));
    expect(slider().value).toBe("65");
    expect(host.querySelector("output")!.textContent).toBe("65 %");
    act(() => slider().dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    expect(saved).toEqual([]);
  });
});
