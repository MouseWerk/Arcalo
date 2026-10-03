import { afterEach, describe, expect, it } from "vitest";
import { reducedMotion, scrollMotion } from "./motion";

describe("reduced motion", () => {
  afterEach(() => {
    delete document.documentElement.dataset.reduceMotion;
  });
  it("follows the app switch as well as the system setting", () => {
    document.documentElement.dataset.reduceMotion = "on";
    expect(reducedMotion()).toBe(true);
    expect(scrollMotion()).toBe("auto");
    document.documentElement.dataset.reduceMotion = "off";
    const sys = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    expect(scrollMotion()).toBe(sys ? "auto" : "smooth");
  });
});
