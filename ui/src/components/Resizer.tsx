// Drag handle for resizable areas (sidebars and split panes).

import { useRef } from "react";
import { t } from "../lib/i18n";
import { isComposing } from "../lib/ime";

export function readSize(key: string, fallback: number) {
  try {
    const v = Number(localStorage.getItem(key));
    return v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Arrow steps of a focused splitter in pixels (Shift: a bigger one). */
export const RESIZE_STEP = 16;
export const RESIZE_STEP_BIG = 64;

/** What a key does to a focused splitter: a move by `dx`, a reset, or nothing. */
export function resizeKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"> & { keyCode?: number; isComposing?: boolean }): { dx: number } | "reset" | null {
  if (isComposing(e)) return null;
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const step = e.shiftKey ? RESIZE_STEP_BIG : RESIZE_STEP;
  if (e.key === "ArrowLeft") return { dx: -step };
  if (e.key === "ArrowRight") return { dx: step };
  if (e.key === "Enter" || e.key === "Home") return "reset";
  return null;
}

/**
 * A vertical splitter. `onResize` receives the horizontal delta in pixels
 * since the drag started; `onEnd` fires once when the pointer is released.
 * From the keyboard ←/→ move it (Shift: further), Enter or Home reset it.
 */
export function Resizer({
  onResize,
  onEnd,
  onReset,
  label,
  className = "",
  value,
  min,
  max,
}: {
  onResize: (dx: number) => void;
  onEnd?: () => void;
  onReset?: () => void;
  label: string;
  className?: string;
  /** The current size (and its limits) for screen readers, in pixels or percent. */
  value?: number;
  min?: number;
  max?: number;
}) {
  const start = useRef<number | null>(null);
  const keyed = useRef(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value != null ? Math.round(value) : undefined}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={t("resizer.title", { label })}
      className={`resizer ${className}`}
      onKeyDown={(e) => {
        const k = resizeKey(e);
        if (!k) return;
        e.preventDefault();
        if (k === "reset") return onReset?.();
        // One step is a whole drag: from the current size, done when the key comes up (the size
        // is stored after it was drawn). A held key moves on with the size it reached.
        if (keyed.current) onEnd?.();
        onResize(k.dx);
        keyed.current = true;
      }}
      onKeyUp={() => {
        if (!keyed.current) return;
        keyed.current = false;
        onEnd?.();
      }}
      onBlur={() => {
        if (!keyed.current) return;
        keyed.current = false;
        onEnd?.();
      }}
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
