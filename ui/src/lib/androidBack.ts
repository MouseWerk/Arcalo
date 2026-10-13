// Android's back button (and gesture) in the full app (1.20): it closes what is open in front (a
// dialog, the palette, a menu or a popover, as Escape does) and otherwise sends the app to the
// background, as Android apps do; it never quits the app, which would start cold next time (the
// phone app does the same with its screens, mobile/model.ts `backAction`).

import { modalLayer } from "./keymap";

/** What is open in front: closed by Escape (menus, the date picker, a dropdown's list, the
 *  popovers and overlays that are dialogs: PDF viewer, drawing, presentation, inline AI). */
const FRONT = ".menu, .calendar, .select-pop, [role='dialog']";

/** What the back button does now. */
export function backTarget(doc: Document = document): "escape" | "background" {
  if (modalLayer(doc)) return "escape";
  return [...doc.querySelectorAll(FRONT)].some((el) => !el.closest("[hidden]")) ? "escape" : "background";
}

/** Sends Escape where the keys go (the focused element, else the page). */
export function pressEscape(doc: Document = document): void {
  const at = (doc.activeElement as HTMLElement | null) ?? doc.body;
  at.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
}

/** Listens to Android's back button; returns the clean-up. */
export function installAndroidBack(toBackground: () => Promise<unknown>): () => void {
  const listener = import("@tauri-apps/api/app").then(({ onBackButtonPress }) =>
    onBackButtonPress(() => {
      if (backTarget() === "escape") pressEscape();
      else void toBackground().catch(() => {});
    }),
  );
  return () => void listener.then((l) => l.unregister()).catch(() => {});
}
