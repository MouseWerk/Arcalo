// Table of the child pages: title plus one column per property. Resizable and reorderable
// columns, sort by clicking a header, inline editing with the typed controls, keyboard
// navigation between cells, rows rendered in a window for large folders.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, ChevronDown, FileText, Plus, SquareArrowOutUpRight } from "lucide-react";
import { PageIcon } from "../../components/icons";
import { pickDate } from "../../components/CalendarPopover";
import { TITLE, cellOf, columnKeys, defOf, fieldLabel, kindOf, writeFromText, type CellWrite, type PropKind, type Row } from "../../lib/collection";
import { CellDisplay, ComboInput, Invalid, KIND_ICON, OptionPicker, Popover, editText, openLink, suggestLinks, suggestPersons } from "./controls";
import type { Ctx } from "./CollectionView";

const ROW_H = 34;
/** Folders up to this size render every row; larger ones only the visible window. */
const WINDOW_FROM = 80;
const MIN_W = 72;
const DEFAULT_W: Record<PropKind | "title", number> = { title: 240, text: 170, select: 140, multi_select: 200, number: 104, date: 124, person: 150, checkbox: 96, link: 190 };

type Pos = { id: number; key: string };

/** A new page from the table takes the values its filters ask for, so it stays visible. */
function presetFromFilters(ctx: Ctx): [string, CellWrite] | undefined {
  for (const f of ctx.view.filters) {
    if (f.op !== "ist" || !f.value || f.field === TITLE) continue;
    const kind = kindOf(ctx.defs, f.field);
    if (kind === "checkbox") return [f.field, /^(ja|true|yes|x|1)$/i.test(f.value)];
    if (kind === "select" || kind === "person" || kind === "text") return [f.field, f.value];
    if (kind === "multi_select") return [f.field, [f.value]];
  }
  return undefined;
}

/** Stands in for the rows outside the rendered window (always present, so the rows around it keep their place). */
function Spacer({ rows, cols }: { rows: number; cols: number }) {
  return (
    <tr className="coll-spacer" aria-hidden>
      <td colSpan={cols} style={{ height: rows * ROW_H }} />
    </tr>
  );
}

export function TableView({ ctx }: { ctx: Ctx }) {
  const { defs, view, shown } = ctx;
  const cols = columnKeys(defs, ctx.rows, view);
  const [live, setLive] = useState<Record<string, number>>({});
  const width = (k: string) => live[k] ?? view.widths[k] ?? DEFAULT_W[k === TITLE ? "title" : kindOf(defs, k)];
  const wrap = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 640 });
  const [focus, setFocus] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<(Pos & { seed?: string }) | null>(null);
  const [picker, setPicker] = useState<(Pos & { anchor: Element }) | null>(null);
  const [colDrag, setColDrag] = useState<{ key: string; dx: number; target: number } | null>(null);
  // Focus follows the keyboard only while the table has it (not after a click elsewhere).
  const wantFocus = useRef(false);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setScroll({ top: el.scrollTop, height: el.clientHeight || 640 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const windowed = shown.length > WINDOW_FROM;
  const start = windowed ? Math.max(0, Math.floor(scroll.top / ROW_H) - 10) : 0;
  const end = windowed ? Math.min(shown.length, Math.ceil((scroll.top + scroll.height) / ROW_H) + 10) : shown.length;
  // WebKit anchors the scroll position to a row when the window moves (overflow-anchor is not
  // supported there): the position before the commit is the one to keep.
  const beforeCommit = useRef(0);
  beforeCommit.current = wrap.current?.scrollTop ?? 0;
  useLayoutEffect(() => {
    const el = wrap.current;
    if (el && windowed && el.scrollTop !== beforeCommit.current) el.scrollTop = beforeCommit.current;
  });

  const cellEl = (p: Pos) => wrap.current?.querySelector<HTMLElement>(`[data-cell="${p.id}:${CSS.escape(p.key)}"]`) ?? null;
  const focusCell = (p: Pos | null) => {
    setFocus(p);
    if (!p) return;
    wantFocus.current = true;
    // Rows outside the rendered window come into view first.
    const i = shown.findIndex((r) => r.id === p.id);
    const el = wrap.current;
    if (el && i >= 0) {
      const top = i * ROW_H;
      const head = ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H + head > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H + head - el.clientHeight;
    }
  };
  useEffect(() => {
    if (!focus || editing || picker || !wantFocus.current) return;
    const el = cellEl(focus);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  });

  const rowOf = (id: number) => ctx.rows.find((r) => r.id === id);
  const done = (p: Pos) => {
    setEditing(null);
    setPicker(null);
    focusCell(p);
  };

  const startEdit = (row: Row, key: string, seed?: string) => {
    const p = { id: row.id, key };
    const kind = key === TITLE ? "title" : kindOf(defs, key);
    const def = defOf(defs, key);
    const cell = cellOf(row, key, def);
    if (kind === "checkbox") {
      const on = cell.value?.kind === "checkbox" && cell.value.value;
      ctx.write(row, key, !on);
      return focusCell(p);
    }
    const el = cellEl(p);
    if (kind === "select" || kind === "multi_select") {
      if (el && def) setPicker({ ...p, anchor: el });
      return;
    }
    if (kind === "date" && !seed) {
      if (!el) return;
      const iso = cell.value?.kind === "date" ? cell.value.value : "";
      wantFocus.current = false;
      pickDate(el, iso, (v) => {
        ctx.write(row, key, v);
        focusCell(p);
      });
      return;
    }
    setEditing({ ...p, seed });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const td = (e.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    if (!td || editing || picker || (e.target as HTMLElement).tagName === "INPUT") return;
    const [idText, ...rest] = td.dataset.cell!.split(":");
    const p = { id: Number(idText), key: rest.join(":") };
    const r = shown.findIndex((x) => x.id === p.id);
    const c = cols.indexOf(p.key);
    const row = shown[r];
    if (!row || c < 0) return;
    const move = (dr: number, dc: number) => {
      const nr = Math.max(0, Math.min(shown.length - 1, r + dr));
      const nc = Math.max(0, Math.min(cols.length - 1, c + dc));
      e.preventDefault();
      focusCell({ id: shown[nr].id, key: cols[nc] });
    };
    const kind = p.key === TITLE ? "title" : kindOf(defs, p.key);
    switch (e.key) {
      case "ArrowUp":
        return move(-1, 0);
      case "ArrowDown":
        return move(1, 0);
      case "ArrowLeft":
        return move(0, -1);
      case "ArrowRight":
        return move(0, 1);
      case "Tab":
        return move(0, e.shiftKey ? -1 : 1);
      case "Home":
        return move(0, -cols.length);
      case "End":
        return move(0, cols.length);
      case "Enter":
      case "F2":
        e.preventDefault();
        if (p.key === TITLE && (e.ctrlKey || e.metaKey)) return ctx.open(row, true);
        return startEdit(row, p.key);
      case " ":
        if (kind === "checkbox") {
          e.preventDefault();
          startEdit(row, p.key);
        }
        return;
      case "Escape":
        e.preventDefault();
        wantFocus.current = false;
        setFocus(null);
        td.blur();
        return;
      case "Delete":
      case "Backspace":
        if (p.key !== TITLE) {
          e.preventDefault();
          if (cellOf(row, p.key).text) ctx.write(row, p.key, null, `${fieldLabel(p.key)} von „${row.title}“ geleert`);
        }
        return;
    }
    const typing = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (typing && ["title", "text", "number", "person", "link", "date"].includes(kind)) {
      e.preventDefault();
      if (kind === "date") return;
      startEdit(row, p.key, e.key);
    }
  };

  // ---- header: click sorts, drag reorders, the edge resizes
  const onHeadDown = (e: ReactPointerEvent, key: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, .coll-resize")) return;
    const x0 = e.clientX;
    let moved = false;
    const heads = [...(wrap.current?.querySelectorAll<HTMLElement>("th[data-col]") ?? [])];
    const targetAt = (x: number) => {
      let t = 1;
      heads.forEach((h, i) => {
        const r = h.getBoundingClientRect();
        if (i > 0 && x > r.left + r.width / 2) t = i + 1;
      });
      return Math.max(1, Math.min(heads.length, t));
    };
    const onMove = (ev: PointerEvent) => {
      if (key === TITLE) return;
      if (!moved && Math.abs(ev.clientX - x0) < 5) return;
      moved = true;
      setColDrag({ key, dx: ev.clientX - x0, target: targetAt(ev.clientX) });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setColDrag(null);
      if (!moved) {
        const s = view.sort;
        const same = s?.field.toLowerCase() === key.toLowerCase();
        ctx.setView({ ...view, sort: !same ? { field: key, dir: "auf" } : s!.dir === "auf" ? { field: key, dir: "ab" } : null });
        return;
      }
      const from = cols.indexOf(key);
      let to = targetAt(ev.clientX);
      if (to > from) to -= 1;
      if (to === from) return;
      const order = cols.filter((k) => k !== key);
      order.splice(to, 0, key);
      ctx.setView({ ...view, columns: order });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onResizeDown = (e: ReactPointerEvent, key: string) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = width(key);
    let w = w0;
    const onMove = (ev: PointerEvent) => {
      w = Math.max(MIN_W, Math.round(w0 + ev.clientX - x0));
      setLive({ [key]: w });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setLive({});
      if (w !== w0) ctx.setView({ ...view, widths: { ...view.widths, [key]: w } });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const addRow = async () => {
    const row = await ctx.newPage(presetFromFilters(ctx));
    if (row) setTimeout(() => setEditing({ id: row.id, key: TITLE }), 30);
  };

  const total = cols.reduce((n, k) => n + width(k), 0) + 44;
  const pickerRow = picker ? rowOf(picker.id) : undefined;
  const pickerDef = picker ? defOf(defs, picker.key) : undefined;

  return (
    <div
      className="coll-table-wrap"
      ref={wrap}
      onScroll={(e) => windowed && setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      onKeyDown={onKey}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) wantFocus.current = false;
      }}
    >
      <table className="coll-table" role="grid" aria-rowcount={shown.length + 1} aria-colcount={cols.length} style={{ width: `max(100%, ${total}px)` }}>
        <colgroup>
          {cols.map((k) => (
            <col key={k} style={{ width: width(k) }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr role="row">
            {cols.map((k, i) => {
              const Icon = k === TITLE ? FileText : KIND_ICON[kindOf(defs, k)];
              const sorted = view.sort?.field.toLowerCase() === k.toLowerCase() ? view.sort.dir : null;
              const dragging = colDrag?.key === k;
              return (
                <th
                  key={k}
                  data-col={k}
                  role="columnheader"
                  aria-sort={sorted === "auf" ? "ascending" : sorted === "ab" ? "descending" : "none"}
                  className={`coll-th${k === TITLE ? " coll-sticky" : ""}${dragging ? " dragging" : ""}${colDrag && colDrag.target === i && !dragging ? " drop-before" : ""}${colDrag && colDrag.target === cols.length && i === cols.length - 1 && !dragging ? " drop-after" : ""}`}
                  style={dragging ? { transform: `translateX(${colDrag.dx}px)` } : undefined}
                >
                  <div className="coll-th-inner" onPointerDown={(e) => onHeadDown(e, k)} title={k === TITLE ? "Klicken sortiert" : "Klicken sortiert, Ziehen verschiebt die Spalte"}>
                    <Icon size={13} className="coll-th-icon" aria-hidden />
                    <span className="coll-th-label">{fieldLabel(k)}</span>
                    {sorted && (sorted === "auf" ? <ArrowUp size={12} className="coll-th-sort" aria-hidden /> : <ArrowDown size={12} className="coll-th-sort" aria-hidden />)}
                    <button type="button" className="coll-th-menu" aria-label={`Menü von ${fieldLabel(k)}`} onClick={(e) => ctx.propMenu(k, e.currentTarget.closest("th")!)}>
                      <ChevronDown size={13} />
                    </button>
                  </div>
                  <span className="coll-resize" role="separator" aria-orientation="vertical" aria-label={`Breite von ${fieldLabel(k)}`} onPointerDown={(e) => onResizeDown(e, k)} />
                </th>
              );
            })}
            <th className="coll-th coll-th-add">
              <button type="button" className="coll-add-col" aria-label="Eigenschaft hinzufügen" data-tooltip="Eigenschaft hinzufügen" onClick={(e) => ctx.addProperty(e.currentTarget)}>
                <Plus size={14} />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {windowed && <Spacer rows={start} cols={cols.length + 1} />}
          {shown.slice(start, end).map((row, i) => (
            <tr key={row.id} role="row" aria-rowindex={start + i + 2} className="coll-row" data-row={row.id}>
              {cols.map((k) => {
                const def = defOf(defs, k);
                const cell = cellOf(row, k, def);
                const p = { id: row.id, key: k };
                const isFocus = focus?.id === row.id && focus.key === k;
                const isEdit = editing?.id === row.id && editing.key === k;
                const kind = k === TITLE ? "title" : kindOf(defs, k);
                return (
                  <td
                    key={k}
                    role="gridcell"
                    data-cell={`${row.id}:${k}`}
                    data-kind={kind}
                    tabIndex={isFocus || (!focus && i === 0 && k === TITLE) ? 0 : -1}
                    aria-invalid={cell.error ? true : undefined}
                    className={`coll-td${k === TITLE ? " coll-sticky coll-title-cell" : ""}${isFocus ? " focus" : ""}${isEdit ? " editing" : ""}${cell.error ? " invalid" : ""}`}
                    onFocus={() => !isFocus && setFocus(p)}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("button, input")) return;
                      // Ctrl+click follows a link instead of editing it.
                      if ((e.ctrlKey || e.metaKey) && cell.value?.kind === "link") return void openLink(cell.value.value, true);
                      focusCell(p);
                      if (k !== TITLE && !isEdit) startEdit(row, k);
                    }}
                    onDoubleClick={() => k === TITLE && startEdit(row, k)}
                  >
                    {isEdit ? (
                      <ComboInput
                        autoFocus
                        seeded={editing?.seed !== undefined}
                        value={editing?.seed ?? (k === TITLE ? row.title : editText(cell))}
                        label={fieldLabel(k)}
                        className="coll-input"
                        suggest={kind === "person" ? suggestPersons : kind === "link" ? suggestLinks : undefined}
                        onCommit={(text) => {
                          if (k === TITLE) ctx.rename(row, text);
                          else if (text.trim() !== editText(cell).trim()) ctx.write(row, k, writeFromText(def, text));
                          done(p);
                        }}
                        onCancel={() => done(p)}
                      />
                    ) : k === TITLE ? (
                      <span className="coll-title">
                        <PageIcon name={row.icon} size={14} />
                        <button type="button" className="coll-title-link" tabIndex={-1} onClick={(e) => ctx.open(row, e.ctrlKey || e.metaKey)} title="Öffnen (Strg+Klick: neuer Tab)">
                          {row.title}
                        </button>
                        <button type="button" className="coll-open" tabIndex={-1} aria-label={`${row.title} öffnen`} onClick={(e) => ctx.open(row, e.ctrlKey || e.metaKey)}>
                          <SquareArrowOutUpRight size={12} /> Öffnen
                        </button>
                      </span>
                    ) : (
                      <Invalid error={cell.error}>
                        <CellDisplay def={def} cell={cell} />
                      </Invalid>
                    )}
                  </td>
                );
              })}
              <td className="coll-td coll-td-pad" aria-hidden />
            </tr>
          ))}
          {windowed && <Spacer rows={shown.length - end} cols={cols.length + 1} />}
          {!shown.length && (
            <tr className="coll-empty-row">
              <td colSpan={cols.length + 1}>
                <span className="coll-empty-text">{ctx.rows.length ? "Keine Seite passt zu den Filtern." : "Noch keine Unterseiten."}</span>
                {ctx.rows.length > 0 && (
                  <button type="button" className="coll-link-btn" onClick={() => ctx.setView({ ...view, filters: [] })}>
                    Filter entfernen
                  </button>
                )}
              </td>
            </tr>
          )}
          <tr className="coll-new-row">
            <td colSpan={cols.length + 1}>
              <button type="button" className="coll-new" onClick={addRow}>
                <Plus size={13} /> Neue Seite
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {picker && pickerRow && pickerDef && (
        <Popover anchor={picker.anchor} label={pickerDef.key} onClose={() => done(picker)}>
          <OptionPicker
            def={pickerDef}
            selected={(() => {
              const c = cellOf(pickerRow, picker.key, pickerDef);
              return c.value?.kind === "select" ? [c.value.value] : c.value?.kind === "multi_select" ? c.value.value : c.items;
            })()}
            onAddOption={(name) => ctx.addOption(pickerDef.key, name)}
            onClose={() => done(picker)}
            onChange={(v) => ctx.write(pickerRow, picker.key, pickerDef.kind === "select" ? (v[0] ?? null) : v)}
          />
        </Popover>
      )}
    </div>
  );
}
