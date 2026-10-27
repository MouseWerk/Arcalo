// Which interface the Android and iOS apps show (1.20): the phone app (`mobile.html`) or the
// full app (`index.html`). Chosen from the window and the device at the start and again whenever the
// window changes (resized, moved to another display, a mouse or keyboard plugged in); the setting
// „Oberfläche auf Android“ (`appearance.android_interface`) can fix it to one of them.
//
// The decision is a pure function of what Android reports (src-tauri/src/mobile/android.rs,
// `display`), so it is tested on the host (uimode.test.ts); `uiswitch.ts` reads the facts and
// carries the switch out.

export type Interface = "phone" | "full";
export type InterfaceChoice = "auto" | "phone" | "full";

/** What Android says about the app's window and the device. Sizes in dp (CSS pixels at zoom 1). */
export interface DisplayFacts {
  /** The window's width and height (Configuration.screenWidthDp/screenHeightDp). */
  width: number;
  height: number;
  /** Configuration.smallestScreenWidthDp: the shorter side the window can have on this display. */
  smallestWidth: number;
  /** Android on a PC (PackageManager.FEATURE_PC). */
  pc: boolean;
  /** Android's desktop mode or a dock (Configuration.UI_MODE_TYPE_DESK). */
  desk: boolean;
  /** A freely sized window (desktop windowing), not full screen or split screen. */
  freeform: boolean;
  /** Split screen or another multi-window mode (Activity.isInMultiWindowMode). */
  multiWindow: boolean;
  /** The window is on a display other than the device's own (an external monitor). */
  external: boolean;
  /** A mouse or touchpad is connected. */
  mouse: boolean;
  /** A hardware keyboard is connected (Configuration.keyboard QWERTY, not hidden). */
  keyboard: boolean;
  /** An iPad (iOS, src-tauri/src/mobile/ios.rs): the full app unless the window is narrow. */
  ipad?: boolean;
}

/** The shorter side of a window from which a touch device gets the full app (Android's tablet line). */
export const LARGE_DP = 600;
/** The same in a desktop setting (desktop window, external display, mouse and keyboard). */
export const DESKTOP_DP = 480;
/** The width from which an iPad window gets the full app: iPadOS's regular width (the compact
 *  ones, Slide Over and a third in Split View, are 320 to about 440 points wide). */
export const IPAD_DP = 500;
/** How far below its line a window may shrink before the full app goes back to the phone app,
 * so a window resized around the line does not switch back and forth. */
export const HYSTERESIS_DP = 48;

/** A desktop setting: Android on a PC, desktop mode, a desktop window, an external display, or a
 * mouse together with a keyboard. */
export function isDesktopSetting(f: DisplayFacts): boolean {
  return f.pc || f.desk || f.freeform || f.external || (f.mouse && f.keyboard);
}

/**
 * The interface for these facts. `current` is the one showing (the full app stays a little
 * longer while a window shrinks, see [`HYSTERESIS_DP`]); a fixed choice always wins.
 */
export function chooseInterface(choice: InterfaceChoice, f: DisplayFacts, current: Interface): Interface {
  if (choice === "phone" || choice === "full") return choice;
  // A PC is a desktop, however small its window.
  if (f.pc) return "full";
  // An iPad: the full app in every window but a narrow one (Slide Over, a third in Split View, a
  // narrow window in Stage Manager), whatever its height.
  if (f.ipad) {
    const w = f.width > 0 ? f.width : f.smallestWidth;
    if (w <= 0) return current;
    if (current === "full") return w >= IPAD_DP - HYSTERESIS_DP ? "full" : "phone";
    return w >= IPAD_DP ? "full" : "phone";
  }
  const line = isDesktopSetting(f) ? DESKTOP_DP : LARGE_DP;
  // Unknown sizes (0) fall back to the display's smallest width.
  const w = f.width > 0 ? f.width : f.smallestWidth;
  const h = f.height > 0 ? f.height : f.smallestWidth;
  const shorter = Math.min(w, h);
  if (shorter <= 0) return current;
  if (current === "full") return shorter >= line - HYSTERESIS_DP ? "full" : "phone";
  return shorter >= line ? "full" : "phone";
}

/** The page of an interface (both are entries of the same build, ui/vite.config.ts). */
export function pageOf(ui: Interface): string {
  return ui === "full" ? "index.html" : "mobile.html";
}

/** Facts read in the WebView alone (no Android answer): the viewport and the pointers. */
export function factsFromViewport(win: { innerWidth: number; innerHeight: number; matchMedia?: (q: string) => { matches: boolean } }): DisplayFacts {
  const media = (q: string) => !!win.matchMedia?.(q).matches;
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    smallestWidth: Math.min(win.innerWidth, win.innerHeight),
    pc: false,
    desk: false,
    freeform: false,
    multiWindow: false,
    external: false,
    mouse: media("(any-pointer: fine)"),
    keyboard: false,
  };
}

/**
 * Too many switches in a short time (a window that keeps changing, a device that reports
 * something odd): the interface stays as it is for the rest of the session. `times` are the
 * earlier switches (ms), newest last.
 */
export function switchAllowed(times: number[], now: number, limit = 3, windowMs = 30_000): boolean {
  return times.filter((t) => now - t < windowMs).length < limit;
}
