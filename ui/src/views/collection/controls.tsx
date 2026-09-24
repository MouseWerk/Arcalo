// Typed property controls shared by the property editor and the table/board: option chips and
// picker, person and page suggestions, the options dialog and the cell display.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Calendar, Check, CheckSquare, CircleDot, Hash, Link2, List, Plus, Square, Trash2, Type, User, X, type LucideIcon } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { anchorMenu, Button, Dialog, IconButton } from "../../components/ui";
import { dayLabel } from "../../components/DateInput";
import { pickDate } from "../../components/CalendarPopover";
import { COLORS, COLOR_LABELS, colorIndex, hasOptions, writeFromText, type Cell, type CellWrite, type PropDef, type PropKind, type SelectOption } from "../../lib/collection";

export const KIND_ICON: Record<PropKind, LucideIcon> = {
  text: Type,
  select: CircleDot,
  multi_select: List,
  number: Hash,
  date: Calendar,
  person: User,
  checkbox: CheckSquare,
  link: Link2,
};

const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 6 });
export const fmtNumber = (n: number) => nf.format(n);

// ------------------------------------------------------------------ chips

export function OptionChip({ name, color, invalid, onRemove }: { name: string; color: number | null; invalid?: boolean; onRemove?: () => void }) {
  return (
    <span className={`opt-chip ${color === null ? "opt-none" : `opt-${color}`}${invalid ? " opt-invalid" : ""}`}>
      <span className="opt-chip-label">{name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`${name} entfernen`}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

const optionColor = (def: PropDef | undefined, name: string) => {
  const o = def?.options.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return o ? colorIndex(o.color) : null;
};

/** How a cell reads (table, cards): chips, a formatted number or date, a checkbox, a link. */
export function CellDisplay({ def, cell, placeholder = "" }: { def?: PropDef; cell: Cell; placeholder?: string }) {
  if (cell.error) return <span className="cell-raw">{cell.text}</span>;
  const v = cell.value;
  if (!v) return placeholder ? <span className="faint">{placeholder}</span> : null;
  switch (v.kind) {
    case "select":
      return <OptionChip name={v.value} color={optionColor(def, v.value)} />;
    case "multi_select":
      return (
        <span className="opt-chips">
          {v.value.map((n) => (
            <OptionChip key={n} name={n} color={optionColor(def, n)} />
          ))}
        </span>
      );
    case "number":
      return <span className="num">{fmtNumber(v.value)}</span>;
    case "date":
      return <span className="num">{dayLabel(v.value)}</span>;
    case "checkbox":
      return v.value ? <CheckSquare size={15} className="cell-check on" aria-label="Ja" /> : <Square size={15} className="cell-check" aria-label="Nein" />;
    case "person":
      return (
        <span className="cell-person">
          <span className="person-avatar" aria-hidden>
            {v.value.slice(0, 1).toUpperCase()}
          </span>
          {v.value}
        </span>
      );
    case "link":
      return <span className="cell-link">{v.value.replace(/^\[\[|\]\]$/g, "")}</span>;
    default:
      return <span>{v.value}</span>;
  }
}

/** Marks a value that does not fit its type: red underline, the reason as tooltip. */
export function Invalid({ error, children }: { error: string | null; children: ReactNode }) {
  if (!error) return <>{children}</>;
  return (
    <span className="val-invalid" data-tooltip={error} aria-invalid="true">
      {children}
    </span>
  );
}

// ------------------------------------------------------------------ popover

/** A floating panel below `anchor` (menu look); closes on outside clicks and Escape. */
export function Popover({ anchor, onClose, children, className = "", label }: { anchor: Element; onClose: () => void; children: ReactNode; className?: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: -9999, y: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    setPos(anchorMenu(r, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      // Dropdown lists and calendars opened from the popup live in their own portal.
      if (t && (ref.current?.contains(t) || t.closest?.(".menu, .calendar, .select-pop"))) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".calendar, .select-pop")) {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return createPortal(
    <div ref={ref} className={`menu coll-pop ${className}`} role="dialog" aria-label={label} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ option picker

/** Picks one (or several) options; typing filters, Enter on a new name adds it as an option. */
export function OptionPicker({
  def,
  selected,
  onChange,
  onAddOption,
  onClose,
}: {
  def: PropDef;
  selected: string[];
  onChange: (values: string[]) => void;
  onAddOption?: (name: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const multi = def.kind === "multi_select";
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const lower = q.trim().toLowerCase();
  const shown = def.options.filter((o) => !lower || o.name.toLowerCase().includes(lower));
  const canAdd = !!onAddOption && !!q.trim() && !def.options.some((o) => o.name.toLowerCase() === lower);
  const count = shown.length + (canAdd ? 1 : 0);
  const isOn = (n: string) => selected.some((s) => s.toLowerCase() === n.toLowerCase());
  const pick = async (name: string, add = false) => {
    if (add) await onAddOption?.(name);
    if (multi) {
      onChange(isOn(name) ? selected.filter((s) => s.toLowerCase() !== name.toLowerCase()) : [...selected, name]);
      setQ("");
    } else {
      onChange(isOn(name) && !add ? [] : [name]);
      onClose();
    }
  };
  return (
    <div className="opt-picker">
      <div className="opt-picker-head">
        {multi && selected.map((s) => <OptionChip key={s} name={s} color={optionColor(def, s)} onRemove={() => onChange(selected.filter((x) => x !== s))} />)}
        <input
          autoFocus
          className="opt-picker-input"
          value={q}
          placeholder={onAddOption ? "Option suchen oder anlegen" : "Option suchen"}
          aria-label="Option suchen"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (count) setSel((s) => (s + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (sel < shown.length) pick(shown[sel].name);
              else if (canAdd) pick(q.trim(), true);
            } else if (e.key === "Backspace" && !q && multi && selected.length) onChange(selected.slice(0, -1));
          }}
        />
      </div>
      <div className="opt-picker-list" role="listbox" aria-label={def.key} aria-multiselectable={multi || undefined}>
        {shown.map((o, i) => (
          <button
            key={o.name}
            type="button"
            role="option"
            aria-selected={isOn(o.name)}
            className={`opt-picker-item ${i === sel ? "sel" : ""}`}
            onMouseEnter={() => setSel(i)}
            onClick={() => pick(o.name)}
          >
            <OptionChip name={o.name} color={colorIndex(o.color)} />
            {isOn(o.name) && <Check size={14} className="opt-picker-check" aria-hidden />}
          </button>
        ))}
        {canAdd && (
          <button type="button" className={`opt-picker-item opt-picker-add ${sel === shown.length ? "sel" : ""}`} onMouseEnter={() => setSel(shown.length)} onClick={() => pick(q.trim(), true)}>
            <Plus size={13} /> „{q.trim()}“ als Option anlegen
          </button>
        )}
        {!count && <div className="opt-picker-empty faint">Keine Optionen</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ suggestions

let personCache: { at: number; list: Promise<string[]> } | null = null;
/** Known persons (property values and @mentions), cached for a few seconds. */
export function knownPersons(): Promise<string[]> {
  if (!personCache || Date.now() - personCache.at > 5000) personCache = { at: Date.now(), list: api.knownPersons().catch(() => []) };
  return personCache.list;
}

function pageTitles(q: string): string[] {
  const lower = q.replace(/^\[\[|\]\]$/g, "").trim().toLowerCase();
  const titles = [...useApp.getState().pages.values()].map((p) => p.title);
  return titles
    .filter((t) => !lower || t.toLowerCase().includes(lower))
    .sort((a, b) => Number(!a.toLowerCase().startsWith(lower)) - Number(!b.toLowerCase().startsWith(lower)) || a.localeCompare(b, "de"))
    .slice(0, 8);
}

/**
 * A text input with suggestions below it (persons, pages). Enter commits (the highlighted
 * suggestion after ↑/↓), Escape reverts, blur commits.
 */
export function ComboInput({
  value,
  onCommit,
  onCancel,
  suggest,
  placeholder,
  className = "",
  autoFocus,
  label,
  invalid,
  seeded,
}: {
  value: string;
  onCommit: (text: string) => void;
  onCancel?: () => void;
  suggest?: (q: string) => Promise<string[]> | string[];
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  label: string;
  invalid?: string | null;
  /** Started by typing a character: the caret goes after it instead of selecting everything. */
  seeded?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [items, setItems] = useState<string[] | null>(null);
  const [sel, setSel] = useState(-1);
  const done = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const load = async (q: string) => {
    if (!suggest) return;
    const list = await suggest(q);
    setItems(list.filter((x) => x.toLowerCase() !== q.trim().toLowerCase() || list.length > 1).slice(0, 8));
    setSel(-1);
  };
  const commit = (text: string) => {
    if (done.current) return;
    done.current = true;
    setItems(null);
    onCommit(text);
    setTimeout(() => (done.current = false), 0);
  };
  return (
    <span className={`combo ${className}`}>
      <input
        className="prop-value-input combo-input"
        value={draft}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        role={suggest ? "combobox" : undefined}
        aria-expanded={suggest ? !!items?.length : undefined}
        spellCheck={false}
        onFocus={(e) => {
          const el = e.currentTarget;
          if (seeded) el.setSelectionRange(el.value.length, el.value.length);
          else el.select();
          load(draft === value && !seeded ? "" : draft);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          load(e.target.value);
        }}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          const n = items?.length ?? 0;
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n) {
            e.preventDefault();
            setSel((s) => (e.key === "ArrowDown" ? (s + 1) % n : (s - 1 + n) % n));
          } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const text = sel >= 0 && items ? items[sel] : draft;
            setDraft(text);
            commit(text);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done.current = true;
            setItems(null);
            setDraft(value);
            onCancel?.();
            setTimeout(() => (done.current = false), 0);
          }
        }}
      />
      {!!items?.length && (
        <span className="combo-list" role="listbox">
          {items.map((it, i) => (
            <button
              key={it}
              type="button"
              role="option"
              aria-selected={i === sel}
              className={`combo-item ${i === sel ? "sel" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setDraft(it);
                commit(it);
              }}
            >
              {it}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export const suggestPersons = async (q: string) => {
  const lower = q.replace(/^@/, "").trim().toLowerCase();
  return (await knownPersons()).filter((p) => !lower || p.toLowerCase().includes(lower));
};
export const suggestLinks = (q: string) => pageTitles(q).map((t) => `[[${t}]]`);

// ------------------------------------------------------------------ typed value (property editor)

/**
 * The value control of a typed property in the property editor: always editable, invalid
 * values stay visible (red underline, reason as tooltip) until they are changed.
 */
export function TypedValue({ def, cell, label, onWrite, onAddOption }: { def: PropDef; cell: Cell; label: string; onWrite: (v: CellWrite) => void; onAddOption: (name: string) => Promise<void> | void }) {
  const [picker, setPicker] = useState<Element | null>(null);
  const kind = def.kind;
  const input = (props: { suggest?: (q: string) => Promise<string[]> | string[]; placeholder?: string; initial?: string }) => (
    <Invalid error={cell.error}>
      <ComboInput
        value={props.initial ?? cell.text}
        label={label}
        placeholder={props.placeholder ?? "Leer"}
        suggest={props.suggest}
        invalid={cell.error}
        onCommit={(text) => text.trim() !== (props.initial ?? cell.text).trim() && onWrite(writeFromText(def, text))}
      />
    </Invalid>
  );
  if (kind === "checkbox") {
    const on = cell.value?.kind === "checkbox" && cell.value.value;
    return (
      <Invalid error={cell.error}>
        <label className="prop-check">
          <input type="checkbox" checked={on} aria-label={label} onChange={() => onWrite(!on)} />
          {cell.error && <span className="cell-raw">{cell.text}</span>}
        </label>
      </Invalid>
    );
  }
  if (kind === "select" || kind === "multi_select") {
    const selected = cell.value?.kind === "select" ? [cell.value.value] : cell.value?.kind === "multi_select" ? cell.value.value : cell.items;
    return (
      <>
        <button type="button" className="prop-value-input prop-options" aria-label={`${label}: ${cell.text || "leer"}`} aria-haspopup="dialog" onClick={(e) => setPicker(e.currentTarget)}>
          <Invalid error={cell.error}>{cell.text ? selected.map((s) => <OptionChip key={s} name={s} color={optionColor(def, s)} invalid={optionColor(def, s) === null} />) : <span className="faint">Leer</span>}</Invalid>
        </button>
        {picker && (
          <Popover anchor={picker} label={label} onClose={() => setPicker(null)}>
            <OptionPicker def={def} selected={selected} onAddOption={onAddOption} onClose={() => setPicker(null)} onChange={(v) => onWrite(kind === "select" ? (v[0] ?? null) : v)} />
          </Popover>
        )}
      </>
    );
  }
  if (kind === "date") {
    const iso = cell.value?.kind === "date" ? cell.value.value : "";
    return (
      <span className="prop-date-wrap">
        <Invalid error={cell.error}>
          <button
            type="button"
            className="prop-value-input prop-date"
            aria-label={`${label}: ${iso ? dayLabel(iso) : cell.text || "kein Datum"}, Datum wählen`}
            aria-haspopup="dialog"
            onClick={(e) => pickDate(e.currentTarget, iso, (v) => onWrite(v))}
          >
            {iso ? dayLabel(iso) : cell.text ? <span className="cell-raw">{cell.text}</span> : <span className="faint">Datum wählen</span>}
          </button>
        </Invalid>
        {cell.text && <IconButton icon={X} label="Datum entfernen" size="sm" className="prop-clear" onClick={() => onWrite(null)} />}
      </span>
    );
  }
  if (kind === "number") return input({ initial: cell.value?.kind === "number" ? fmtNumber(cell.value.value) : cell.text });
  if (kind === "person") return input({ suggest: suggestPersons, placeholder: "Name" });
  if (kind === "link") {
    return (
      <>
        {input({ suggest: suggestLinks, placeholder: "URL oder [[Seite]]" })}
        {cell.value?.kind === "link" && <IconButton icon={Link2} label="Link öffnen" size="sm" className="prop-pick" onClick={(e) => openLink(cell.value!.value as string, e.ctrlKey || e.metaKey)} />}
      </>
    );
  }
  return input({});
}

/** Opens a link value: `[[Seite]]` in the app, URLs with the default browser. */
export async function openLink(value: string, newTab: boolean) {
  const s = useApp.getState();
  const wiki = /^\[\[([^[\]|#]+)/.exec(value);
  try {
    if (wiki) {
      const page = await api.resolvePage(wiki[1].trim(), true);
      if (!page) return;
      if (!s.pages.has(page.id)) await s.refreshTree();
      s.openPage(page.id, { newTab });
    } else {
      await openUrl(/^www\./i.test(value) ? `https://${value}` : value);
    }
  } catch (e) {
    s.error("Link konnte nicht geöffnet werden", e);
  }
}

/** Text a cell editor starts with: numbers in German format, the rest as written. */
export const editText = (cell: Cell) => (cell.value?.kind === "number" ? fmtNumber(cell.value.value) : cell.text);

// ------------------------------------------------------------------ options dialog

/** Edits the options of a (multi) select: names, colors, order. Renames are reported for the pages. */
export function OptionsDialog({ def, onClose, onSave }: { def: PropDef; onClose: () => void; onSave: (options: SelectOption[], renames: [string, string][]) => void }) {
  const [rows, setRows] = useState(() => def.options.map((o) => ({ ...o, was: o.name })));
  const [colorFor, setColorFor] = useState<{ i: number; el: Element } | null>(null);
  const names = rows.map((r) => r.name.trim().toLowerCase());
  const dup = names.some((n, i) => n && names.indexOf(n) !== i);
  const move = (i: number, d: number) =>
    setRows((rs) => {
      const next = [...rs];
      const [r] = next.splice(i, 1);
      next.splice(i + d, 0, r);
      return next;
    });
  const save = () => {
    const kept = rows.filter((r) => r.name.trim());
    onSave(
      kept.map((r) => ({ name: r.name.trim(), color: r.color })),
      kept.filter((r) => r.was && r.was !== r.name.trim()).map((r) => [r.was, r.name.trim()] as [string, string]),
    );
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Optionen von „${def.key}“`}
      description="Umbenannte Optionen werden auf allen Seiten im Ordner angepasst."
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" disabled={dup} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="opt-edit" role="list">
        {rows.map((r, i) => (
          <div key={i} className="opt-edit-row" role="listitem">
            <button type="button" className={`opt-swatch opt-${colorIndex(r.color)}`} aria-label={`Farbe von ${r.name || "Option"}: ${COLOR_LABELS[colorIndex(r.color)]}`} onClick={(e) => setColorFor({ i, el: e.currentTarget })} />
            <input
              className="input opt-edit-name"
              value={r.name}
              aria-label="Name der Option"
              aria-invalid={(!!r.name.trim() && names.indexOf(r.name.trim().toLowerCase()) !== i) || undefined}
              spellCheck={false}
              onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              onKeyDown={(e) => e.key === "Enter" && !dup && save()}
            />
            <IconButton icon={ArrowUp} label="Nach oben" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
            <IconButton icon={ArrowDown} label="Nach unten" size="sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} />
            <IconButton icon={Trash2} label="Option löschen" size="sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
          </div>
        ))}
        <button type="button" className="prop-add" onClick={() => setRows((rs) => [...rs, { name: "", color: COLORS[rs.length % COLORS.length], was: "" }])}>
          <Plus size={13} /> Option hinzufügen
        </button>
        {dup && <div className="prop-key-hint" role="alert">Jede Option nur einmal</div>}
      </div>
      {colorFor && (
        <Popover anchor={colorFor.el} label="Farbe wählen" onClose={() => setColorFor(null)}>
          <div className="opt-colors" role="listbox" aria-label="Farbe">
            {COLORS.map((c, ci) => (
              <button
                key={c}
                type="button"
                role="option"
                aria-selected={rows[colorFor.i]?.color === c}
                className="opt-color-item"
                onClick={() => {
                  setRows((rs) => rs.map((x, j) => (j === colorFor.i ? { ...x, color: c } : x)));
                  setColorFor(null);
                }}
              >
                <span className={`opt-swatch opt-${ci}`} aria-hidden /> {COLOR_LABELS[ci]}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </Dialog>
  );
}

/** Menu entries „Typ ändern“ for a property. */
export function kindMenu(current: PropKind, onPick: (k: PropKind) => void, kinds: { kind: PropKind; label: string }[]) {
  return kinds.map((k) => ({ label: k.label, icon: KIND_ICON[k.kind], checked: k.kind === current, onSelect: () => k.kind !== current && onPick(k.kind) }));
}

/** Converts options when the type changes: selects keep theirs, others start from the values seen. */
export function optionsForKind(kind: PropKind, prev: PropDef | undefined, values: string[]): SelectOption[] {
  if (!hasOptions(kind)) return [];
  const out: SelectOption[] = prev && hasOptions(prev.kind) ? [...prev.options] : [];
  for (const v of values)
    for (const part of kind === "multi_select" ? v.split(",") : [v]) {
      const n = part.trim();
      if (n && !out.some((o) => o.name.toLowerCase() === n.toLowerCase())) out.push({ name: n, color: COLORS[out.length % COLORS.length] });
    }
  return out;
}
