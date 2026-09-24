// Board of the child pages: one column per option of a select (or per person, or ja/nein),
// plus „Ohne Wert“. Dragging a card to another column sets the property on that page;
// dragging within a column changes the page order (the sidebar order of the folder).

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronsLeftRight, ChevronsRightLeft, CircleDot, KanbanSquare, MoreHorizontal, Plus, SquareArrowOutUpRight } from "lucide-react";
import { PageIcon } from "../../components/icons";
import { Button, EmptyState, IconButton, useMenu, type MenuEntry } from "../../components/ui";
import { boardCards, cellOf, defOf, fieldLabel, groupRows, groupWrite, groupable, type Group, type PropDef, type Row } from "../../lib/collection";
import { CellDisplay, Invalid, OptionChip } from "./controls";
import type { Ctx } from "./CollectionView";

type Drag = { row: Row; from: string; x: number; y: number; dx: number; dy: number; w: number; target: string | null; before: number | null };

export function BoardView({ ctx }: { ctx: Ctx }) {
  const { defs, view, shown } = ctx;
  const [menu, openMenu, openMenuAt] = useMenu();
  const [drag, setDrag] = useState<Drag | null>(null);
  const board = useRef<HTMLDivElement>(null);
  // The click that ends a drag does not open the card.
  const dragged = useRef(false);
  const candidates = (defs ?? []).filter((d) => groupable(d.kind));
  const def: PropDef | undefined = (view.group && candidates.find((d) => d.key.toLowerCase() === view.group!.toLowerCase())) || candidates[0];

  if (!def)
    return (
      <div className="coll-board-empty">
        <EmptyState
          icon={KanbanSquare}
          title="Wonach gruppieren?"
          action={
            <Button
              size="sm"
              icon={CircleDot}
              onClick={() => {
                const el = board.current ?? document.querySelector(`.coll[data-page="${ctx.parentId}"] .coll-tools`);
                if (el) ctx.addProperty(el);
              }}
            >
              Eigenschaft anlegen
            </Button>
          }
        >
          Ein Board braucht eine Eigenschaft vom Typ Auswahl, Person oder Checkbox. Jede Option wird eine Spalte.
        </EmptyState>
        <div ref={board} />
      </div>
    );

  const groups = groupRows(shown, def);
  const cardKeys = boardCards(view, defs, def.key);
  const collapsed = (g: Group) => view.collapsed.includes(g.key);
  const toggle = (g: Group) => ctx.setView({ ...view, collapsed: collapsed(g) ? view.collapsed.filter((c) => c !== g.key) : [...view.collapsed, g.key] });
  const canReorder = !view.sort;

  const drop = (d: Drag) => {
    if (d.target === null) return;
    const target = groups.find((g) => g.key === d.target);
    if (!target) return;
    if (d.target !== d.from) ctx.write(d.row, def.key, groupWrite(def, target.key), `„${d.row.title}“ → ${target.label}`);
    if (!canReorder) return;
    // Position among the pages of the folder: before the card it was dropped on, else after the column's last card.
    const cards = target.rows.filter((r) => r.id !== d.row.id);
    if (d.before !== null) ctx.moveRow(d.row, d.before);
    else if (cards.length) {
      const all = ctx.rows.filter((r) => r.id !== d.row.id);
      const next = all[all.findIndex((r) => r.id === cards[cards.length - 1].id) + 1];
      if (d.target !== d.from || next?.id !== d.row.id) ctx.moveRow(d.row, next ? next.id : null);
    }
  };

  const onCardDown = (e: ReactPointerEvent<HTMLElement>, row: Row, from: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const card = e.currentTarget;
    const r = card.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let current: Drag | null = null;
    const where = (x: number, y: number): { target: string | null; before: number | null } => {
      const col = [...(board.current?.querySelectorAll<HTMLElement>(".board-col") ?? [])].find((c) => {
        const b = c.getBoundingClientRect();
        return x >= b.left && x <= b.right && y >= b.top - 40 && y <= b.bottom + 400;
      });
      if (!col) return { target: null, before: null };
      const cards = [...col.querySelectorAll<HTMLElement>(".board-card:not(.dragging)")];
      const hit = cards.find((c) => {
        const b = c.getBoundingClientRect();
        return y < b.top + b.height / 2;
      });
      return { target: col.dataset.group ?? null, before: hit ? Number(hit.dataset.row) : null };
    };
    const onMove = (ev: PointerEvent) => {
      if (!current && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      current = { row, from, x: r.left, y: r.top, w: r.width, dx: ev.clientX - x0, dy: ev.clientY - y0, ...where(ev.clientX, ev.clientY) };
      setDrag(current);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (current) {
        dragged.current = true;
        setTimeout(() => (dragged.current = false), 0);
        drop(current);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const cardMenu = (row: Row, from: string): MenuEntry[] => [
    { label: "Öffnen", icon: SquareArrowOutUpRight, onSelect: () => ctx.open(row, false) },
    { label: "In neuem Tab öffnen", onSelect: () => ctx.open(row, true) },
    "separator",
    {
      label: "Verschieben nach",
      submenu: groups.map((g) => ({ label: g.label, checked: g.key === from, onSelect: () => g.key !== from && ctx.write(row, def.key, groupWrite(def, g.key), `„${row.title}“ → ${g.label}`) })),
    },
  ];

  return (
    <div className={`board${drag ? " is-dragging" : ""}`} ref={board} role="list" aria-label={`Board nach ${def.key}`}>
      {groups.map((g) => {
        const isCollapsed = collapsed(g);
        const over = drag?.target === g.key;
        const chip = g.color !== null || g.invalid ? <OptionChip name={g.label} color={g.color} invalid={g.invalid} /> : <span className="board-col-name">{g.label}</span>;
        return (
          <section
            key={g.key || "__none"}
            className={`board-col${isCollapsed ? " collapsed" : ""}${over ? " over" : ""}`}
            data-group={g.key}
            role="listitem"
            aria-label={`${g.label}: ${g.rows.length} ${g.rows.length === 1 ? "Seite" : "Seiten"}`}
          >
            <header className="board-col-head">
              {isCollapsed ? (
                <button type="button" className="board-col-expand" onClick={() => toggle(g)} aria-label={`${g.label} ausklappen`}>
                  <ChevronsLeftRight size={13} />
                  <span className={`board-col-vert ${g.color !== null ? `opt-chip opt-${g.color}` : g.invalid ? "opt-chip opt-invalid" : ""}`}>{g.label}</span>
                  <span className="board-count num">{g.rows.length}</span>
                </button>
              ) : (
                <>
                  {chip}
                  <span className="board-count num" data-tooltip="Seiten in dieser Spalte">
                    {g.rows.length}
                  </span>
                  <span className="board-col-actions">
                    <IconButton icon={ChevronsRightLeft} label={`${g.label} einklappen`} size="sm" onClick={() => toggle(g)} />
                    <IconButton icon={Plus} label={`Neue Seite in ${g.label}`} size="sm" onClick={() => ctx.newPage([def.key, groupWrite(def, g.key)])} />
                  </span>
                </>
              )}
            </header>
            {!isCollapsed && (
              <div className="board-cards" role="list">
                {g.rows.map((row) => {
                  const dragging = drag?.row.id === row.id;
                  return (
                    <div key={row.id} className="board-card-slot" role="listitem">
                      {over && drag?.before === row.id && <div className="board-drop" aria-hidden />}
                      <article
                        className={`board-card${dragging ? " dragging" : ""}`}
                        data-row={row.id}
                        tabIndex={0}
                        aria-label={row.title}
                        style={dragging ? { position: "fixed", left: drag.x + drag.dx, top: drag.y + drag.dy, width: drag.w, zIndex: 80 } : undefined}
                        onPointerDown={(e) => onCardDown(e, row, g.key)}
                        onClick={(e) => !dragged.current && !(e.target as HTMLElement).closest("button") && ctx.open(row, e.ctrlKey || e.metaKey)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") ctx.open(row, e.ctrlKey || e.metaKey);
                          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                            e.preventDefault();
                            openMenuAt(e.currentTarget, cardMenu(row, g.key), { keyboard: true });
                          }
                        }}
                        onContextMenu={(e) => openMenu(e, cardMenu(row, g.key))}
                      >
                        <div className="board-card-title">
                          <PageIcon name={row.icon} size={14} />
                          <span>{row.title}</span>
                          <IconButton icon={MoreHorizontal} label="Kartenmenü" size="sm" className="board-card-menu" onClick={(e) => openMenuAt(e, cardMenu(row, g.key))} />
                        </div>
                        {cardKeys.map((k) => {
                          const d = defOf(defs, k);
                          const cell = cellOf(row, k, d);
                          if (!cell.text) return null;
                          return (
                            <div key={k} className="board-card-prop" title={fieldLabel(k)}>
                              <Invalid error={cell.error}>
                                <CellDisplay def={d} cell={cell} />
                              </Invalid>
                            </div>
                          );
                        })}
                      </article>
                      {dragging && <div className="board-card-ghost" style={{ height: 38 }} aria-hidden />}
                    </div>
                  );
                })}
                {over && drag?.before === null && <div className="board-drop" aria-hidden />}
                <button type="button" className="board-add" onClick={() => ctx.newPage([def.key, groupWrite(def, g.key)])}>
                  <Plus size={13} /> Neue Seite
                </button>
              </div>
            )}
          </section>
        );
      })}
      {menu}
    </div>
  );
}
