import { afterEach, describe, expect, it } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Select, optionsFromChildren, step, typeAhead, type SelectOption } from "./Select";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTS: SelectOption[] = [
  { value: "paragraph", label: "Text" },
  { value: "h1", label: "Überschrift 1" },
  { value: "h2", label: "Überschrift 2" },
  { value: "off", label: "Aus", disabled: true },
  { value: "h3", label: "Überschrift 3" },
];

describe("dropdown logic", () => {
  it("reads <option>, <optgroup> and <hr> children like a native select", () => {
    const o = optionsFromChildren([
      createElement("option", { key: "a", value: "" }, "Keines"),
      createElement(Fragment, { key: "f" }, createElement("option", { value: 5 }, "5 ", "Minuten")),
      createElement("hr", { key: "h" }),
      createElement("optgroup", { key: "g", label: "Gruppe" }, createElement("option", { value: "x" }, "X"), createElement("option", { value: "y", disabled: true }, "Y")),
      null,
      false,
    ]);
    expect(o).toEqual([
      { value: "", label: "Keines", disabled: false },
      { value: "5", label: "5 Minuten", disabled: false },
      { value: "x", label: "X", disabled: false, group: "Gruppe" },
      { value: "y", label: "Y", disabled: true },
    ]);
    // The separator lands on the option after it.
    const sep = optionsFromChildren([createElement("option", { key: 1, value: "a" }, "A"), createElement("hr", { key: 2 }), createElement("option", { key: 3, value: "b" }, "B")]);
    expect(sep[1].separator).toBe(true);
  });

  it("skips disabled options when moving", () => {
    expect(step(OPTS, 2, 1)).toBe(4);
    expect(step(OPTS, 4, 1)).toBe(4);
    expect(step(OPTS, 4, 1, true)).toBe(0);
    expect(step(OPTS, 4, -1)).toBe(2);
    expect(step(OPTS, -1, 1)).toBe(0);
  });

  it("type-ahead: prefix match, accents ignored, repeated letters cycle", () => {
    expect(typeAhead(OPTS, "u", 0)).toBe(1);
    expect(typeAhead(OPTS, "u", 1)).toBe(2);
    expect(typeAhead(OPTS, "uu", 2)).toBe(4);
    expect(typeAhead(OPTS, "uberschrift 3", 0)).toBe(4);
    expect(typeAhead(OPTS, "a", 0)).toBe(-1); // "Aus" is disabled
    expect(typeAhead(OPTS, "te", 0)).toBe(0);
  });
});

describe("<Select>", () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  function mount(value: string, onValue: (v: string) => void) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const render = (v: string) =>
      act(() => root!.render(createElement(Select, { value: v, options: OPTS, "aria-label": "Absatzformat", onChange: (e) => (onValue(e.target.value), render(e.target.value)) })));
    render(value);
    return host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  }
  const key = (el: Element, k: string, extra: KeyboardEventInit = {}) =>
    act(() => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra }));
    });
  const list = () => document.querySelector('[role="listbox"]');

  it("opens with the keyboard, moves past disabled options and chooses with Enter", () => {
    const picked: string[] = [];
    const trigger = mount("h2", (v) => picked.push(v));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.dataset.value).toBe("h2");
    trigger.focus();
    key(trigger, "ArrowDown");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(list()).not.toBeNull();
    // The selected option is active and marked.
    const active = () => document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")?.textContent;
    expect(active()).toBe("Überschrift 2");
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toBe("Überschrift 2");
    key(trigger, "ArrowDown");
    expect(active()).toBe("Überschrift 3");
    key(trigger, "Home");
    expect(active()).toBe("Text");
    key(trigger, "End");
    key(trigger, "Enter");
    expect(picked).toEqual(["h3"]);
    expect(list()).toBeNull();
    expect(trigger.dataset.value).toBe("h3");
  });

  it("Tab closes the list, also Shift+Tab as WebKitGTK sends it (key Unidentified, code Tab)", () => {
    const picked: string[] = [];
    const trigger = mount("h2", (v) => picked.push(v));
    trigger.focus();
    key(trigger, "ArrowDown");
    expect(list()).not.toBeNull();
    key(trigger, "Unidentified", { code: "Tab", shiftKey: true });
    expect(list()).toBeNull();
    expect(picked).toEqual([]);
  });

  it("type-ahead while open and closed; Escape closes without choosing", () => {
    const picked: string[] = [];
    const trigger = mount("paragraph", (v) => picked.push(v));
    // Closed: a letter picks the matching option right away (like a native select).
    key(trigger, "u");
    expect(picked).toEqual(["h1"]);
    key(trigger, " ");
    expect(list()).not.toBeNull();
    key(trigger, "t");
    expect(document.querySelector(".select-option.active")?.textContent).toBe("Text");
    key(trigger, "Escape");
    expect(list()).toBeNull();
    expect(picked).toEqual(["h1"]);
  });

  it("keeps the selected option active when the list opens under a pointer that does not move", () => {
    const trigger = mount("h2", () => {});
    trigger.focus();
    key(trigger, "ArrowDown");
    const active = () => document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")?.textContent;
    const move = (value: string, x: number) =>
      act(() => {
        document.querySelector(`[role="option"][data-value="${value}"]`)!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, screenX: x, screenY: 300 }));
      });
    // The engine reports the pointer over the new list (twice, it did not move).
    move("paragraph", 200);
    move("paragraph", 200);
    expect(active()).toBe("Überschrift 2");
    // A real move picks the option under the pointer.
    move("paragraph", 204);
    expect(active()).toBe("Text");
    move("h1", 210);
    expect(active()).toBe("Überschrift 1");
  });

  it("stays open through a new scale arriving (a resize and the scroll it causes), closes on a scroll", async () => {
    const trigger = mount("h2", () => {});
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const scroll = () =>
      act(() => {
        host!.dispatchEvent(new Event("scroll"));
      });
    trigger.focus();
    key(trigger, " ");
    expect(list()).not.toBeNull();
    // The webview's zoom: the window gets a new size and the scrolling area around the trigger
    // keeps its place at the new scale, both reported in one frame.
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    scroll();
    expect(list()).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // A scroll of its own in a later frame moves the trigger away: the list closes.
    await frame();
    const placed = trigger.getBoundingClientRect();
    trigger.getBoundingClientRect = () => ({ ...placed.toJSON(), top: placed.top - 40, y: placed.top - 40 }) as DOMRect;
    scroll();
    expect(list()).toBeNull();
  });

  // R5D-4: a dropdown below the fold, scrolled into view and clicked in the same frame (as
  // WebDriver clicks, or a field focused by Tab and opened with Space): the scroll is reported
  // after the list opened, and it closed the list at once (e2e 37 on CI).
  it("stays open through a scroll reported after it opened that did not move the trigger", async () => {
    const trigger = mount("h2", () => {});
    act(() => trigger.click());
    expect(list()).not.toBeNull();
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    act(() => {
      host!.dispatchEvent(new Event("scroll"));
    });
    expect(list()).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  // R6D-1: the trigger moved after the list was placed by a scroll the person did not make (content
  // above it changing height, a scroll into view reported late): the list closed at once (e2e 37,
  // soak 2026-11-08). It follows the trigger instead; the person scrolling still closes it.
  it("follows the trigger through a scroll the person did not make, closes on one they make", async () => {
    const trigger = mount("h2", () => {});
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const at = (top: number) => (trigger.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 100, right: 300, width: 200, height: 30, x: 100, y: top, toJSON: () => ({}) }) as DOMRect);
    at(400);
    act(() => trigger.click());
    await frame();
    // A row above it got one line shorter, then a scroll is reported.
    at(382);
    act(() => {
      host!.dispatchEvent(new Event("scroll"));
    });
    expect(list()).not.toBeNull();
    expect((list() as HTMLElement).style.top).toBe(`${382 + 30 + 4}px`);
    // The person scrolls the area (wheel): the list closes.
    act(() => {
      host!.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
    });
    at(342);
    act(() => {
      host!.dispatchEvent(new Event("scroll"));
    });
    expect(list()).toBeNull();
  });

  // q124 r7b (e2e 681 on a busy CI runner): the person scrolls before the list was placed again
  // for a scroll the page made. That placement then records where the person's scroll left the
  // trigger, and the person's scroll, reported after it, looked like one that did not move it:
  // the list stayed open.
  it("closes on the person's scroll that comes before the list was placed again for the page's", async () => {
    const trigger = mount("h2", () => {});
    const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const at = (top: number) => (trigger.getBoundingClientRect = () => ({ top, bottom: top + 30, left: 100, right: 300, width: 200, height: 30, x: 100, y: top, toJSON: () => ({}) }) as DOMRect);
    at(400);
    act(() => trigger.click());
    await frame();
    // One task: the page's scroll is reported (its placement renders later), the person scrolls.
    act(() => {
      at(469);
      host!.dispatchEvent(new Event("scroll"));
      host!.dispatchEvent(new WheelEvent("wheel", { deltaY: 60, bubbles: true }));
      at(409);
    });
    expect(list()).not.toBeNull();
    // The person's scroll is reported in the next frame.
    act(() => {
      host!.dispatchEvent(new Event("scroll"));
    });
    expect(list()).toBeNull();
  });

  it("chooses with the mouse and closes on a click outside", () => {
    const picked: string[] = [];
    const trigger = mount("paragraph", (v) => picked.push(v));
    act(() => trigger.click());
    const opt = document.querySelector<HTMLElement>('[role="option"][data-value="h2"]')!;
    act(() => opt.click());
    expect(picked).toEqual(["h2"]);
    act(() => trigger.click());
    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(list()).toBeNull();
    // Disabled options cannot be chosen.
    act(() => trigger.click());
    act(() => document.querySelector<HTMLElement>('[role="option"][data-value="off"]')!.click());
    expect(picked).toEqual(["h2"]);
  });
});
