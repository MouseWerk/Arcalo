// Generic keyboard-driven popup for TipTap suggestions ([[links]] and /commands).

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import { t } from "../lib/i18n";
import { isComposing } from "../lib/ime";
import { consumeKey } from "../lib/keymap";

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
  /** The editor the list belongs to: it carries the combobox state for screen readers. */
  owner?: HTMLElement;
}

/** Screen reader state of an editor while a suggestion list is open (the list keeps the caret in the text). */
export function ownerAria(listId: string, sel: number | null): Record<string, string | null> {
  return {
    "aria-expanded": "true",
    "aria-controls": listId,
    "aria-autocomplete": "list",
    "aria-activedescendant": sel === null ? null : `${listId}-${sel}`,
  };
}
const OWNER_ATTRS = ["aria-expanded", "aria-controls", "aria-autocomplete", "aria-activedescendant"];

/** One polite region for the chosen item: WebKitGTK does not read aria-activedescendant on a text field. */
function announce(text: string) {
  let live = document.getElementById("sugg-live");
  if (!live) {
    live = document.createElement("div");
    live.id = "sugg-live";
    live.className = "sr-only";
    live.setAttribute("aria-live", "polite");
    document.body.appendChild(live);
  }
  live.textContent = text;
}

export const SuggestionPopup = forwardRef<PopupHandle, PopupProps>(({ items, command, empty, className, owner }, ref) => {
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const listId = `sugg-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  useEffect(() => setSel(0), [items]);
  useEffect(() => {
    list.current?.querySelector(".sugg-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  // The editor says a list is open and which entry Enter takes.
  useEffect(() => {
    if (!owner) return;
    for (const [k, v] of Object.entries(ownerAria(listId, items[sel] ? sel : null))) {
      if (v === null) owner.removeAttribute(k);
      else owner.setAttribute(k, v);
    }
    if (items[sel]) announce(items[sel].subtitle ? `${items[sel].title}, ${items[sel].subtitle}` : items[sel].title);
  }, [owner, listId, items, sel]);
  useEffect(() => {
    if (!owner) return;
    return () => {
      OWNER_ATTRS.forEach((a) => owner.removeAttribute(a));
      owner.setAttribute("aria-expanded", "false");
    };
  }, [owner]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (isComposing(event)) return false;
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
    <div className={className ? `sugg ${className}` : "sugg"} ref={list} role="listbox" id={listId} aria-label={t("sugg.label")}>
      {items.length === 0 && <div className="sugg-empty">{empty ?? t("sugg.none")}</div>}
      {items.map((it, i) => {
        const header = it.section && it.section !== lastSection ? it.section : null;
        lastSection = it.section;
        return (
          <div key={it.id}>
            {header && <div className="sugg-section">{header}</div>}
            <button
              type="button"
              role="option"
              id={`${listId}-${i}`}
              tabIndex={-1}
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
export function popupRenderer<I extends PopupItem>(emptyText?: string | (() => string) | null, className?: string): SuggestionOptions<I>["render"] {
  // A function is read on every render, so the text follows the display language.
  const text = () => (typeof emptyText === "function" ? emptyText() : emptyText);
  const empty = emptyText === null ? null : "";
  return () => {
    let renderer: ReactRenderer<PopupHandle, PopupProps> | null = null;
    let host: HTMLDivElement | null = null;
    let owner: HTMLElement | undefined;
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
        owner = props.editor.view.dom;
        renderer = new ReactRenderer(SuggestionPopup, {
          editor: props.editor,
          props: { items: props.items, command: props.command as (i: PopupItem) => void, empty: text() ?? undefined, className, owner },
        });
        host.appendChild(renderer.element);
        requestAnimationFrame(() => place(props));
      },
      onUpdate: (props) => {
        renderer?.updateProps({ items: props.items, command: props.command as (i: PopupItem) => void, empty: text() ?? undefined, className, owner });
        requestAnimationFrame(() => place(props));
      },
      onKeyDown: (props) => {
        if (isComposing(props.event)) return false;
        // Dismissed with Escape: the keys belong to the text again (Enter makes a line, a
        // second Escape ends the focus mode) until the suggestion ends.
        if (!renderer) return false;
        if (props.event.key === "Escape") {
          consumeKey(props.event);
          renderer.destroy();
          renderer = null;
          host?.remove();
          return true;
        }
        return renderer.ref?.onKeyDown(props) ?? false;
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
