import { afterEach, describe, expect, it } from "vitest";
import { backTarget, pressEscape } from "./androidBack";

describe("Android's back button in the full app", () => {
  afterEach(() => (document.body.innerHTML = ""));

  it("goes to the background when nothing is open", () => {
    document.body.innerHTML = `<main><div class="tree-row" tabindex="0">Seite</div></main>`;
    expect(backTarget()).toBe("background");
  });

  it("closes a dialog, the palette, a menu or a popover first", () => {
    for (const html of [
      `<div class="dialog" role="dialog" aria-modal="true"></div>`,
      `<div class="palette" role="dialog" aria-modal="true"></div>`,
      `<div class="menu" role="menu"></div>`,
      `<div class="calendar"></div>`,
      `<div class="select-pop"></div>`,
      `<div class="pdf-overlay" role="dialog"></div>`,
    ]) {
      document.body.innerHTML = html;
      expect(backTarget(), html).toBe("escape");
    }
  });

  it("ignores what sits in a hidden kept tab", () => {
    document.body.innerHTML = `<div hidden><div class="menu" role="menu"></div><div role="dialog"></div></div>`;
    expect(backTarget()).toBe("background");
  });

  it("sends Escape where the keys go", () => {
    document.body.innerHTML = `<input id="f" />`;
    const f = document.getElementById("f") as HTMLInputElement;
    f.focus();
    const keys: string[] = [];
    window.addEventListener("keydown", (e) => keys.push(`${(e.target as HTMLElement).id}:${e.key}`), { once: true });
    pressEscape();
    expect(keys).toEqual(["f:Escape"]);
  });
});
