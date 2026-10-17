import { describe, expect, it } from "vitest";
import { chooseInterface, DESKTOP_DP, factsFromViewport, HYSTERESIS_DP, IPAD_DP, isDesktopSetting, LARGE_DP, pageOf, switchAllowed, type DisplayFacts } from "./uimode";
import { withViewport } from "./uiswitch";

const touch = (width: number, height: number, more: Partial<DisplayFacts> = {}): DisplayFacts => ({
  width,
  height,
  smallestWidth: Math.min(width, height),
  pc: false,
  desk: false,
  freeform: false,
  multiWindow: false,
  external: false,
  mouse: false,
  keyboard: false,
  ...more,
});

describe("the interface of the Android app", () => {
  it("phones get the phone app, upright and sideways", () => {
    for (const [w, h] of [
      [360, 800],
      [412, 915],
      [430, 932],
      [915, 412],
      [800, 360],
    ]) {
      expect(chooseInterface("auto", touch(w, h), "phone"), `${w}x${h}`).toBe("phone");
    }
  });

  it("tablets get the full app, upright and sideways", () => {
    for (const [w, h] of [
      [800, 1280],
      [1280, 800],
      [600, 960],
      [1024, 1366],
    ]) {
      expect(chooseInterface("auto", touch(w, h), "phone"), `${w}x${h}`).toBe("full");
    }
  });

  it("split screen on a tablet follows the window, not the display", () => {
    // Half of a landscape tablet: still large enough.
    expect(chooseInterface("auto", touch(640, 800, { multiWindow: true, smallestWidth: 640 }), "phone")).toBe("full");
    // A third: a phone-sized window.
    expect(chooseInterface("auto", touch(420, 800, { multiWindow: true, smallestWidth: 420 }), "full")).toBe("phone");
  });

  it("a desktop setting gets the full app from a smaller window on", () => {
    const small = touch(520, 700);
    expect(chooseInterface("auto", small, "phone")).toBe("phone");
    for (const more of [{ desk: true }, { freeform: true }, { external: true }, { mouse: true, keyboard: true }]) {
      const f = { ...small, ...more };
      expect(isDesktopSetting(f), JSON.stringify(more)).toBe(true);
      expect(chooseInterface("auto", f, "phone"), JSON.stringify(more)).toBe("full");
    }
    // A mouse alone (or a keyboard alone) is no desktop: a phone with a Bluetooth keyboard stays a phone.
    expect(chooseInterface("auto", { ...small, mouse: true }, "phone")).toBe("phone");
    expect(chooseInterface("auto", { ...small, keyboard: true }, "phone")).toBe("phone");
    // A tiny desktop window is still too small.
    expect(chooseInterface("auto", touch(360, 640, { freeform: true }), "phone")).toBe("phone");
  });

  it("a phone in desktop mode on an external display gets the full app", () => {
    expect(chooseInterface("auto", touch(1920, 1032, { desk: true, external: true, mouse: true, keyboard: true }), "phone")).toBe("full");
  });

  it("Android on a PC always gets the full app", () => {
    expect(chooseInterface("auto", touch(400, 500, { pc: true }), "phone")).toBe("full");
  });

  it("a window resized around the line does not switch back and forth", () => {
    // Opened as the phone app: the full app only from the line on.
    expect(chooseInterface("auto", touch(LARGE_DP - 1, 900), "phone")).toBe("phone");
    expect(chooseInterface("auto", touch(LARGE_DP, 900), "phone")).toBe("full");
    // Showing the full app: it stays until the window is clearly smaller.
    expect(chooseInterface("auto", touch(LARGE_DP - 1, 900), "full")).toBe("full");
    expect(chooseInterface("auto", touch(LARGE_DP - HYSTERESIS_DP, 900), "full")).toBe("full");
    expect(chooseInterface("auto", touch(LARGE_DP - HYSTERESIS_DP - 1, 900), "full")).toBe("phone");
    // The same in a desktop window, at its own line.
    expect(chooseInterface("auto", touch(DESKTOP_DP - HYSTERESIS_DP, 700, { freeform: true }), "full")).toBe("full");
    expect(chooseInterface("auto", touch(DESKTOP_DP - 1, 700, { freeform: true }), "phone")).toBe("phone");
  });

  it("the setting overrides the device", () => {
    expect(chooseInterface("phone", touch(1280, 800, { pc: true }), "full")).toBe("phone");
    expect(chooseInterface("full", touch(360, 800), "phone")).toBe("full");
  });

  it("unknown sizes use the display's smallest width, or keep the interface", () => {
    expect(chooseInterface("auto", { ...touch(0, 0), smallestWidth: 720 }, "phone")).toBe("full");
    expect(chooseInterface("auto", { ...touch(0, 0), smallestWidth: 0 }, "phone")).toBe("phone");
    expect(chooseInterface("auto", { ...touch(0, 0), smallestWidth: 0 }, "full")).toBe("full");
  });

  it("names the page of each interface", () => {
    expect(pageOf("full")).toBe("index.html");
    expect(pageOf("phone")).toBe("mobile.html");
  });

  it("reads the viewport when Android does not answer", () => {
    const f = factsFromViewport({ innerWidth: 1280, innerHeight: 800, matchMedia: (q) => ({ matches: q === "(any-pointer: fine)" }) });
    expect(f).toMatchObject({ width: 1280, height: 800, smallestWidth: 800, mouse: true, keyboard: false });
    expect(chooseInterface("auto", f, "phone")).toBe("full");
  });

  it("stops switching after too many switches in a short time", () => {
    const now = 100_000;
    expect(switchAllowed([], now)).toBe(true);
    expect(switchAllowed([now - 5000, now - 1000], now)).toBe(true);
    expect(switchAllowed([now - 9000, now - 5000, now - 1000], now)).toBe(false);
    // Old switches do not count.
    expect(switchAllowed([now - 90_000, now - 60_000, now - 1000], now)).toBe(true);
  });
});

describe("the interface of the iOS app", () => {
  // iOS names only the device; the sizes are the WebView's (withViewport).
  const ios = (ipad: boolean): DisplayFacts => ({ ...touch(0, 0), smallestWidth: 0, ipad });
  const at = (ipad: boolean, w: number, h: number) => withViewport(ios(ipad), touch(w, h));

  it("iPhones get the phone app, upright and sideways, the largest ones included", () => {
    for (const [w, h] of [
      [375, 667],
      [393, 852],
      [440, 956],
      [956, 440],
      [852, 393],
    ]) {
      expect(chooseInterface("auto", at(false, w, h), "phone"), `${w}x${h}`).toBe("phone");
    }
  });

  it("iPads get the full app in full screen, half of Split View and wide Stage Manager windows", () => {
    for (const [w, h] of [
      [744, 1133], // iPad mini upright
      [1133, 744],
      [1032, 1376], // iPad Pro 13" upright
      [1376, 1032],
      [688, 1032], // half of a 13" iPad sideways
      [560, 744], // half of an iPad mini sideways
      [900, 500], // a wide, low window in Stage Manager
    ]) {
      expect(chooseInterface("auto", at(true, w, h), "phone"), `${w}x${h}`).toBe("full");
    }
  });

  it("a narrow iPad window (Slide Over, a third of Split View) gets the phone app", () => {
    for (const [w, h] of [
      [320, 1032],
      [375, 1032],
      [438, 1376],
    ]) {
      expect(chooseInterface("auto", at(true, w, h), "full"), `${w}x${h}`).toBe("phone");
    }
  });

  it("the full app stays while an iPad window shrinks a little below the line", () => {
    expect(chooseInterface("auto", at(true, IPAD_DP - HYSTERESIS_DP + 1, 900), "full")).toBe("full");
    expect(chooseInterface("auto", at(true, IPAD_DP - 1, 900), "phone")).toBe("phone");
    expect(chooseInterface("phone", at(true, 1376, 1032), "full")).toBe("phone");
  });

  it("the system's own sizes win over the WebView's", () => {
    const android = touch(800, 1280);
    expect(withViewport(android, touch(10, 10))).toBe(android);
    expect(withViewport(null, touch(400, 800)).width).toBe(400);
    expect(at(true, 560, 744)).toMatchObject({ width: 560, height: 744, smallestWidth: 560, ipad: true });
  });
});
