// Windows with the app's own title bar (Settings → Darstellung): minimize, maximize/restore and
// close in the top-right corner, drawn like the system buttons. Closing goes through the normal
// close request, so „Beim Schließen in den Infobereich“ still applies.

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../lib/i18n";

export function WindowControls() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const w = getCurrentWindow();
    const sync = () => void w.isMaximized().then(setMaximized, () => {});
    sync();
    const off = w.onResized(sync);
    return () => void off.then((f) => f());
  }, []);
  const w = () => getCurrentWindow();
  return (
    <div className="window-controls" role="group" aria-label={t("win.controls")}>
      <button type="button" className="win-btn" aria-label={t("win.minimize")} title={t("win.minimize")} onClick={() => void w().minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5.5h10" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn"
        aria-label={maximized ? t("win.restore") : t("win.maximize")}
        title={maximized ? t("win.restore") : t("win.maximize")}
        onClick={() => void w().toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor">
            <path d="M2.5 2.5V.5h7v7h-2" />
            <rect x=".5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor">
            <rect x=".5" y=".5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button type="button" className="win-btn win-close" aria-label={t("win.close")} title={t("win.close")} onClick={() => void w().close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" stroke="currentColor">
          <path d="M.5.5l9 9M9.5.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
