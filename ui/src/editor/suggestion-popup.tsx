// Generic keyboard-driven popup for TipTap suggestions ([[links]] and /commands).

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";

export interface PopupItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  hint?: string;
  section?: string;
}

export interface PopupHandle {
  onKeyDown: (p: SuggestionKeyDownProps) => boolean;
}

interface PopupProps {
  items: PopupItem[];
  command: (item: PopupItem) => void;
  empty?: string;
  /** Extra class on the list, e.g. `zeit` for the wider /zeit popup. */
  className?: string;
}

export const SuggestionPopup = forwardRef<PopupHandle, PopupProps>(({ items, command, empty, className }, ref) => {
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => setSel(0), [items]);
  useEffect(() => {
    list.current?.querySelector(".sugg-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") {
        setSel((s) => (s + 1) % items.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setSel((s) => (s - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        command(items[sel]);
        return true;
      }
      return false;
    },
  }));
  let lastSection: string | undefined;
  return (
    <div className={className ? `sugg ${className}` : "sugg"} ref={list} role="listbox">
      {items.length === 0 && <div className="sugg-empty">{empty ?? "Keine Treffer"}</div>}
      {items.map((it, i) => {
        const header = it.section && it.section !== lastSection ? it.section : null;
        lastSection = it.section;
        return (
          <div key={it.id}>
            {header && <div className="sugg-section">{header}</div>}
            <button
              type="button"
              role="option"
              aria-selected={i === sel}
              className={`sugg-item ${i === sel ? "sel" : ""}`}
              // Only a moving mouse selects: items that move under a resting pointer while typing do not.
              onMouseMove={() => i !== sel && setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                command(it);
              }}
            >
              {it.icon && <span className="sugg-icon">{it.icon}</span>}
              <span className="sugg-text">
                <span className="sugg-title">{it.title}</span>
                {it.subtitle && <span className="sugg-sub">{it.subtitle}</span>}
              </span>
              {it.hint && <span className="sugg-hint">{it.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
});

/**
 * Mounts a SuggestionPopup next to the caret and forwards keyboard events.
 * With `empty === null` the popup hides while nothing matches (and keys pass through).
 */
export function popupRenderer<I extends PopupItem>(empty?: string | null, className?: string): SuggestionOptions<I>["render"] {
  return () => {
    let renderer: ReactRenderer<PopupHandle, PopupProps> | null = null;
    let host: HTMLDivElement | null = null;
    const place = (props: SuggestionProps<I>) => {
      if (!host) return;
      host.style.display = empty === null && !props.items.length ? "none" : "";
      const rect = props.clientRect?.();
      if (!rect) return;
      const h = host.offsetHeight || 280;
      const below = rect.bottom + 6 + h < window.innerHeight;
      const w = host.offsetWidth || 340;
      host.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - w - 20))}px`;
      host.style.top = below ? `${rect.bottom + 6}px` : `${rect.top - h - 6}px`;
    };
    return {
      onStart: (props) => {
        host = document.createElement("div");
        host.className = "sugg-host";
        document.body.appendChild(host);
        renderer = new ReactRenderer(SuggestionPopup, {
          editor: props.editor,
          props: { items: props.items, command: props.command as (i: PopupItem) => void, empty: empty ?? undefined, className },
        });
        host.appendChild(renderer.element);
        requestAnimationFrame(() => place(props));
      },
      onUpdate: (props) => {
        renderer?.updateProps({ items: props.items, command: props.command as (i: PopupItem) => void, empty: empty ?? undefined, className });
        requestAnimationFrame(() => place(props));
      },
      onKeyDown: (props) => {
        if (props.event.key === "Escape") {
          host?.remove();
          return true;
        }
        return renderer?.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        renderer?.destroy();
        host?.remove();
        renderer = null;
        host = null;
      },
    };
  };
}
