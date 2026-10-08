// What every screen of the companion app gets: the settings, navigation, toasts and a data
// version that grows whenever bookings, pages or the sync changed something.

import { createContext, useContext } from "react";
import type { Screen, Tab } from "./model";
import type { Settings, SettingsView } from "../lib/types";

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
}

export const Ctx = createContext<MobileContext | null>(null);

export function useMobile(): MobileContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("useMobile outside MobileApp");
  return c;
}

/** The message of a rejected command. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));
