import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installTooltips, opensOpenMenu } from "./tooltip";

describe("tooltips", () => {
  beforeAll(() => installTooltips());
  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll("button, [role=menu]").forEach((e) => e.remove());
  });

  const hover = (el: Element) => {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    vi.advanceTimersByTime(600);
    return document.querySelector(".tooltip")!.classList.contains("on");
  };

  it("show for a button the pointer rests on", () => {
    vi.useFakeTimers();
    const b = document.createElement("button");
    b.dataset.tooltip = "Weitere Aktionen";
    b.setAttribute("aria-haspopup", "menu");
    document.body.appendChild(b);
    expect(hover(b)).toBe(true);
  });

  it("stay off the button whose menu is open (the tooltip covered the menu's first item)", () => {
    vi.useFakeTimers();
    const b = document.createElement("button");
    b.dataset.tooltip = "Weitere Aktionen";
    b.setAttribute("aria-haspopup", "menu");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(b, menu);
    expect(opensOpenMenu(b)).toBe(true);
    expect(hover(b)).toBe(false);
  });
});
