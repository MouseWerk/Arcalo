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
