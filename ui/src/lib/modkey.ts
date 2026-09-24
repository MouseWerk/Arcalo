// Marks the document while Ctrl (⌘ on macOS) is held, so links in notes show the hand cursor
// that tells they open on click (Ctrl+click opens a web link, a plain click edits it).

export function trackModKey() {
  const root = document.documentElement;
  const set = (on: boolean) => root.classList.toggle("mod-held", on);
  window.addEventListener("keydown", (e) => (e.key === "Control" || e.key === "Meta") && set(true));
  window.addEventListener("keyup", (e) => (e.key === "Control" || e.key === "Meta") && set(false));
  // Moving the mouse also tells the state (the key may have gone down in another window).
  window.addEventListener("mousemove", (e) => set(e.ctrlKey || e.metaKey), { passive: true });
  window.addEventListener("blur", () => set(false));
}
