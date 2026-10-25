import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog } from "./ui";

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
/** A keydown as the webview sends it; returns whether the dialog took it (the browser's own move prevented). */
const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => void (document.activeElement ?? window).dispatchEvent(e));
  return e.defaultPrevented;
};

describe("dialog focus trap", () => {
  it("wraps Tab and Shift+Tab, also Shift+Tab as WebKitGTK sends it (ISO_Left_Tab: key Unidentified, code Tab)", () => {
    const fields = [createElement("input", { key: "n", "aria-label": "Name" }), createElement("button", { key: "s", type: "button" }, "Speichern")];
    mount(createElement(Dialog, { open: true, onClose: () => {}, title: "Umbenennen" }, fields));
    const box = document.querySelector<HTMLElement>(".dialog")!;
    const all = [...box.querySelectorAll<HTMLElement>("button, input")];
    // happy-dom lays nothing out: every control counts as shown.
    for (const el of all) Object.defineProperty(el, "offsetParent", { get: () => box });
    const [first, last] = [all[0], all[all.length - 1]];
    first.focus();
    expect(press({ key: "Unidentified", code: "Tab", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(last);
    expect(press({ key: "Tab", code: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(press({ key: "Tab", code: "Tab", shiftKey: true })).toBe(true);
    expect(document.activeElement).toBe(last);
    // Inside the order the browser moves on by itself.
    first.focus();
    expect(press({ key: "Tab", code: "Tab" })).toBe(false);
  });
});
