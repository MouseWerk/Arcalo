// Page properties (frontmatter) editor and the work card of a page linked to a Vorgang.

import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, CalendarDays, ChevronDown, ChevronRight, FolderTree, Play, Plus, Tags, TriangleAlert, Type, Workflow, X, type LucideIcon } from "lucide-react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, Button, IconButton, Progress } from "../components/ui";
import { DATE_RE, LIST_KEYS, edited, isValidKey, parseFrontmatter, propertyValue, serializeFrontmatter, splitItems, type Property } from "../lib/frontmatter";
import { dateShort, fmtHours, fmtMinutes } from "../lib/format";
import { NetzplanSelect, VorgangSelect, useWbs } from "./wbs";
import { LEVEL } from "./ProjectsView";
import type { PageWork } from "../lib/types";
import { SuggestionPopup, type PopupHandle } from "../editor/suggestion-popup";
import { pickDate } from "../components/CalendarPopover";
import { dayLabel } from "../components/DateInput";
import { zeitRefItems } from "../editor/zeit-source";
import type { ZeitSuggestItem } from "../editor/extensions";

const TYPE_ICON: Record<Property["type"], LucideIcon> = { text: Type, date: CalendarDays, list: Tags, raw: Braces };
const isWbsKey = (key: string) => /^(vorgang|netzplan)$/i.test(key);
const isTagsKey = (key: string) => /^tags?$/i.test(key);
const KEY_HINT = "Ungültiger Name: nicht mit Leerzeichen oder # - [ ] { } ' \" & * ! | > % @ ` ? , beginnen";

/** Opens „Eigenschaft hinzufügen“ on the page of the focused pane (palette, Ctrl+;). */
export const ADD_PROPERTY_EVENT = "annalo:add-property";
export const requestAddProperty = () => window.dispatchEvent(new Event(ADD_PROPERTY_EVENT));

/** The WBS reference of a page's properties, as the core resolves it (`vorgang:` / `netzplan:`). */
export function pageReference(fm: string): string | null {
  const props = parseFrontmatter(fm);
  const v = propertyValue(props, "vorgang");
  const n = propertyValue(props, "netzplan");
  if (v && (v.includes("/") || !n)) return v;
  if (v && n) return `${n}/${v}`;
  return n;
}

export function PropertyEditor({ fm, onChange, adding, onAdded }: { fm: string; onChange: (fm: string) => void; adding: boolean; onAdded: () => void }) {
  const props = useMemo(() => parseFrontmatter(fm), [fm]);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (adding) setOpen(true);
  }, [adding]);
  const commit = (next: Property[]) => onChange(serializeFrontmatter(next));
  const update = (i: number, change: Partial<Property>) => commit(props.map((p, j) => (j === i ? edited(p, change) : p)));
  const taken = (key: string, except = -1) => props.some((p, j) => j !== except && p.key.toLowerCase() === key.toLowerCase());
  const rows = props.map((p, i) => ({ p, i })).filter(({ p }) => p.key || p.value.trim());

  if (!rows.length && !adding) return null;
  return (
    <section className="properties" aria-label="Eigenschaften">
      <button type="button" className="properties-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Eigenschaften
      </button>
      {open && (
        <>
          {rows.map(({ p, i }) => (
            <PropertyRow
              key={`${i}:${p.key}`}
              prop={p}
              onChange={(c) => update(i, c)}
              onRename={(key) => {
                if (!key || key === p.key || !isValidKey(key)) return false;
                if (taken(key, i)) {
                  useApp.getState().toast({ tone: "warning", title: `Eigenschaft „${key}“ gibt es schon` });
                  return false;
                }
                update(i, { key });
                return true;
              }}
              onRemove={() => commit(props.filter((_, j) => j !== i))}
            />
          ))}
          <NewProperty
            autoOpen={adding}
            onDone={onAdded}
            onAdd={(key) => {
              if (!isValidKey(key)) return;
              if (taken(key)) {
                useApp.getState().toast({ tone: "warning", title: `Eigenschaft „${key}“ gibt es schon` });
                return;
              }
              const list = LIST_KEYS.has(key.toLowerCase());
              commit([...props, edited({ key, type: list ? "list" : "text", value: "", items: [] }, {})]);
              // Continue with the value of the new row.
              setTimeout(() => document.querySelector<HTMLElement>(`.properties [data-prop-key="${CSS.escape(key)}"] .prop-value-input`)?.focus(), 30);
            }}
          />
        </>
      )}
    </section>
  );
}

function PropertyRow({ prop, onChange, onRename, onRemove }: { prop: Property; onChange: (c: Partial<Property>) => void; onRename: (key: string) => boolean; onRemove: () => void }) {
  const [key, setKey] = useState(prop.key);
  useEffect(() => setKey(prop.key), [prop.key]);
  const Icon = isWbsKey(prop.key) ? Workflow : TYPE_ICON[prop.type];
  const invalid = key.trim() !== "" && !isValidKey(key.trim());
  const commitKey = () => {
    const k = key.trim();
    if (!onRename(k)) setKey(prop.key);
  };
  return (
    <div className={`prop-row prop-type-${prop.type}${isWbsKey(prop.key) ? " is-wbs" : ""}`} data-prop-key={prop.key}>
      <span className="prop-icon" aria-hidden>
        <Icon size={14} />
      </span>
      {prop.type === "raw" ? (
        <span className="prop-key prop-key-static" title="YAML – wird unverändert gespeichert">{prop.key || "YAML"}</span>
      ) : (
        <input
          className="prop-key"
          value={key}
          aria-label="Name der Eigenschaft"
          aria-invalid={invalid || undefined}
          spellCheck={false}
          onChange={(e) => setKey(e.target.value.replace(/[:\n]/g, ""))}
          onBlur={commitKey}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !invalid) (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setKey(prop.key);
          }}
        />
      )}
      <div className="prop-value">
        <PropertyValue prop={prop} onChange={onChange} />
      </div>
      <IconButton icon={X} label="Eigenschaft entfernen" size="sm" className="prop-remove" onClick={onRemove} />
      {invalid && (
        <span className="prop-key-hint" role="alert">
          {KEY_HINT}
        </span>
      )}
    </div>
  );
}

function PropertyValue({ prop, onChange }: { prop: Property; onChange: (c: Partial<Property>) => void }) {
  if (prop.type === "list") return <ListValue items={prop.items} hashed={isTagsKey(prop.key)} onChange={(items) => onChange({ items })} />;
  if (prop.type === "raw") return <RawValue value={prop.value} onChange={(value) => onChange({ value })} />;
  if (prop.type === "date") {
    const iso = DATE_RE.test(prop.value) ? prop.value : "";
    return (
      <button
        type="button"
        className="prop-value-input prop-date"
        aria-label={`${prop.key}: ${iso ? dayLabel(iso) : "kein Datum"}, Datum wählen`}
        aria-haspopup="dialog"
        onClick={(e) => pickDate(e.currentTarget, iso, (value) => onChange({ value }))}
      >
        {iso ? dayLabel(iso) : <span className="faint">Datum wählen</span>}
      </button>
    );
  }
  return <TextValue prop={prop} onChange={(value) => onChange({ value })} />;
}

function TextValue({ prop, onChange }: { prop: Property; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(prop.value);
  const [picker, setPicker] = useState(false);
  useEffect(() => setDraft(prop.value), [prop.value]);
  const commit = () => draft !== prop.value && onChange(draft);
  const key = prop.key.toLowerCase();
  const input =
    key === "vorgang" ? (
      <RefCombo value={prop.value} draft={draft} setDraft={setDraft} label={prop.key} onCommit={commit} onPick={(v) => v !== prop.value && onChange(v)} onRevert={() => setDraft(prop.value)} />
    ) : (
      <input
        className="prop-value-input"
        value={draft}
        placeholder="Leer"
        aria-label={prop.key}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(prop.value);
        }}
      />
    );
  return (
    <>
      {input}
      {isWbsKey(prop.key) && (
        <IconButton icon={FolderTree} label={key === "netzplan" ? "Netzplan wählen" : "Vorgang wählen"} size="sm" className="prop-pick" active={picker} onClick={() => setPicker((v) => !v)} />
      )}
      {picker && <WbsPicker value={prop.value} netzplanOnly={key === "netzplan"} onChange={onChange} onClose={() => setPicker(false)} />}
    </>
  );
}

/** Text input with the `/zeit` reference suggestions (↑ ↓ Enter, Esc closes). */
function RefCombo({ value, draft, setDraft, label, onCommit, onPick, onRevert }: {
  value: string;
  draft: string;
  setDraft: (v: string) => void;
  label: string;
  onCommit: () => void;
  onPick: (v: string) => void;
  onRevert: () => void;
}) {
  const [list, setList] = useState<{ q: string; items: ZeitSuggestItem[] } | null>(null);
  const items = list?.items ?? null;
  const popup = useRef<PopupHandle>(null);
  // Latest query; older answers are dropped, `null` = closed.
  const query = useRef<string | null>(null);
  // Enter picks the highlighted suggestion after ↑/↓, or for words typed since focusing (never
  // from a stale list). Typed codes (`NP-8801`, `1020`) stay as written unless one matches exactly.
  const typed = useRef(false);
  const navigated = useRef(false);
  const suggest = (q: string) => {
    query.current = q;
    navigated.current = false;
    zeitRefItems(q)
      .then((items) => query.current === q && setList({ q, items }))
      .catch(() => {});
  };
  const close = () => {
    query.current = null;
    setList(null);
  };
  return (
    <div className="prop-combo">
      <input
        className="prop-value-input"
        value={draft}
        placeholder="NP-8801/1020"
        size={Math.min(26, Math.max(14, draft.length + 1))}
        aria-label={label}
        role="combobox"
        aria-expanded={items !== null}
        aria-autocomplete="list"
        spellCheck={false}
        onFocus={() => {
          typed.current = false;
          suggest(draft === value ? "" : draft.trim());
        }}
        onChange={(e) => {
          typed.current = true;
          setDraft(e.target.value);
          suggest(e.target.value.trim());
        }}
        onBlur={() => {
          close();
          onCommit();
        }}
        onKeyDown={(e) => {
          const nav = e.key === "ArrowDown" || e.key === "ArrowUp";
          const text = draft.trim();
          const exact = items?.find((it) => it.insert.toLowerCase() === text.toLowerCase());
          if (e.key === "Enter" && exact && !navigated.current) {
            e.preventDefault();
            setDraft(exact.insert);
            close();
            onPick(exact.insert);
            return;
          }
          const pick = e.key === "Enter" && (navigated.current || (typed.current && list?.q === text && !/\d/.test(text)));
          if (items && (nav || pick) && popup.current?.onKeyDown({ event: e.nativeEvent } as SuggestionKeyDownProps)) {
            if (nav) navigated.current = true;
            e.preventDefault();
            return;
          }
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") {
            e.stopPropagation();
            if (items) close();
            else onRevert();
          } else if (e.key === "ArrowDown" && !items) suggest(draft.trim());
        }}
      />
      {items && (
        <div className="prop-sugg">
          <SuggestionPopup
            ref={popup}
            items={items}
            className="zeit"
            empty="Kein Vorgang gefunden – Enter übernimmt den Text"
            command={(it) => {
              const v = (it as ZeitSuggestItem).insert;
              setDraft(v);
              close();
              onPick(v);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Picks Netzplan (and Vorgang) from the project structure: writes `NP-8801/1020`. */
function WbsPicker({ value, netzplanOnly, onChange, onClose }: { value: string; netzplanOnly: boolean; onChange: (v: string) => void; onClose: () => void }) {
  const { wbs } = useWbs();
  const [npRef, vRef = ""] = value.split("/");
  const nps = wbs.flatMap((p) => p.netzplaene);
  const lower = (npRef ?? "").trim().toLowerCase();
  const np = nps.find((n) => n.netzplan_nr.toLowerCase() === lower || n.wbs_element.toLowerCase() === lower) ?? null;
  const vorgang = np?.vorgaenge.find((v) => v.vorgang_nr.toLowerCase() === vRef.trim().toLowerCase())?.vorgang_nr ?? "";
  return (
    <div className="prop-picker" role="group" aria-label="Vorgang wählen">
      <NetzplanSelect wbs={wbs} value={np?.id ?? null} onChange={(id) => onChange(nps.find((n) => n.id === id)?.netzplan_nr ?? "")} />
      {!netzplanOnly && (
        <VorgangSelect wbs={wbs} netzplanId={np?.id ?? null} value={vorgang} onChange={(v) => np && onChange(v ? `${np.netzplan_nr}/${v}` : np.netzplan_nr)} />
      )}
      <Button size="sm" variant="ghost" onClick={onClose}>Fertig</Button>
    </div>
  );
}

function ListValue({ items, hashed, onChange }: { items: string[]; hashed: boolean; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const more = splitItems(draft).filter((x) => !items.includes(x));
    setDraft("");
    if (more.length) onChange([...items, ...more]);
  };
  return (
    <div className="prop-list">
      {items.map((item, i) => (
        <span key={`${i}:${item}`} className="prop-chip">
          {hashed && <span className="prop-chip-hash" aria-hidden>#</span>}
          {item}
          <button type="button" aria-label={`${item} entfernen`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="prop-value-input prop-list-input"
        value={draft}
        placeholder={items.length ? "" : "Leer"}
        aria-label="Eintrag hinzufügen"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && items.length) onChange(items.slice(0, -1));
        }}
      />
    </div>
  );
}

function RawValue({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  return (
    <textarea
      ref={ref}
      className="prop-value-input prop-raw"
      rows={1}
      value={draft}
      aria-label="YAML"
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onChange(draft)}
    />
  );
}

function NewProperty({ autoOpen, onAdd, onDone }: { autoOpen: boolean; onAdd: (key: string) => void; onDone: () => void }) {
  const [draft, setDraft] = useState<string | null>(autoOpen ? "" : null);
  useEffect(() => {
    if (autoOpen) setDraft("");
  }, [autoOpen]);
  const invalid = !!draft?.trim() && !isValidKey(draft.trim());
  const finish = () => {
    const k = (draft ?? "").trim();
    // Keep the row (and its hint) until the name is valid or the user presses Esc.
    if (invalid) return;
    setDraft(null);
    onDone();
    if (k) onAdd(k);
  };
  if (draft === null)
    return (
      <button type="button" className="prop-add" onClick={() => setDraft("")}>
        <Plus size={13} /> Eigenschaft hinzufügen
      </button>
    );
  return (
    <div className="prop-row prop-new">
      <span className="prop-icon" aria-hidden>
        <Plus size={14} />
      </span>
      <input
        className="prop-key"
        autoFocus
        value={draft}
        placeholder="Name, z. B. vorgang"
        aria-label="Name der neuen Eigenschaft"
        aria-invalid={invalid || undefined}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value.replace(/[:\n]/g, ""))}
        onBlur={finish}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !invalid) (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            onDone();
          }
        }}
      />
      {invalid && (
        <span className="prop-key-hint" role="alert">
          {KEY_HINT}
        </span>
      )}
    </div>
  );
}

/** Budget, ETC and the latest bookings of the Vorgang the page is linked to. */
export function WorkCard({ pageId, reference, title }: { pageId: number; reference: string; title: string }) {
  const entriesVersion = useApp((s) => s.entriesVersion);
  const timer = useApp((s) => s.timer);
  const [work, setWork] = useState<PageWork | null>(null);
  const [saved, setSaved] = useState(0);
  const [open, setOpen] = useState(false);

  // The card reads the saved page: reload after each save of this page.
  useEffect(() => {
    const onSaved = (e: Event) => (e as CustomEvent<{ id: number }>).detail.id === pageId && setSaved((n) => n + 1);
    window.addEventListener("annalo:page-saved", onSaved);
    return () => window.removeEventListener("annalo:page-saved", onSaved);
  }, [pageId]);
  useEffect(() => {
    let alive = true;
    api
      .pageWork(pageId)
      .then((w) => alive && setWork(w))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pageId, entriesVersion, saved, reference]);

  if (!work) return null;
  if (work.error)
    return (
      <section className="work-card work-error" aria-label="Vorgang">
        <TriangleAlert size={14} /> {work.error}
      </section>
    );
  const level = LEVEL[work.level];
  const start = async () => {
    const s = useApp.getState();
    try {
      await api.timerStart(work.netzplan_id!, work.vorgang, localStorage.getItem("annalo.timer.la") || "DEV", title);
      s.bumpEntries();
      s.toast({ tone: "info", title: "Timer gestartet", detail: work.label });
    } catch (e) {
      s.error("Timer nicht gestartet", e);
    }
  };
  return (
    <section className="work-card" aria-label="Vorgang">
      <div className="work-head">
        <Workflow size={14} className="faint" />
        <span className="work-title">
          <span className="mono strong">{work.label}</span>
          {work.title && <span> · {work.title}</span>}
        </span>
        <Badge tone={level.tone}>{level.label}</Badge>
        <Button size="sm" icon={Play} disabled={!!timer} onClick={start}>
          {timer ? "Timer läuft" : "Timer starten"}
        </Button>
      </div>
      {work.planned_hours > 0 && <Progress value={work.consumed} tone={level.tone} />}
      <div className="work-stats">
        <span className="num">
          {fmtHours(work.booked_hours)} / {fmtHours(work.planned_hours)} h gebucht
        </span>
        <span className="num">ETC {fmtHours(work.etc_hours)} h</span>
        {work.page_hours > 0 && <span className="num">{fmtHours(work.page_hours)} h von dieser Seite</span>}
      </div>
      {work.entries.length > 0 && (
        <>
          <button type="button" className="work-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            Letzte Buchungen
          </button>
          {open && (
            <ul className="work-entries">
              {work.entries.map((e) => (
                <li key={e.id} className={e.page_id === pageId ? "own" : ""}>
                  <span className="faint">{dateShort(e.start_time)}</span>
                  <span className="num">{fmtMinutes(e.duration_minutes)} h</span>
                  <span className="work-entry-desc">
                    {e.description || "–"}
                    {e.page_id === pageId && <span className="faint"> · diese Seite</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
