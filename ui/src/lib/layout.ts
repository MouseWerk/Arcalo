// Narrow windows have no room for the file sidebar, the note and the side panel together:
// there the open side panel takes the sidebar's place, and showing the sidebar closes the panel.

import { useEffect, useSyncExternalStore } from "react";
import { useApp, savePref } from "../store/app";

/** Below this window width the sidebar and the side panel are not shown together. */
export const NARROW_PX = 1060;

const isNarrow = () => window.innerWidth < NARROW_PX;

/** Below this window width the side panel closes by itself (Ctrl+J opens it again). */
export const COMPACT_PX = 1000;

/**
 * What a window width change does to the side panel: `close` when it gets compact (or starts
 * so) with the panel open, `reopen` when it gets wide again after closing it that way.
 */
export function compactStep(before: number | null, after: number, panelOpen: boolean, autoClosed: boolean): "close" | "reopen" | null {
  const was = before != null && before < COMPACT_PX;
  const is = after < COMPACT_PX;
  if (is && !was && panelOpen) return "close";
  if (!is && was && autoClosed && !panelOpen) return "reopen";
  return null;
}

/** Closes the side panel in compact windows (the stored choice stays for wide ones). */
export function useCompactPanel() {
  useEffect(() => {
    let last: number | null = null;
    let autoClosed = false;
    const check = () => {
      const st = useApp.getState();
      const w = window.innerWidth;
      const step = compactStep(last, w, st.panelOpen, autoClosed);
      if (step === "close") {
        st.set({ panelOpen: false });
        autoClosed = true;
      } else if (step === "reopen") {
        st.set({ panelOpen: true });
        autoClosed = false;
      } else if (w < COMPACT_PX && st.panelOpen) {
        autoClosed = false; // opened again by hand
      }
      last = w;
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
}

export function useNarrowWindow(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener("resize", l);
      return () => window.removeEventListener("resize", l);
    },
    isNarrow,
  );
}

/** Whether the sidebar is on screen (it gives way to the panel in narrow windows). */
export function sidebarShown(sidebarOpen: boolean, panelShown: boolean, narrow: boolean) {
  return sidebarOpen && !(narrow && panelShown);
}

/** The sidebar button: in a narrow window with the panel open it brings the sidebar back instead. */
export function toggleSidebar() {
  const st = useApp.getState();
  if (isNarrow() && st.panelOpen && st.sidebarOpen) {
    st.set({ panelOpen: false });
    savePref("annalo.panel", false);
    return;
  }
  st.set({ sidebarOpen: !st.sidebarOpen });
  savePref("annalo.sidebar", !st.sidebarOpen);
}
