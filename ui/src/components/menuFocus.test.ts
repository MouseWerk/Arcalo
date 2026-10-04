import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Menu, Segmented, type MenuEntry } from "./ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  root = host = null;
});

function mount(el: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}
const key = (k: string) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));

describe("context menu keyboard", () => {
  it("moves the focus onto the items, offers checkbox roles and gives the focus back on Escape", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    let closed = 0;
    const items: MenuEntry[] = [
      { label: "Öffnen", onSelect: () => {} },
      "separator",
      { label: "Ordner zuerst", checked: true, onSelect: () => {} },
      { label: "Gesperrt", disabled: true },
      { label: "Löschen", onSelect: () => {} },
    ];
    mount(createElement(Menu, { x: 10, y: 10, items, onClose: () => closed++ }));
    // Opened with the mouse: nothing highlighted, the focus stays where it was.
    expect(document.activeElement).toBe(opener);
    key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Öffnen");
    key("End");
    expect(document.activeElement?.textContent).toContain("Löschen");
    key("Home");
    key("ArrowDown");
    expect(document.activeElement?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[role="separator"]')).not.toBeNull();
    key("Escape");
    expect(closed).toBe(1);
    expect(document.activeElement).toBe(opener);
  });

  it("runs an action with the focus back on the opener and closes on Tab", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    let focusDuringAction: Element | null = null;
    let closed = 0;
    mount(createElement(Menu, { x: 10, y: 10, preselect: true, items: [{ label: "Umbenennen", onSelect: () => (focusDuringAction = document.activeElement) }], onClose: () => closed++ }));
    expect(document.activeElement?.textContent).toContain("Umbenennen");
    key("Enter");
    expect(focusDuringAction).toBe(opener);
    key("Tab");
    expect(closed).toBe(2);
  });
});

describe("segmented control", () => {
  it("is one Tab stop; the arrows choose the neighbour", () => {
    let value = "day";
    const render = () =>
      createElement(Segmented, {
        value,
        label: "Ansicht",
        options: [
          { value: "day", label: "Tag" },
          { value: "week", label: "Woche" },
          { value: "month", label: "Monat" },
        ],
        onChange: (v: string) => {
          value = v;
          act(() => root!.render(render()));
        },
      });
    mount(render());
    const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    radios[0].focus();
    act(() => void radios[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(value).toBe("week");
    expect(document.activeElement?.textContent).toBe("Woche");
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
    expect(value).toBe("month");
  });
});
