// Text shared to the iOS app („Teilen“ → Arcalo, a Markdown or text file, a shortcut with
// `arcalo://capture?text=…`) while the full app shows: it goes into the inbox, as the quick capture
// of the desktop puts it there (src-tauri/src/mobile/ios.rs keeps it until the page asks). The
// phone app opens a capture with it instead (mobile/MobileApp.tsx).

import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";
import { t } from "./i18n";
import { useApp } from "../store/app";

async function take(): Promise<void> {
  const text = await invoke<string | null>("mobile_shared_text").catch(() => null);
  if (!text?.trim()) return;
  try {
    await api.captureSubmit(text, { kind: "inbox" });
    useApp.getState().toast({ tone: "success", title: t("ios.sharedToInbox") });
  } catch (e) {
    useApp.getState().error(t("ios.sharedFailed"), e);
  }
}

/** At the start and whenever the app comes back to the front (iOS opens it to share). */
export function followShared(): () => void {
  void take();
  const onVisible = () => document.visibilityState === "visible" && void take();
  document.addEventListener("visibilitychange", onVisible);
  return () => document.removeEventListener("visibilitychange", onVisible);
}
