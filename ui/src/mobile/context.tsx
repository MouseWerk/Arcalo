// What every screen of the companion app gets: the settings, navigation, toasts and a data
// version that grows whenever bookings, pages or the sync changed something, the updater and
// the layers the back button closes first.

import { createContext, useContext, useEffect, useRef } from "react";
import type { Screen, Tab } from "./model";
import type { Settings, SettingsView } from "../lib/types";
import type { UpdateStatus } from "./api";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

export interface MobileContext {
  view: SettingsView;
  settings: Settings;
  /** Grows when data changed (bookings, pages, a sync): screens load again. */
  version: number;
  refresh: () => void;
  open: (s: Screen) => void;
  back: () => void;
  tab: (t: Tab) => void;
  toast: (tone: ToastTone, title: string, detail?: string) => void;
  /** Saves the settings and applies them (language, theme) right away. */
  saveSettings: (next: Settings) => Promise<void>;
  /** Syncs now; resolves with whether it worked. */
  sync: (opts?: { quiet?: boolean; allowDeletions?: boolean }) => Promise<boolean>;
  syncing: boolean;
  /** The app's own updater (null until it answered, and in a browser). */
  update: UpdateStatus | null;
  /** „Update installieren“ was refused: the app may not install apps yet. */
  installBlocked: boolean;
  /** „Update installieren“: Android's installer, or first the permission to install apps. */
  installUpdate: () => Promise<void>;
  /** Opens Android's setting for the permission, then installs when it was given. */
  allowInstall: () => Promise<void>;
  setUpdate: (s: UpdateStatus) => void;
  /** Registers what the back button closes before it leaves the screen (an edit mode); returns
   *  the function that removes it again. The last one registered closes first. */
  onBack: (close: () => void) => () => void;
}

export const Ctx = createContext<MobileContext | null>(null);

export function useMobile(): MobileContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMobile outside MobileApp");
  return c;
}

/** While `active`, Android's back button calls `close` before it leaves the screen. */
export function useBackLayer(active: boolean, close: () => void) {
  const { onBack } = useMobile();
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => (active ? onBack(() => latest.current()) : undefined), [active, onBack]);
}

/** The message of a rejected command. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));
