import { describe, expect, it } from "vitest";
import { installReloadGuard, isReloadKey } from "./reloadGuard";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });

describe("the webview never reloads from the keyboard", () => {
  it("knows the reload keys", () => {
    for (const init of [{ key: "F5" }, { key: "F5", ctrlKey: true }, { key: "r", ctrlKey: true }, { key: "R", ctrlKey: true, shiftKey: true }, { key: "r", metaKey: true }])
      expect(isReloadKey(key(init)), JSON.stringify(init)).toBe(true);
    for (const init of [{ key: "r" }, { key: "R", shiftKey: true }, { key: "r", ctrlKey: true, altKey: true }, { key: "F6" }, { key: "t", ctrlKey: true }])
      expect(isReloadKey(key(init)), JSON.stringify(init)).toBe(false);
  });

  it("prevents them in a build, but lets every handler see them (Ctrl+Shift+R is „Im Baum zeigen“)", () => {
    const target = new EventTarget();
    installReloadGuard(target as unknown as Window, false);
    let seen = 0;
    target.addEventListener("keydown", () => seen++);
    for (const init of [{ key: "F5" }, { key: "r", ctrlKey: true }, { key: "R", ctrlKey: true, shiftKey: true }]) {
      const e = key(init);
      target.dispatchEvent(e);
      expect(e.defaultPrevented, JSON.stringify(init)).toBe(true);
    }
    expect(seen).toBe(3);
    const typing = key({ key: "r" });
    target.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
  });

  it("keeps reloading in the Vite dev server", () => {
    const target = new EventTarget();
    installReloadGuard(target as unknown as Window, true);
    const e = key({ key: "F5" });
    target.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
