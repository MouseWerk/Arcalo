// Small building blocks of the companion app's screens: the screen header, cards, list rows,
// segmented choices, empty states. Touch targets are at least 44 px (mobile.css).

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, X } from "lucide-react";
import { t } from "../lib/i18n";
import { useBackLayer, useMobile } from "./context";

/** The header of a screen: a back (or close) button on stacked screens, the title, actions. */
export function Header(p: { title: string; eyebrow?: string; back?: "back" | "close"; actions?: ReactNode }) {
  const { back } = useMobile();
  return (
    <header className="m-head">
      {p.back && (
        <button type="button" className="m-icon-btn m-head-back" onClick={back} aria-label={p.back === "close" ? t("common.close") : t("mob.back")}>
          {p.back === "close" ? <X size={22} /> : <ChevronLeft size={24} />}
        </button>
      )}
      <div className="m-head-titles">
        {p.eyebrow && <div className="m-eyebrow">{p.eyebrow}</div>}
        <h1 className="m-title">{p.title}</h1>
      </div>
      {p.actions && <div className="m-head-actions">{p.actions}</div>}
    </header>
  );
}

export function Section(p: { title?: string; aside?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="m-section">
      {(p.title || p.aside) && (
        <div className="m-section-head">
          {p.title && <h2 className="m-section-title">{p.title}</h2>}
          {p.aside}
        </div>
      )}
      <div className={p.flush ? "m-card m-card-flush" : "m-card"}>{p.children}</div>
    </section>
  );
}

/** A choice of a few options, one picked (the picked one has a neutral tint and weight). */
export function Segmented<V extends string>(p: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; label: string }) {
  return (
    <div className="m-seg" role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === p.value} className={o.value === p.value ? "m-seg-opt on" : "m-seg-opt"} onClick={() => p.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A choice from a longer list: a field that opens a sheet of the options from the bottom (the
 *  system's picker of a `<select>` would be a foreign Android dialog). Back and a tap beside the
 *  sheet close it without a change. */
export function Choice(p: { id?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  const picked = p.options.find((o) => o.value === p.value);
  return (
    <>
      <button id={p.id} type="button" className="m-input m-choice" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(true)}>
        <span className="m-choice-label">{picked?.label ?? p.value}</span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div className="m-choice-scrim" onClick={() => setOpen(false)}>
            <div className="m-choice-sheet" role="dialog" aria-modal="true" aria-label={p.label} onClick={(e) => e.stopPropagation()}>
              <div className="m-choice-title">{p.label}</div>
              <div className="m-choice-list" role="listbox" aria-label={p.label}>
                {p.options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={o.value === p.value}
                    className={o.value === p.value ? "m-choice-opt on" : "m-choice-opt"}
                    onClick={() => {
                      setOpen(false);
                      if (o.value !== p.value) p.onChange(o.value);
                    }}
                  >
                    <span className="m-choice-label">{o.label}</span>
                    {o.value === p.value && <Check size={18} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export function Empty(p: { icon?: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className="m-empty">
      {p.icon && <div className="m-empty-icon">{p.icon}</div>}
      <p>{p.text}</p>
      {p.action}
    </div>
  );
}

/** A notice: an icon and a tinted background (never a colored bar). Its action sits below the
 *  text, so the text keeps the width of a phone. */
export function Notice(p: { tone: "info" | "warning" | "error"; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`m-notice m-notice-${p.tone}`} role={p.tone === "error" ? "alert" : "note"}>
      <span className="m-notice-icon">{p.icon}</span>
      <div className="m-notice-body">
        {p.children}
        {p.action && <div className="m-notice-action">{p.action}</div>}
      </div>
    </div>
  );
}

export function Field(p: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="m-field">
      <label className="m-field-label" htmlFor={p.htmlFor}>
        {p.label}
      </label>
      {p.children}
      {p.hint && <div className="m-field-hint">{p.hint}</div>}
    </div>
  );
}

export function Switch(p: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  return (
    <button type="button" role="switch" aria-checked={p.checked} className="m-row m-switch-row" onClick={() => p.onChange(!p.checked)}>
      <span className="m-row-main">
        <span className="m-row-title">{p.label}</span>
        {p.desc && <span className="m-row-sub">{p.desc}</span>}
      </span>
      <span className={p.checked ? "m-switch on" : "m-switch"} aria-hidden="true">
        <span className="m-switch-knob" />
      </span>
    </button>
  );
}

export function Spinner() {
  return <span className="m-spinner" aria-hidden="true" />;
}
