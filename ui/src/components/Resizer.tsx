// Drag handle for resizable areas (sidebars and split panes).

import { useRef } from "react";
import { t } from "../lib/i18n";

export function readSize(key: string, fallback: number) {
  try {
    const v = Number(localStorage.getItem(key));
    return v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A vertical splitter. `onResize` receives the horizontal delta in pixels
 * since the drag started; `onEnd` fires once when the pointer is released.
 */
export function Resizer({
  onResize,
  onEnd,
  onReset,
  label,
  className = "",
}: {
  onResize: (dx: number) => void;
  onEnd?: () => void;
  onReset?: () => void;
  label: string;
  className?: string;
}) {
  const start = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={t("resizer.title", { label })}
      className={`resizer ${className}`}
      onPointerDown={(e) => {
        e.preventDefault();
        start.current = e.clientX;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (start.current == null) return;
        onResize(e.clientX - start.current);
      }}
      onPointerUp={(e) => (e.target as HTMLElement).releasePointerCapture(e.pointerId)}
      onLostPointerCapture={() => {
        if (start.current == null) return;
        start.current = null;
        document.body.classList.remove("resizing");
        onEnd?.();
      }}
      onDoubleClick={onReset}
    />
  );
}
