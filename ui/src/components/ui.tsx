// Small, dependency-free UI primitives in the app's design language.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
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

export function IconButton({
  icon: Icon,
  label,
  active,
  size = 28,
  iconSize = 16,
  tooltipSide = "bottom",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  size?: number;
  iconSize?: number;
  tooltipSide?: "bottom" | "top" | "right" | "left";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-tooltip={label}
      data-tooltip-side={tooltipSide}
      className={`icon-btn ${active ? "active" : ""} ${className}`}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon size={iconSize} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} spellCheck={false} {...rest} />;
}

export function TextArea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input textarea ${className}`} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`input select ${className}`} {...rest}>
      {children}
    </select>
  );
}

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
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
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

export function Menu({
  x,
  y,
  items,
  onClose,
  onBack,
  flipX,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
  /** Set on a submenu: closes only this level (Escape, ArrowLeft). */
  onBack?: () => void;
  /** Where a submenu goes when there is no room on the right: the parent item's left edge. */
  flipX?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sel, setSel] = useState(onBack ? firstActionable(items) : -1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; left: number } | null>(null);
  const actionable = items.map((it, i) => (it !== "separator" && !it.disabled ? i : -1)).filter((i) => i >= 0);

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const nx = x + r.width > window.innerWidth - 8 && flipX != null ? Math.max(8, flipX - r.width) : Math.min(x, window.innerWidth - r.width - 8);
    setPos({ x: nx, y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y, flipX]);

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

/** State helper for context menus: `const [menu, openMenu, closeMenu] = useMenu()`. */
export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const open = (e: { clientX: number; clientY: number; preventDefault?: () => void }, items: MenuEntry[]) => {
    e.preventDefault?.();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const node = menu ? <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null;
  return [node, open] as const;
}
