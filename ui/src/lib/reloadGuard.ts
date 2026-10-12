// The webview reloads the page on F5, Ctrl+R and Ctrl+Shift+R (Cmd+R on macOS) by itself, also
// when no command takes the key (behind a dialog, during the setup, in the palette) or when a
// command uses it („Im Baum zeigen“ is Ctrl+Shift+R): a reload drops unsaved edits and the open
// tabs. The app never reloads from the keyboard; only the Vite dev server keeps it.

/** Whether the key event is one the webview would reload the page on. */
export function isReloadKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  if (e.key === "F5") return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "r";
}

/** Keeps the webview from reloading on its keys; the app's own handlers still see them. */
export function installReloadGuard(target: Pick<Window, "addEventListener"> = window, dev = import.meta.env.DEV): void {
  if (dev) return;
  target.addEventListener("keydown", (e) => {
    if (isReloadKey(e as KeyboardEvent)) e.preventDefault();
  });
}
