// Narrow windows have no room for the file sidebar, the note and the side panel together:
// there the open side panel takes the sidebar's place, and showing the sidebar closes the panel.

import { useSyncExternalStore } from "react";
import { useApp, savePref } from "../store/app";

/** Below this window width the sidebar and the side panel are not shown together. */
export const NARROW_PX = 1060;

const isNarrow = () => window.innerWidth < NARROW_PX;

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
