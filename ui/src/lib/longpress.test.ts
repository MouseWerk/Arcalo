import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLongPress, keepsNativePress, LONG_PRESS_MS, MOVE_TOLERANCE } from "./longpress";

/** Timers run by hand. */
function clock() {
  let now = 1000;
  let next = 1;
  const jobs = new Map<number, { at: number; f: () => void }>();
  return {
    set: (f: () => void, ms: number) => (jobs.set(next, { at: now + ms, f }), next++),
    clear: (id: number) => void jobs.delete(id),
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, j] of [...jobs]) {
        if (j.at <= now) {
          jobs.delete(id);
          j.f();
        }
      }
    },
  };
}

function pointer(type: string, target: Element, more: { pointerType?: string; x?: number; y?: number } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(e, {
    pointerType: { value: more.pointerType ?? "touch" },
    isPrimary: { value: true },
    clientX: { value: more.x ?? 40 },
    clientY: { value: more.y ?? 50 },
  });
  target.dispatchEvent(e);
}

describe("a long press opens the context menu", () => {
  let row: HTMLElement;
  let field: HTMLInputElement;
  let menus: MouseEvent[];
  let t: ReturnType<typeof clock>;
  let off: () => void;
  const record = (e: Event) => menus.push(e as MouseEvent);
  beforeEach(() => {
    document.body.innerHTML = `<div class="tree-row">Seite</div><input value="x" />`;
    row = document.querySelector(".tree-row")!;
    field = document.querySelector("input")!;
    menus = [];
    document.addEventListener("contextmenu", record);
    t = clock();
    off = installLongPress(document, t);
  });
  afterEach(() => {
    off();
    document.removeEventListener("contextmenu", record);
  });

  it("sends one contextmenu where the finger rests", () => {
    pointer("pointerdown", row, { x: 40, y: 50 });
    t.advance(LONG_PRESS_MS - 1);
    expect(menus).toHaveLength(0);
    t.advance(1);
    expect(menus).toHaveLength(1);
    expect(menus[0].target).toBe(row);
    expect([menus[0].clientX, menus[0].clientY, menus[0].button]).toEqual([40, 50, 2]);
    // The release does not click the row as well; the next press clicks as usual.
    const click = () => {
      const c = new Event("click", { bubbles: true, cancelable: true });
      row.dispatchEvent(c);
      return c.defaultPrevented;
    };
    expect(click()).toBe(true);
    pointer("pointerdown", row, { pointerType: "mouse" });
    expect(click()).toBe(false);
  });

  it("does nothing for a tap, a scroll, a mouse or in a text field", () => {
    pointer("pointerdown", row);
    t.advance(200);
    pointer("pointerup", row);
    t.advance(LONG_PRESS_MS);
    pointer("pointerdown", row, { x: 40, y: 50 });
    pointer("pointermove", row, { x: 40, y: 50 + MOVE_TOLERANCE + 1 });
    t.advance(LONG_PRESS_MS);
    pointer("pointerdown", row, { pointerType: "mouse" });
    t.advance(LONG_PRESS_MS);
    pointer("pointerdown", field);
    t.advance(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
    // A small tremble is still a press.
    pointer("pointerdown", row, { x: 40, y: 50 });
    pointer("pointermove", row, { x: 43, y: 52 });
    t.advance(LONG_PRESS_MS);
    expect(menus).toHaveLength(1);
  });

  it("leaves text fields and the editor to Android's selection", () => {
    document.body.innerHTML = `<div class="ProseMirror"><p>Text</p></div><textarea></textarea><div contenteditable="true"></div><button>B</button>`;
    expect(keepsNativePress(document.querySelector(".ProseMirror p"))).toBe(true);
    expect(keepsNativePress(document.querySelector("textarea"))).toBe(true);
    expect(keepsNativePress(document.querySelector("[contenteditable]"))).toBe(true);
    expect(keepsNativePress(document.querySelector("button"))).toBe(false);
    expect(keepsNativePress(null)).toBe(true);
  });

  it("leaves drawing alone: a pen or finger resting on a drawing, the canvas or a grip draws or drags", () => {
    document.body.innerHTML = `<div class="drawing-canvas"><div class="excalidraw"><canvas></canvas></div></div>
      <div class="cv-board" data-native-press><div class="cv-card">Karte</div></div><header data-native-press><span class="dw-grip"></span></header>`;
    pointer("pointerdown", document.querySelector(".drawing-canvas .excalidraw canvas")!, { pointerType: "pen" });
    t.advance(LONG_PRESS_MS);
    pointer("pointerdown", document.querySelector(".excalidraw canvas")!, { pointerType: "touch" });
    t.advance(LONG_PRESS_MS);
    pointer("pointerdown", document.querySelector(".cv-card")!, { pointerType: "pen" });
    t.advance(LONG_PRESS_MS);
    pointer("pointerdown", document.querySelector(".dw-grip")!);
    t.advance(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
  });

  it("drops the system's own press-and-hold menu that comes after ours, also at the release", () => {
    const native = () => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "isTrusted", { value: true });
      row.dispatchEvent(e);
      return e.defaultPrevented;
    };
    pointer("pointerdown", row, { pointerType: "pen" });
    t.advance(LONG_PRESS_MS);
    expect(menus).toHaveLength(1);
    // Windows sends its own when the pen lifts, however long it rested.
    t.advance(2000);
    pointer("pointerup", row, { pointerType: "pen" });
    t.advance(100);
    expect(native()).toBe(true);
    expect(menus).toHaveLength(1);
    // A right click later opens the menu as usual.
    t.advance(2000);
    expect(native()).toBe(false);
    expect(menus).toHaveLength(2);
  });

  it("stops listening when removed", () => {
    off();
    pointer("pointerdown", row);
    t.advance(LONG_PRESS_MS);
    expect(menus).toHaveLength(0);
  });
});
