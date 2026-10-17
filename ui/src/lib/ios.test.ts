import { describe, expect, it } from "vitest";
import { coverViewport, isIosWebView } from "./ios";

describe("the iOS WebView", () => {
  it("is recognized on the iPhone, on the iPad and on an iPad that asks for desktop pages", () => {
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    const ipad = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
    const desktopIpad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
    expect(isIosWebView({ userAgent: iphone, maxTouchPoints: 5 })).toBe(true);
    expect(isIosWebView({ userAgent: ipad, maxTouchPoints: 5 })).toBe(true);
    expect(isIosWebView({ userAgent: desktopIpad, maxTouchPoints: 5 })).toBe(true);
    // A Mac has no touch points; Android is not iOS.
    expect(isIosWebView({ userAgent: desktopIpad, maxTouchPoints: 0 })).toBe(false);
    expect(isIosWebView({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36", maxTouchPoints: 5 })).toBe(false);
  });

  it("asks for the whole viewport once", () => {
    expect(coverViewport("width=device-width, initial-scale=1.0")).toBe("width=device-width, initial-scale=1.0, viewport-fit=cover");
    expect(coverViewport("width=device-width, viewport-fit=auto")).toBe("width=device-width, viewport-fit=cover");
    expect(coverViewport(coverViewport("width=device-width"))).toBe("width=device-width, viewport-fit=cover");
    expect(coverViewport("")).toBe("viewport-fit=cover");
  });
});
