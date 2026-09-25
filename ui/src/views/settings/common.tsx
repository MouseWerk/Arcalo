// Building blocks of the settings page: groups, rows (filtered by the settings search),
// number and text inputs that commit on blur.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, XCircle } from "lucide-react";
import { Badge, IconButton, Input } from "../../components/ui";
import { formatShortcut, recordShortcut } from "../../lib/shortcut";
import { IS_MAC } from "../../lib/platform";
import { useT } from "../../lib/i18n";
import type { Settings } from "../../lib/types";

export type Update = (p: Partial<Settings>) => void;
export interface SectionProps {
  draft: Settings;
  update: Update;
}

/** Search text of the settings page ("" = no filter). */
export const FilterContext = createContext("");

/** Normalized for matching: lower case, without diacritics. */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Whether a row with this text matches the search. */
export function matches(query: string, ...texts: (React.ReactNode | undefined)[]): boolean {
  if (!query.trim()) return true;
  const hay = fold(texts.map(nodeText).join(" "));
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/** Plain text of a React node (strings and nested elements). */
export function nodeText(n: React.ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(nodeText).join(" ");
  if (typeof n === "object" && "props" in n) return nodeText((n.props as { children?: React.ReactNode }).children);
  return "";
}

/**
 * Whether nothing below `ref` matches `selector` (while `active`). Re-checked on every change
 * below it: rows and groups of the search results hide themselves in their own renders.
 */
export function useNoneBelow(ref: React.RefObject<HTMLElement | null>, selector: string, active: boolean): boolean {
  const [none, setNone] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return setNone(false);
    const check = () => setNone(!el.querySelector(selector));
    check();
    const watch = new MutationObserver(check);
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
    return () => watch.disconnect();
  }, [ref, selector, active]);
  return none;
}

export function Group({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  const query = useContext(FilterContext);
  const body = useRef<HTMLDivElement>(null);
  // A matching group title shows the whole group.
  const titleHit = !!query && matches(query, title, description);
  const empty = useNoneBelow(body, ".set-row", !!query && !titleHit);
  return (
    <section className="set-group" hidden={empty} data-group={title}>
      <div className="set-group-head">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="set-group-body" ref={body}>
        <FilterContext.Provider value={titleHit ? "" : query}>{children}</FilterContext.Provider>
      </div>
    </section>
  );
}

export function Row({ label, description, children, stack, keywords }: { label: string; description?: React.ReactNode; children: React.ReactNode; stack?: boolean; keywords?: string }) {
  const query = useContext(FilterContext);
  if (!matches(query, label, description, keywords)) return null;
  return (
    <div className={`set-row ${stack ? "stack" : ""}`}>
      <div className="set-row-text">
        <div className="set-row-label">{label}</div>
        {description && <div className="set-row-desc">{description}</div>}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

/** Content that is only shown without a search (lists, notes). */
export function Unfiltered({ children }: { children: React.ReactNode }) {
  return useContext(FilterContext) ? null : <>{children}</>;
}

/** Number field that keeps what is typed and only validates and clamps on blur/Enter. */
export function NumberInput({ value, min, max, step = 1, onCommit, ...rest }: { value: number; min: number; max: number; step?: number; onCommit: (v: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "min" | "max" | "step" | "onChange">) {
  const [raw, setRaw] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setRaw(String(value));
  }, [value, editing]);
  const parsed = raw.trim() === "" ? NaN : Number(raw.replace(",", "."));
  const commit = () => {
    const v = Number.isFinite(parsed) ? Math.round(Math.min(max, Math.max(min, parsed)) / step) * step : value;
    const fixed = Number(v.toFixed(4));
    setRaw(String(fixed));
    if (fixed !== value) onCommit(fixed);
  };
  return (
    <Input
      {...rest}
      type="number"
      min={min}
      max={max}
      step={step}
      value={raw}
      aria-invalid={!Number.isFinite(parsed) || parsed < min || parsed > max}
      onFocus={() => setEditing(true)}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => {
        setEditing(false);
        commit();
      }}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

/** Text input that reports its value on blur or Enter. */
export function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [raw, setRaw] = useState(value);
  useEffect(() => setRaw(value), [value]);
  const commit = () => raw.trim() !== value && onCommit(raw.trim());
  return <Input {...rest} value={raw} onChange={(e) => setRaw(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

/** Start and end of a long path or URL: the end (file or folder name) always stays visible. */
export function splitPath(value: string): [string, string] {
  if (value.length <= 32) return [value, ""];
  const cut = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  const tail = cut > 0 && value.length - cut <= 28 ? value.slice(cut) : value.slice(-20);
  return [value.slice(0, value.length - tail.length), tail];
}

/**
 * A path or URL on one line: shortened in the middle when it does not fit (the full value is
 * in the tooltip), selectable, with a copy button.
 */
export function PathValue({ value, className = "" }: { value: string; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [head, tail] = splitPath(value);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <span className="path-value">
      <span className={`path-text mono selectable ${className}`} title={value}>
        <span className="path-head">{head}</span>
        {tail && <span className="path-tail">{tail}</span>}
      </span>
      <IconButton
        icon={copied ? Check : Copy}
        size="sm"
        label={copied ? t("common.copied") : t("common.copy")}
        onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {})}
      />
    </span>
  );
}

/** An inline status message in a row (update state, connection, last run). */
export function StatusNote({ tone = "neutral", children, className = "" }: { tone?: "neutral" | "success" | "warning" | "danger" | "info" | "busy"; children: React.ReactNode; className?: string }) {
  const Icon = { neutral: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info, busy: Loader2 }[tone];
  return (
    <span className={`set-status tone-${tone} ${className}`} role="status">
      <Icon size={14} className={tone === "busy" ? "spin" : ""} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

export function SectionHead({ title, intro }: { title: string; intro?: string }) {
  return (
    <header className="settings-head">
      <h1>{title}</h1>
      {intro && <p>{intro}</p>}
    </header>
  );
}

/** Records a global shortcut from the pressed keys; `active` shows whether the saved one is registered. */
export function ShortcutField({ value, onChange, label, placeholder, active }: { value: string; onChange: (v: string) => void; label: string; placeholder: string; active?: boolean }) {
  return (
    <div className="unit-input shortcut-input">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          const next = recordShortcut(e.nativeEvent);
          if (next === undefined) return;
          e.preventDefault();
          if (next !== null) onChange(next);
        }}
        placeholder={placeholder}
        aria-label={label}
        className="mono"
      />
      {IS_MAC && value && <kbd>{formatShortcut(value)}</kbd>}
      {value && active !== undefined && (active ? <Badge tone="success">Aktiv</Badge> : <Badge tone="warning">Nicht registriert</Badge>)}
    </div>
  );
}
