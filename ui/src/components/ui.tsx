// Small, dependency-free UI primitives in the app's design language.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, Loader2, X, type LucideIcon } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  loading,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; icon?: LucideIcon; loading?: boolean }) {
  return (
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest} disabled={rest.disabled || loading}>
      {loading ? <Loader2 size={14} className="spin" /> : Icon ? <Icon size={14} strokeWidth={2} aria-hidden /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

/** The three icon button sizes: row actions and chips, headers and toolbars, the ribbon. */
const ICON_BTN = { sm: { box: 22, icon: 13 }, md: { box: 28, icon: 15 }, lg: { box: 32, icon: 17 } } as const;
export type IconButtonSize = keyof typeof ICON_BTN;

export function IconButton({
  icon: Icon,
  label,
  active,
  size = "md",
  iconSize,
  tooltipSide = "bottom",
  className = "",
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  /** A named size; a pixel box is still accepted for special cases. */
  size?: IconButtonSize | number;
  iconSize?: number;
  tooltipSide?: "bottom" | "top" | "right" | "left";
}) {
  const named = typeof size === "string" ? ICON_BTN[size] : null;
  return (
    <button
      type="button"
      aria-label={label}
      data-tooltip={label}
      data-tooltip-side={tooltipSide}
      className={`icon-btn ${named ? `icon-btn-${size}` : ""} ${active ? "active" : ""} ${className}`}
      style={named ? style : { width: size, height: size, ...style }}
      {...rest}
    >
      <Icon size={iconSize ?? named?.icon ?? 16} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} spellCheck={false} {...rest} />;
}

/** `autoGrow`: as tall as its text (up to a limit in CSS), so no line is cut off mid-sentence. */
export function TextArea({ className = "", autoGrow, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { autoGrow?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [autoGrow, rest.value]);
  return <textarea ref={ref} className={`input textarea ${autoGrow ? "textarea-auto" : ""} ${className}`} {...rest} />;
}

/** Dropdown with the API of a controlled <select> (components/Select.tsx). */
export { Select, type SelectOption, type SelectChange } from "./Select";

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

export function Field({ label, hint, children, inline }: { label: string; hint?: ReactNode; children: ReactNode; inline?: boolean }) {
  return (
    <label className={`field ${inline ? "field-inline" : ""}`}>
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Progress({ value, tone = "accent", marker }: { value: number; tone?: Tone; marker?: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill tone-${tone}`} style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%` }} />
      {marker != null && marker > 0 && <div className="progress-marker" style={{ left: `${Math.min(marker, 1) * 100}%` }} />}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={20} strokeWidth={1.5} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin faint" aria-label="Lädt" />;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>("[data-autofocus], input, textarea, select, button.btn-primary");
      first?.focus();
    }, 20);
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      // A newer dialog (a confirm on top) or a menu/calendar opened from this one handles its own keys.
      const above = [...document.querySelectorAll(".dialog, .menu, .calendar, .select-pop")].some((el) => el !== box && !box?.contains(el) && !!(box && box.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (above) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab" && box) {
        // Focus stays inside the dialog: Tab from the last control wraps to the first and back.
        const all = [...box.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], summary, [tabindex]")].filter(
          (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.offsetParent !== null,
        );
        if (!all.length) return;
        const first = all[0];
        const last = all[all.length - 1];
        const inside = box.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && (document.activeElement === last || !inside)) (e.preventDefault(), first.focus());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref} style={{ width }}>
        <div className="dialog-head">
          <div>
            <div className="dialog-title">{title}</div>
            {description && <div className="dialog-desc">{description}</div>}
          </div>
          <IconButton icon={X} label="Schließen" onClick={onClose} />
        </div>
        {children && <div className="dialog-body">{children}</div>}
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------ context menu

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  submenu?: MenuItem[];
}
export type MenuEntry = MenuItem | "separator";

/** Gap between a trigger and the menu it opens. */
export const MENU_GAP = 4;

type Box = { left: number; right: number; top: number; bottom: number };

/** Where a menu opened from `anchor` goes: below it and left-aligned; right-aligned near the right edge, above it near the bottom. */
export function anchorMenu(anchor: Box, size: { width: number; height: number }, view: { width: number; height: number }) {
  const x = anchor.left + size.width > view.width - 8 ? anchor.right - size.width : anchor.left;
  const below = anchor.bottom + MENU_GAP;
  const above = anchor.top - MENU_GAP - size.height;
  const y = below + size.height > view.height - 8 && above >= 8 ? above : below;
  return { x: Math.max(8, Math.min(x, view.width - size.width - 8)), y: Math.max(8, Math.min(y, view.height - size.height - 8)) };
}

export function Menu({
  x,
  y,
  items,
  onClose,
  onBack,
  flipX,
  anchor,
  preselect,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
  /** Set on a submenu: closes only this level (Escape, ArrowLeft). */
  onBack?: () => void;
  /** Where a submenu goes when there is no room on the right: the parent item's left edge. */
  flipX?: number;
  /** The trigger's rect: the menu opens below it instead of at x/y. */
  anchor?: Box;
  /** Highlight the first item right away (the menu was opened from the keyboard). */
  preselect?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // An anchored menu is measured at the left edge first, where nothing squeezes it.
  const [pos, setPos] = useState(anchor ? { x: 0, y: 0 } : { x, y });
  const [sel, setSel] = useState(onBack || preselect ? firstActionable(items) : -1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; left: number } | null>(null);
  const actionable = items.map((it, i) => (it !== "separator" && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Layout size: the pop-in animation scales the box, which getBoundingClientRect would include.
    const r = { width: el.offsetWidth, height: el.offsetHeight };
    if (anchor) return setPos(anchorMenu(anchor, r, { width: window.innerWidth, height: window.innerHeight }));
    const nx = x + r.width > window.innerWidth - 8 && flipX != null ? Math.max(8, flipX - r.width) : Math.min(x, window.innerWidth - r.width - 8);
    setPos({ x: nx, y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y, flipX, anchor]);

  const openSub = (i: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setSub({ index: i, x: r.right - 2, y: r.top - 5, left: r.left + 2 });
  };

  useEffect(() => {
    // Clicks inside any menu level are not "outside"; the submenu lives in its own portal.
    const onDown = (e: MouseEvent) => !(e.target instanceof Element && e.target.closest(".menu")) && onClose();
    const onKey = (e: KeyboardEvent) => {
      if (sub) return; // the open submenu handles the keyboard
      if (e.key === "Escape" || (e.key === "ArrowLeft" && onBack)) {
        e.preventDefault();
        e.stopPropagation();
        (onBack ?? onClose)();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = actionable.indexOf(sel);
        const next = e.key === "ArrowDown" ? actionable[(i + 1) % actionable.length] : actionable[(i - 1 + actionable.length) % actionable.length];
        setSel(next);
      } else if ((e.key === "Enter" || e.key === "ArrowRight") && sel >= 0) {
        const it = items[sel];
        if (it === "separator") return;
        e.preventDefault();
        if (it.submenu) openSub(sel);
        else if (e.key === "Enter") {
          onClose();
          it.onSelect?.();
        }
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  });
  const subItems = sub ? (items[sub.index] as MenuItem).submenu : undefined;
  return createPortal(
    <>
      <div className="menu" role="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
        {items.map((it, i) =>
          it === "separator" ? (
            <div key={i} className="menu-sep" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              data-index={i}
              aria-haspopup={it.submenu ? "menu" : undefined}
              aria-expanded={it.submenu ? sub?.index === i : undefined}
              disabled={it.disabled}
              className={`menu-item ${it.danger ? "danger" : ""} ${sel === i ? "sel" : ""} ${sub?.index === i ? "open" : ""}`}
              onMouseEnter={() => {
                setSel(i);
                if (it.submenu) openSub(i);
                else setSub(null);
              }}
              onClick={() => {
                if (it.submenu) return openSub(i);
                onClose();
                it.onSelect?.();
              }}
            >
              <span className="menu-icon">{it.checked ? <Check size={14} /> : it.icon ? <it.icon size={14} strokeWidth={1.75} /> : null}</span>
              <span className="menu-label">{it.label}</span>
              {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
              {it.submenu && <ChevronRight size={14} className="faint" />}
            </button>
          ),
        )}
      </div>
      {sub && subItems && <Menu key={sub.index} x={sub.x} y={sub.y} flipX={sub.left} items={subItems} onClose={onClose} onBack={() => setSub(null)} />}
    </>,
    document.body,
  );
}

function firstActionable(items: MenuEntry[]): number {
  return items.findIndex((it) => it !== "separator" && !it.disabled);
}

type Trigger = { currentTarget: EventTarget | null; detail?: number; preventDefault?: () => void };

/**
 * State helper for menus: `const [menu, openMenu, openMenuAt] = useMenu()`.
 * `openMenu` opens at the pointer (context menus). `openMenuAt` opens below the trigger
 * (an element, or the event whose currentTarget it is) and highlights the first item when
 * the trigger was used from the keyboard (key events and clicks with detail 0).
 */
export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[]; anchor?: Box; preselect?: boolean } | null>(null);
  const open = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) => {
    e.preventDefault?.();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const openAt = (target: Element | Trigger, items: MenuEntry[], opts: { keyboard?: boolean } = {}) => {
    const event = target instanceof Element ? null : target;
    const el = event ? event.currentTarget : target;
    if (!(el instanceof Element)) return;
    event?.preventDefault?.();
    const r = el.getBoundingClientRect();
    const anchor = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    setMenu({ x: r.left, y: r.bottom + MENU_GAP, items, anchor, preselect: opts.keyboard ?? event?.detail === 0 });
  };
  const node = menu ? <Menu x={menu.x} y={menu.y} anchor={menu.anchor} preselect={menu.preselect} items={menu.items} onClose={() => setMenu(null)} /> : null;
  return [node, open, openAt] as const;
}
