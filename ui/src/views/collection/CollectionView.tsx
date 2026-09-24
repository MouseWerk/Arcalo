// The child pages of a page as a table or a board, below the page's text (like an inline
// database). Schema and view settings live in the page's own frontmatter; values in the child
// pages' frontmatter. See lib/collection.ts for the format.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Columns3, EyeOff, Filter, KanbanSquare, List, ListFilter, Plus, Settings2, Table2, Trash2, X, type LucideIcon } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { Button, IconButton, Select, useMenu, type MenuEntry } from "../../components/ui";
import { DateInput } from "../../components/DateInput";
import { flushAllEditors, reloadEditors } from "../../editor/NoteEditor";
import { splitFrontmatter } from "../../editor/extensions";
import {
  KINDS,
  TITLE,
  cellOf,
  columnKeys,
  defOf,
  fieldLabel,
  filterRows,
  groupable,
  hasOptions,
  COLORS,
  boardCards,
  isManagedKey,
  kindOf,
  makeRow,
  opsFor,
  parseSchema,
  setEntry,
  parseView,
  setSchema,
  setView,
  sortRows,
  todayIso,
  writeValue,
  type CellWrite,
  type FilterSpec,
  type PropDef,
  type PropKind,
  type Row,
  type ViewSettings,
  type ViewType,
} from "../../lib/collection";
import { isValidKey, propertyLines } from "../../lib/frontmatter";
import { FRONTMATTER_EVENT, updateFrontmatter } from "./write";
import { KIND_ICON, OptionsDialog, Popover, kindMenu, optionsForKind } from "./controls";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";

/** What the table and the board get from the view. */
export interface Ctx {
  parentId: number;
  defs: PropDef[] | null;
  view: ViewSettings;
  rows: Row[];
  /** Filtered and sorted. */
  shown: Row[];
  setView: (v: ViewSettings) => void;
  /** Sets a property of a child page; with `undo`, a toast offers „Rückgängig“ (the old lines come back). */
  write: (row: Row, key: string, value: CellWrite, undo?: string) => void;
  addOption: (key: string, name: string) => void;
  newPage: (preset?: [string, CellWrite]) => Promise<Row | null>;
  rename: (row: Row, title: string) => Promise<void>;
  open: (row: Row, newTab: boolean) => void;
  /** Menu of a property (table header, board settings): sort, filter, type, options, hide. */
  propMenu: (key: string, anchor: Element) => void;
  addProperty: (anchor: Element) => void;
  /** Moves a row before `beforeId` (`null`: to the end) in the sidebar order. */
  moveRow: (row: Row, beforeId: number | null) => void;
}

export const VIEW_LABEL: Record<ViewType, string> = { liste: "Liste", tabelle: "Tabelle", board: "Board" };
const VIEW_ICON: Record<ViewType, LucideIcon> = { liste: List, tabelle: Table2, board: KanbanSquare };

export function CollectionView({ pageId, fm, onFm }: { pageId: number; fm: string; onFm: (fm: string) => void }) {
  const view = useMemo(() => parseView(fm), [fm]);
  const defs = useMemo(() => parseSchema(fm), [fm]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [menu, , openMenuAt] = useMenu();
  const [options, setOptions] = useState<string | null>(null);
  const [adding, setAdding] = useState<Element | null>(null);
  const [filterEdit, setFilterEdit] = useState<{ index: number; anchor: Element } | null>(null);
  // The latest frontmatter, also between two changes in one event (before React re-renders).
  const fmRef = useRef(fm);
  fmRef.current = fm;
  const applyFm = useCallback(
    (next: string) => {
      fmRef.current = next;
      onFm(next);
    },
    [onFm],
  );
  const s = useApp.getState;

  // Reload when the children change in the tree (new, renamed, moved, deleted pages).
  const childSig = useApp((st) =>
    (st.pages.get(pageId)?.children ?? []).map((c) => `${c.id}:${c.title}:${c.icon ?? ""}:${c.position}`).join("|"),
  );
  const load = useCallback(() => {
    let alive = true;
    api
      .pageCollection(pageId)
      .then((c) => alive && setRows(c.rows.map((r) => makeRow(r, r.frontmatter))))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [pageId]);
  useEffect(() => (view.type === "liste" ? undefined : load()), [load, childSig, view.type === "liste"]); // eslint-disable-line react-hooks/exhaustive-deps

  // A child saved elsewhere (its pane, the property editor): take over its frontmatter.
  useEffect(() => {
    const take = (id: number, fm: string) => setRows((rs) => rs?.map((r) => (r.id === id && r.fm !== fm ? { ...makeRow(r, fm), title: r.title } : r)) ?? rs);
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; content: string }>).detail;
      if (d.content !== undefined) take(d.id, splitFrontmatter(d.content).frontmatter);
    };
    const onFm = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; fm: string }>).detail;
      take(d.id, d.fm);
    };
    window.addEventListener("annalo:page-saved", onSaved);
    window.addEventListener(FRONTMATTER_EVENT, onFm);
    return () => {
      window.removeEventListener("annalo:page-saved", onSaved);
      window.removeEventListener(FRONTMATTER_EVENT, onFm);
    };
  }, []);

  const today = todayIso();
  const shown = useMemo(() => (rows ? sortRows(filterRows(rows, view.filters, defs, today), view.sort, defs) : []), [rows, view.filters, view.sort, defs, today]);

  // Changes of the view and the schema always start from the latest frontmatter.
  const changeView = useCallback((change: (v: ViewSettings) => ViewSettings) => applyFm(setView(fmRef.current, change(parseView(fmRef.current)))), [applyFm]);
  const changeDefs = useCallback((change: (d: PropDef[]) => PropDef[] | null) => applyFm(setSchema(fmRef.current, change(parseSchema(fmRef.current) ?? []))), [applyFm]);

  const write = useCallback((row: Row, key: string, value: CellWrite, undo?: string) => {
    const apply = (change: (f: string) => string) => {
      setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...makeRow(r, change(r.fm)), title: r.title } : r)) ?? rs);
      return updateFrontmatter(row.id, change).catch((e) => {
        s().error("Eigenschaft konnte nicht gespeichert werden", e);
        load();
      });
    };
    apply((f) => writeValue(f, key, value));
    if (!undo) return;
    const before = row.props.find((p) => p.key.toLowerCase() === key.toLowerCase());
    s().toast({ tone: "info", title: undo, action: { label: "Rückgängig", run: () => void apply((f) => setEntry(f, key, before ? propertyLines(before) : null)) } });
  }, [load, s]);

  const addOption = useCallback((key: string, name: string) => {
    changeDefs((ds) => ds.map((d) => (d.key.toLowerCase() === key.toLowerCase() && !d.options.some((o) => o.name.toLowerCase() === name.toLowerCase()) ? { ...d, options: [...d.options, { name, color: COLORS[d.options.length % COLORS.length] }] } : d)));
  }, [changeDefs]);

  const newPage = useCallback(async (preset?: [string, CellWrite]) => {
    try {
      const icon = s().settings?.settings.editor?.default_icon ?? "file-text";
      const content = preset && preset[1] !== null ? writeValue("", preset[0], preset[1]) : undefined;
      const p = await api.createPage("Unbenannt", pageId, icon, content);
      const row = makeRow(p, content ?? "");
      setRows((rs) => [...(rs ?? []), row]);
      await s().refreshTree();
      return row;
    } catch (e) {
      s().error("Seite konnte nicht angelegt werden", e);
      return null;
    }
  }, [pageId, s]);

  const rename = useCallback(async (row: Row, title: string) => {
    const t = title.trim();
    if (!t || t === row.title) return;
    try {
      await flushAllEditors();
      const n = await api.renamePage(row.id, t, true);
      setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, title: t } : r)) ?? rs);
      reloadEditors();
      await s().refreshTree();
      if (n > 0) s().toast({ tone: "info", title: "Umbenannt", detail: `Links in ${n} ${n === 1 ? "Seite" : "Seiten"} aktualisiert` });
    } catch (e) {
      s().error("Umbenennen nicht möglich", e);
    }
  }, [s]);

  const open = useCallback((row: Row, newTab: boolean) => s().openPage(row.id, { newTab }), [s]);

  const moveRow = useCallback(async (row: Row, beforeId: number | null) => {
    const others = (rows ?? []).filter((r) => r.id !== row.id);
    const at = beforeId === null ? others.length : Math.max(0, others.findIndex((r) => r.id === beforeId));
    setRows([...others.slice(0, at), row, ...others.slice(at)]);
    try {
      await api.movePage(row.id, pageId, at);
      await s().refreshTree();
    } catch (e) {
      s().error("Reihenfolge konnte nicht gespeichert werden", e);
      load();
    }
  }, [rows, pageId, load, s]);

  /** Sets a property's type; unknown properties join the schema. Values stay as they are. */
  const changeKind = (key: string, kind: PropKind) => {
    const values = (rows ?? []).map((r) => cellOf(r, key).text);
    changeDefs((ds) => {
      const prev = defOf(ds, key);
      const next = { key: prev?.key ?? key, kind, options: optionsForKind(kind, prev, values) };
      return prev ? ds.map((d) => (d === prev ? next : d)) : [...ds, next];
    });
  };

  const renameOptions = async (key: string, renames: [string, string][]) => {
    for (const r of rows ?? []) {
      const cell = cellOf(r, key);
      if (!cell.items.some((i) => renames.some(([old]) => old.toLowerCase() === i.toLowerCase()))) continue;
      const items = cell.items.map((i) => renames.find(([old]) => old.toLowerCase() === i.toLowerCase())?.[1] ?? i);
      write(r, key, kindOf(defs, key) === "multi_select" ? items : items[0]);
    }
  };

  const propMenu = (key: string, anchor: Element) => {
    const def = defOf(defs, key);
    const kind = def?.kind ?? "text";
    const sorted = view.sort?.field.toLowerCase() === key.toLowerCase() ? view.sort.dir : null;
    const items: MenuEntry[] = [
      { label: "Aufsteigend sortieren", icon: ArrowUp, checked: sorted === "auf", onSelect: () => changeView((v) => ({ ...v, sort: { field: key, dir: "auf" } })) },
      { label: "Absteigend sortieren", icon: ArrowDown, checked: sorted === "ab", onSelect: () => changeView((v) => ({ ...v, sort: { field: key, dir: "ab" } })) },
      ...(sorted ? [{ label: "Sortierung entfernen", icon: X, onSelect: () => changeView((v) => ({ ...v, sort: null })) }] : []),
      { label: "Filtern…", icon: ListFilter, onSelect: () => addFilter(key) },
    ];
    if (key !== TITLE) {
      items.push(
        "separator",
        { label: "Typ ändern", icon: KIND_ICON[kind], submenu: kindMenu(def ? kind : ("" as PropKind), (k) => changeKind(key, k), KINDS) },
        ...(def && hasOptions(def.kind) ? [{ label: "Optionen bearbeiten…", icon: Settings2, onSelect: () => setOptions(def.key) }] : []),
        { label: "Spalte ausblenden", icon: EyeOff, onSelect: () => changeView((v) => ({ ...v, hidden: [...v.hidden, key] })) },
        ...(def ? [{ label: "Aus dem Schema entfernen", icon: Trash2, danger: true, onSelect: () => changeDefs((ds) => ds.filter((d) => d !== defOf(ds, key))) }] : []),
      );
    }
    openMenuAt(anchor, items);
  };

  const addFilter = (key?: string) => {
    const field = key ?? defs?.[0]?.key ?? TITLE;
    const kind = kindOf(defs, field);
    const op = opsFor(kind)[0].op;
    const index = view.filters.length;
    changeView((v) => ({ ...v, filters: [...v.filters, { field, op, value: kind === "checkbox" ? "ja" : "" }] }));
    // The new chip opens its editor once it is rendered.
    setTimeout(() => {
      const chip = document.querySelector(`.coll[data-page="${pageId}"] .coll-filter[data-index="${index}"]`);
      if (chip) setFilterEdit({ index, anchor: chip });
    }, 60);
  };

  const ctxRows = rows ?? [];
  const ctx: Ctx = {
    parentId: pageId,
    defs,
    view,
    rows: ctxRows,
    shown,
    setView: (v) => applyFm(setView(fmRef.current, v)),
    write,
    addOption,
    newPage,
    rename,
    open,
    propMenu,
    addProperty: (anchor) => setAdding(anchor),
    moveRow,
  };

  if (view.type === "liste") return null;
  const hiddenCols = view.hidden.filter((h) => h !== TITLE);
  const allKeys = columnKeys(defs, ctxRows, { ...view, hidden: [] }).filter((k) => k !== TITLE);
  const count = rows ? (shown.length === rows.length ? `${rows.length} ${rows.length === 1 ? "Seite" : "Seiten"}` : `${shown.length} von ${rows.length}`) : "";

  return (
    <section className={`coll coll-${view.type}`} data-page={pageId} aria-label={`${VIEW_LABEL[view.type]} der Unterseiten`}>
      <div className="coll-bar">
        <div className="coll-switch" role="radiogroup" aria-label="Ansicht">
          {(["liste", "tabelle", "board"] as ViewType[]).map((t) => {
            const Icon = VIEW_ICON[t];
            return (
              <button key={t} type="button" role="radio" aria-checked={view.type === t} className={view.type === t ? "on" : ""} onClick={() => changeView((v) => ({ ...v, type: t }))} data-tooltip={t === "liste" ? "Nur die Seitenliste in der Seitenleiste" : undefined}>
                <Icon size={13} aria-hidden /> {VIEW_LABEL[t]}
              </button>
            );
          })}
        </div>
        <span className="coll-count faint">{count}</span>
        <div className="coll-tools">
          {view.sort && (
            <span className="coll-sort">
              <button type="button" className="coll-chip-btn" onClick={() => changeView((v) => ({ ...v, sort: v.sort && { ...v.sort, dir: v.sort.dir === "auf" ? "ab" : "auf" } }))} aria-label={`Sortiert nach ${fieldLabel(view.sort.field)}, ${view.sort.dir === "auf" ? "aufsteigend" : "absteigend"}`}>
                {view.sort.dir === "auf" ? <ArrowUp size={12} /> : <ArrowDown size={12} />} {fieldLabel(view.sort.field)}
              </button>
              <button type="button" className="coll-chip-x" aria-label="Sortierung entfernen" onClick={() => changeView((v) => ({ ...v, sort: null }))}>
                <X size={11} />
              </button>
            </span>
          )}
          <Button size="sm" variant="ghost" icon={Filter} onClick={() => addFilter()}>
            Filter
          </Button>
          {view.type === "board" && <BoardGroupSelect ctx={ctx} />}
          <IconButton
            icon={Columns3}
            label="Eigenschaften"
            size="sm"
            onClick={(e) =>
              openMenuAt(e, [
                ...allKeys.map((k) => {
                  const cards = boardCards(view, defs, boardGroup(view, defs));
                  const shownCol = view.type === "board" ? cards.some((c) => c.toLowerCase() === k.toLowerCase()) : !hiddenCols.some((h) => h.toLowerCase() === k.toLowerCase());
                  return {
                    label: k,
                    checked: shownCol,
                    icon: KIND_ICON[kindOf(defs, k)],
                    onSelect: () =>
                      changeView((v) =>
                        v.type === "board"
                          ? { ...v, cards: shownCol ? cards.filter((c) => c.toLowerCase() !== k.toLowerCase()) : [...cards, k] }
                          : { ...v, hidden: shownCol ? [...v.hidden, k] : v.hidden.filter((h) => h.toLowerCase() !== k.toLowerCase()) },
                      ),
                  };
                }),
                ...(allKeys.length ? (["separator"] as MenuEntry[]) : []),
                { label: "Eigenschaft hinzufügen…", icon: Plus, onSelect: () => setAdding(document.querySelector(`.coll[data-page="${pageId}"] .coll-tools`)) },
              ])
            }
          />
          <Button size="sm" icon={Plus} onClick={() => newPage()}>
            Neue Seite
          </Button>
        </div>
      </div>
      {view.filters.length > 0 && (
        <div className="coll-filters" role="list" aria-label="Filter">
          {view.filters.map((f, i) => (
            <span key={i} className="coll-filter" role="listitem" data-index={i}>
              <button type="button" className="coll-chip-btn" onClick={(e) => setFilterEdit({ index: i, anchor: e.currentTarget.parentElement! })}>
                <span className="strong">{fieldLabel(f.field)}</span> {opsFor(kindOf(defs, f.field)).find((o) => o.op === f.op)?.label ?? f.op} {filterValueLabel(f)}
              </button>
              <button type="button" className="coll-chip-x" aria-label="Filter entfernen" onClick={() => changeView((v) => ({ ...v, filters: v.filters.filter((_, j) => j !== i) }))}>
                <X size={11} />
              </button>
            </span>
          ))}
          <button type="button" className="coll-filter-clear" onClick={() => changeView((v) => ({ ...v, filters: [] }))}>
            Alle entfernen
          </button>
        </div>
      )}
      {rows === null ? (
        <div className="coll-loading" />
      ) : view.type === "tabelle" ? (
        <TableView ctx={ctx} />
      ) : (
        <BoardView ctx={ctx} />
      )}
      {menu}
      {options && defOf(defs, options) && (
        <OptionsDialog
          def={defOf(defs, options)!}
          onClose={() => setOptions(null)}
          onSave={(opts, renames) => {
            changeDefs((ds) => ds.map((d) => (d.key === options ? { ...d, options: opts } : d)));
            if (renames.length) renameOptions(options, renames);
          }}
        />
      )}
      {adding && (
        <Popover anchor={adding} label="Eigenschaft hinzufügen" onClose={() => setAdding(null)}>
          <NewPropertyForm
            taken={(k) => allKeys.some((x) => x.toLowerCase() === k.toLowerCase()) || k.toLowerCase() === TITLE || isManagedKey(k)}
            onAdd={(key, kind) => {
              const values = ctxRows.map((r) => cellOf(r, key).text);
              changeDefs((ds) => [...ds.filter((d) => d.key.toLowerCase() !== key.toLowerCase()), { key, kind, options: optionsForKind(kind, undefined, values) }]);
              changeView((v) => ({ ...v, hidden: v.hidden.filter((h) => h.toLowerCase() !== key.toLowerCase()) }));
              setAdding(null);
            }}
          />
        </Popover>
      )}
      {filterEdit && view.filters[filterEdit.index] && (
        <Popover anchor={filterEdit.anchor} label="Filter bearbeiten" onClose={() => setFilterEdit(null)}>
          <FilterForm
            filter={view.filters[filterEdit.index]}
            defs={defs}
            fields={[TITLE, ...allKeys]}
            onChange={(f) => changeView((v) => ({ ...v, filters: v.filters.map((x, j) => (j === filterEdit.index ? f : x)) }))}
            onDone={() => setFilterEdit(null)}
          />
        </Popover>
      )}
    </section>
  );
}

const filterValueLabel = (f: FilterSpec) => {
  if (/leer$/.test(f.op)) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.value)) return new Date(`${f.value}T12:00:00`).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  return f.value ? `„${f.value}“` : "…";
};

/** The property the board groups by: the chosen one, else the first that can. */
export function boardGroup(view: ViewSettings, defs: PropDef[] | null): string | null {
  const options = (defs ?? []).filter((d) => groupable(d.kind));
  const chosen = view.group ? options.find((d) => d.key.toLowerCase() === view.group!.toLowerCase()) : undefined;
  return (chosen ?? options[0])?.key ?? null;
}

function BoardGroupSelect({ ctx }: { ctx: Ctx }) {
  const options = (ctx.defs ?? []).filter((d) => groupable(d.kind));
  const current = boardGroup(ctx.view, ctx.defs);
  if (!current) return null;
  return (
    <label className="coll-group">
      <span className="faint">Gruppiert nach</span>
      <Select value={current} aria-label="Gruppieren nach" onChange={(e) => ctx.setView({ ...ctx.view, group: e.target.value })}>
        {options.map((d) => (
          <option key={d.key} value={d.key}>
            {d.key}
          </option>
        ))}
      </Select>
    </label>
  );
}

function NewPropertyForm({ taken, onAdd }: { taken: (key: string) => boolean; onAdd: (key: string, kind: PropKind) => void }) {
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<PropKind>("select");
  const k = key.trim();
  const invalid = !!k && (!isValidKey(k) || taken(k));
  const submit = () => k && !invalid && onAdd(k, kind);
  return (
    <form
      className="coll-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="coll-form-row">
        <span className="faint">Name</span>
        <input className="input" autoFocus value={key} placeholder="z. B. status" aria-label="Name der Eigenschaft" aria-invalid={invalid || undefined} spellCheck={false} onChange={(e) => setKey(e.target.value.replace(/[:\n]/g, ""))} />
      </label>
      <div className="coll-kinds" role="radiogroup" aria-label="Typ">
        {KINDS.map((t) => {
          const Icon = KIND_ICON[t.kind];
          return (
            <button key={t.kind} type="button" role="radio" aria-checked={kind === t.kind} className={`coll-kind ${kind === t.kind ? "on" : ""}`} onClick={() => setKind(t.kind)}>
              <Icon size={13} aria-hidden /> {t.label}
            </button>
          );
        })}
      </div>
      {invalid && <div className="prop-key-hint" role="alert">{taken(k) ? "Diesen Namen gibt es schon" : "Ungültiger Name"}</div>}
      <div className="coll-form-foot">
        <Button size="sm" variant="primary" type="submit" disabled={!k || invalid}>
          Hinzufügen
        </Button>
      </div>
    </form>
  );
}

function FilterForm({ filter, defs, fields, onChange, onDone }: { filter: FilterSpec; defs: PropDef[] | null; fields: string[]; onChange: (f: FilterSpec) => void; onDone: () => void }) {
  const kind = kindOf(defs, filter.field);
  const ops = opsFor(kind);
  const op = ops.find((o) => o.op === filter.op) ?? ops[0];
  const def = defOf(defs, filter.field);
  let value: ReactNode = null;
  if (op.value) {
    if (def && (def.kind === "select" || def.kind === "multi_select")) {
      value = (
        <Select value={filter.value} aria-label="Wert" onChange={(e) => onChange({ ...filter, value: e.target.value })}>
          <option value="">Option wählen</option>
          {def.options.map((o) => (
            <option key={o.name} value={o.name}>
              {o.name}
            </option>
          ))}
        </Select>
      );
    } else if (kind === "checkbox") {
      value = (
        <Select value={filter.value || "ja"} aria-label="Wert" onChange={(e) => onChange({ ...filter, value: e.target.value })}>
          <option value="ja">Ja</option>
          <option value="nein">Nein</option>
        </Select>
      );
    } else if (kind === "date") {
      value = (
        <span className="coll-date-value">
          {filter.value === "heute" ? (
            <span className="coll-today">heute</span>
          ) : (
            <DateInput value={/^\d{4}-/.test(filter.value) ? filter.value : ""} aria-label="Datum" onChange={(v) => onChange({ ...filter, value: v })} />
          )}
          <Button size="sm" variant={filter.value === "heute" ? "secondary" : "ghost"} onClick={() => onChange({ ...filter, value: filter.value === "heute" ? "" : "heute" })}>
            {filter.value === "heute" ? "Datum wählen" : "Heute"}
          </Button>
        </span>
      );
    } else {
      value = <input className="input" autoFocus value={filter.value} aria-label="Wert" placeholder="Wert" spellCheck={false} onChange={(e) => onChange({ ...filter, value: e.target.value })} onKeyDown={(e) => e.key === "Enter" && onDone()} />;
    }
  }
  return (
    <div className="coll-form coll-filter-form">
      <div className="coll-filter-grid">
        <Select
          value={filter.field}
          aria-label="Eigenschaft"
          onChange={(e) => {
            const field = e.target.value;
            const nextOps = opsFor(kindOf(defs, field));
            onChange({ field, op: nextOps.some((o) => o.op === filter.op) ? filter.op : nextOps[0].op, value: kindOf(defs, field) === "checkbox" ? "ja" : "" });
          }}
        >
          {fields.map((f) => (
            <option key={f} value={f}>
              {fieldLabel(f)}
            </option>
          ))}
        </Select>
        <Select value={op.op} aria-label="Bedingung" onChange={(e) => onChange({ ...filter, op: e.target.value })}>
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </Select>
        {value}
      </div>
      <div className="coll-form-foot">
        <Button size="sm" variant="primary" onClick={onDone}>
          Fertig
        </Button>
      </div>
    </div>
  );
}
