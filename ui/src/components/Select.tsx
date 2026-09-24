// Dropdown in the app's design language instead of the native <select> (whose popup on
// Windows is a plain grey list in the system font). Same API as a controlled <select>:
// `value`, `onChange={(e) => e.target.value}` and <option>/<optgroup> children, or `options`
// with icons, descriptions, groups and separators.
//
// A combobox button opens a listbox in a portal (above dialogs), anchored below the trigger
// with at least its width, flipped above near the bottom of the window. Keyboard: arrows,
// Home/End, PageUp/PageDown, Enter/Space choose, Escape and Tab close, typing jumps to the
// first option starting with the typed letters (also while closed, like a native select).

import { Children, Fragment, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, type LucideIcon } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
  icon?: LucideIcon;
  description?: string;
  disabled?: boolean;
  /** Heading above this option (starts a group). */
  group?: string;
  /** A line above this option. */
  separator?: boolean;
}

/** What `onChange` receives: shaped like a change event of a native select. */
export interface SelectChange {
  target: { value: string };
  currentTarget: { value: string };
}

export interface SelectProps {
  value: string | number | null | undefined;
  onChange?: (e: SelectChange) => void;
  options?: SelectOption[];
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  title?: string;
  placeholder?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean;
}

/** Plain text of option children. */
function text(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(text).join("");
  if (isValidElement(n)) return text((n.props as { children?: ReactNode }).children);
  return "";
}

/** <option>, <optgroup> and <hr> children (also inside fragments and arrays) as options. */
export function optionsFromChildren(children: ReactNode, group?: string): SelectOption[] {
  const out: SelectOption[] = [];
  let pendingGroup = group;
  let pendingSep = false;
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue;
    const el = child as ReactElement<Record<string, unknown>>;
    if (el.type === Fragment) {
      out.push(...optionsFromChildren(el.props.children as ReactNode, pendingGroup));
      pendingGroup = undefined;
    } else if (el.type === "optgroup") {
      const inner = optionsFromChildren(el.props.children as ReactNode);
      if (inner[0]) inner[0] = { ...inner[0], group: String(el.props.label ?? "") };
      out.push(...inner.map((o) => ({ ...o, disabled: o.disabled || !!el.props.disabled })));
    } else if (el.type === "hr") {
      pendingSep = true;
    } else if (el.type === "option") {
      const label = text(el.props.children as ReactNode);
      const value = el.props.value == null ? label : String(el.props.value);
      out.push({ value, label, disabled: !!el.props.disabled, ...(pendingGroup ? { group: pendingGroup } : {}), ...(pendingSep ? { separator: true } : {}) });
      pendingGroup = undefined;
      pendingSep = false;
    }
  }
  return out;
}

/** Index of the next enabled option from `from` in direction `dir` (wraps only when asked). */
export function step(options: SelectOption[], from: number, dir: 1 | -1, wrap = false): number {
  const n = options.length;
  for (let k = 1; k <= n; k++) {
    let i = from + dir * k;
    if (wrap) i = (i + n) % n;
    if (i < 0 || i >= n) break;
    if (!options[i].disabled) return i;
  }
  return from;
}

/** First enabled option whose label starts with `typed` (case and accents ignored), searching after `from`. */
export function typeAhead(options: SelectOption[], typed: string, from: number): number {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = fold(typed);
  if (!q) return -1;
  // Repeating one letter cycles through the options with that letter.
  const same = [...q].every((ch) => ch === q[0]);
  const n = options.length;
  const start = same && q.length > 1 ? from + 1 : q.length === 1 ? from + 1 : from;
  for (let k = 0; k < n; k++) {
    const i = (start + k + n) % n;
    const o = options[i];
    if (o.disabled) continue;
    const label = fold(o.label.trim());
    if (same && q.length > 1 ? label.startsWith(q[0]) : label.startsWith(q)) return i;
  }
  return -1;
}

const GAP = 4;
const MARGIN = 8;

export function Select({ value, onChange, options, children, disabled, className = "", id, title, placeholder, ...aria }: SelectProps) {
  const items = useMemo(() => options ?? optionsFromChildren(children), [options, children]);
  const current = value == null ? "" : String(value);
  const selected = items.findIndex((o) => o.value === current);
  const shown = items[selected];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const activeRef = useRef(-1);
  const highlight = (i: number) => {
    activeRef.current = i;
    setActive(i);
  };
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number; maxHeight?: number; above: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId().replace(/:/g, "") + "-list";

  const choose = (i: number) => {
    const o = items[i];
    if (!o || o.disabled) return;
    setOpen(false);
    if (o.value !== current) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } });
  };
  const show = () => {
    if (disabled || !items.length) return;
    typed.current.text = "";
    highlight(selected >= 0 && !items[selected].disabled ? selected : step(items, -1, 1));
    setOpen(true);
  };
  const typeKey = (key: string, from: number): number => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > 700 ? key : t.text + key;
    t.at = now;
    return typeAhead(items, t.text, from);
  };

  // Placement: below the trigger (at least as wide), above it when there is more room there.
  useLayoutEffect(() => {
    if (!open) return setPos(null);
    const el = pop.current;
    const r = trigger.current?.getBoundingClientRect();
    if (!el || !r) return;
    el.style.maxHeight = "";
    const natural = el.offsetHeight;
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const up = natural > below && above > below;
    const room = Math.max(120, up ? above : below);
    const height = Math.min(natural, room);
    const width = Math.max(r.width, el.offsetWidth);
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - width - MARGIN));
    setPos({ left, top: up ? r.top - GAP - height : r.bottom + GAP, minWidth: r.width, maxHeight: natural > room ? room : undefined, above: up });
  }, [open]);

  // The selected option is in view when the list opens; the active one while moving.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    pop.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, pos, active]);

  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (pop.current?.contains(t) || trigger.current?.contains(t));
    const onDown = (e: MouseEvent) => !inside(e.target) && setOpen(false);
    const onScroll = (e: Event) => !(e.target instanceof Node && pop.current?.contains(e.target)) && setOpen(false);
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      const stop = () => (e.preventDefault(), e.stopPropagation());
      // Keys can come faster than renders: the highlighted option is read from the ref.
      const at = activeRef.current;
      const jump = (dir: 1 | -1, n: number) => {
        let j = at;
        for (let k = 0; k < n; k++) j = step(items, j, dir);
        return j;
      };
      switch (e.key) {
        case "Escape":
          stop();
          setOpen(false);
          trigger.current?.focus();
          return;
        case "Tab":
          setOpen(false);
          return;
        case "ArrowDown":
          stop();
          return highlight(jump(1, 1));
        case "ArrowUp":
          stop();
          return e.altKey ? choose(at) : highlight(jump(-1, 1));
        case "Home":
          stop();
          return highlight(step(items, -1, 1));
        case "End":
          stop();
          return highlight(step(items, items.length, -1));
        case "PageDown":
          stop();
          return highlight(jump(1, 8));
        case "PageUp":
          stop();
          return highlight(jump(-1, 8));
        case "Enter":
          stop();
          return choose(at);
        case " ":
          stop();
          // A space inside a typed search belongs to it.
          if (typed.current.text && Date.now() - typed.current.at < 700) {
            const i = typeKey(" ", at);
            if (i >= 0) highlight(i);
          } else choose(at);
          return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        stop();
        const i = typeKey(e.key, at);
        if (i >= 0) highlight(i);
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  });

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open || disabled) return;
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      show();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Closed: typing picks the matching option right away, like a native select.
      e.preventDefault();
      const i = typeKey(e.key, selected);
      if (i >= 0) choose(i);
    }
  };

  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        id={id}
        title={title}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        data-value={current}
        className={`input select ${open ? "open" : ""} ${className}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onTriggerKey}
        {...aria}
      >
        {shown?.icon && <shown.icon size={14} strokeWidth={1.75} className="select-icon" aria-hidden />}
        {/* Every label sits in one grid cell: the button is as wide as the longest option, as a native select is. */}
        <span className="select-value">
          <span className={`select-label ${shown ? "" : "placeholder"}`}>{shown?.label ?? placeholder ?? ""}</span>
          {items.map((o) => (
            <span key={o.value} className="select-sizer" aria-hidden>
              {o.label}
            </span>
          ))}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            id={listId}
            role="listbox"
            aria-label={aria["aria-label"]}
            className={`select-pop ${pos?.above ? "above" : ""}`}
            style={pos ? { left: pos.left, top: pos.top, minWidth: pos.minWidth, maxHeight: pos.maxHeight } : { left: 0, top: 0, visibility: "hidden" }}
            // The trigger keeps the focus (and an editor its selection).
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.map((o, i) => (
              <Fragment key={`${o.value}-${i}`}>
                {o.separator && i > 0 && <div className="select-sep" role="separator" />}
                {o.group && <div className="select-group" role="presentation">{o.group}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  data-index={i}
                  data-value={o.value}
                  aria-selected={i === selected}
                  aria-disabled={o.disabled || undefined}
                  className={`select-option ${i === active ? "active" : ""} ${i === selected ? "selected" : ""} ${o.disabled ? "disabled" : ""}`}
                  onMouseMove={() => !o.disabled && active !== i && highlight(i)}
                  onClick={() => choose(i)}
                >
                  <span className="select-check">{i === selected && <Check size={14} strokeWidth={2.25} />}</span>
                  {o.icon && <o.icon size={14} strokeWidth={1.75} className="select-option-icon" aria-hidden />}
                  <span className="select-option-text">
                    <span className="select-option-label">{o.label}</span>
                    {o.description && <span className="select-option-desc">{o.description}</span>}
                  </span>
                </div>
              </Fragment>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
