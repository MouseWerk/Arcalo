// What the app can do where it runs (src-tauri/src/platform.rs, `app_capabilities`). The full
// app also runs on Android's large screens (1.20) and on the iPad; the desktop-only parts (tray, global
// shortcuts, autostart, the command line, the desktop updater, the small windows, voice notes,
// local folders, the encryption and the app lock) are hidden after these flags instead of failing
// there. Read once before the first frame (`loadCapabilities`), then synchronously (`caps()`).

import { invoke } from "@tauri-apps/api/core";

export interface Capabilities {
  /** `windows`, `macos`, `linux`, `android` or `ios`. */
  platform: string;
  /** The Android or iOS app (also when simulated). */
  mobile: boolean;
  /** The Android capabilities on a desktop debug build (end-to-end tests). */
  simulated: boolean;
  tray: boolean;
  globalShortcuts: boolean;
  autostart: boolean;
  commandLine: boolean;
  desktopUpdater: boolean;
  androidUpdater: boolean;
  /** Quick capture, quick search and the presenter view as windows of their own. */
  popupWindows: boolean;
  /** Own title bar and window buttons, backdrop, closing to the tray, quitting. */
  windowFrame: boolean;
  /** Choosing and opening local folders. */
  folders: boolean;
  /** Opening a file with the system's program for it. */
  openFiles: boolean;
  /** Starting programs (quick links to a program or a path). */
  programs: boolean;
  voice: boolean;
  /** Encryption of the database and the app lock. */
  security: boolean;
  /** Local backups, backup destinations, restoring. */
  backups: boolean;
  restart: boolean;
  /** Proxy auto-configuration scripts. */
  pac: boolean;
}

/** The desktop: everything (also what the UI assumes before the backend answered, and in tests). */
export const DESKTOP: Capabilities = {
  platform: "desktop",
  mobile: false,
  simulated: false,
  tray: true,
  globalShortcuts: true,
  autostart: true,
  commandLine: true,
  desktopUpdater: true,
  androidUpdater: false,
  popupWindows: true,
  windowFrame: true,
  folders: true,
  openFiles: true,
  programs: true,
  voice: true,
  security: true,
  backups: true,
  restart: true,
  pac: true,
};

/** The Android app, as src-tauri/src/platform.rs reports it. */
export const ANDROID: Capabilities = {
  ...DESKTOP,
  platform: "android",
  mobile: true,
  tray: false,
  globalShortcuts: false,
  autostart: false,
  commandLine: false,
  desktopUpdater: false,
  androidUpdater: true,
  popupWindows: false,
  windowFrame: false,
  folders: false,
  openFiles: true,
  programs: false,
  voice: false,
  security: false,
  backups: false,
  restart: false,
  pac: false,
};

/** The iOS app (iPhone and iPad): Android's, without the APK updates (the App Store updates it). */
export const IOS: Capabilities = { ...ANDROID, platform: "ios", androidUpdater: false };

let current: Capabilities = DESKTOP;

/** The capabilities of this app (the desktop's until `loadCapabilities` answered). */
export function caps(): Capabilities {
  return current;
}

/** Sets them (the start, and tests). Marks the page for styles that differ on the mobile systems
 *  (`platform-android` on both, as the touch styles are the same; `platform-ios` for the safe
 *  areas of iOS). */
export function setCapabilities(c: Capabilities): void {
  current = c;
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("platform-android", c.mobile);
  document.documentElement.classList.toggle("platform-ios", c.platform === "ios");
}

/** Asks the backend once; a backend without the command (older test doubles) is the desktop. */
export async function loadCapabilities(): Promise<Capabilities> {
  try {
    setCapabilities({ ...DESKTOP, ...(await invoke<Partial<Capabilities>>("app_capabilities")) });
  } catch {
    setCapabilities(DESKTOP);
  }
  return current;
}

/** The Android app for real (not the simulation on a desktop): Android's own APIs answer. */
export function onAndroid(): boolean {
  return current.platform === "android" && current.mobile && !current.simulated;
}

/** The iOS app (iPhone or iPad). */
export function onIos(): boolean {
  return current.platform === "ios" && !current.simulated;
}

/** A phone or tablet for real (Android or iOS): the interface follows the window there. */
export function onMobileDevice(): boolean {
  return current.mobile && !current.simulated;
}
