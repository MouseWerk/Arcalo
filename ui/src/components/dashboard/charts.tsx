// Chart widgets: „Diagramm“ (bars, line or donut over a page's table or the bookings), the
// activity heatmap and the Kanban mini-board. The SVG renderer is our own (lib/charts.ts has
// the geometry): thin marks in the theme's colors, a title and a data table for screen readers,
// and a table view to switch to.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { BarChart3, KanbanSquare, Table2 } from "lucide-react";
import { arcs, barPath, bars, heatGrid, heatStart, linePoints, niceTicks, pathOf, type Datum } from "../../lib/charts";
import { configOf } from "../../lib/dashboard";
import { fmtDate, fmtHours, int, decimal, isoWeek } from "../../lib/format";
import { t } from "../../lib/i18n";
import { useTimeTracking } from "../../lib/timetracking";
import { chartData, chartQueryOf, heatValues, type ChartData, type ChartType, type HeatmapData, type KanbanData } from "../../lib/workwidgets";
import { defOf, groupable, groupRows, groupWrite, makeRow, parseSchema, parseView, writeValue, type Group, type PropDef, type Row } from "../../lib/collection";
import { updateFrontmatter } from "../../views/collection/write";
import { IconButton } from "../ui";
import { PageIcon } from "../icons";
import { useDash, useWidgetData } from "./data";
import { Empty, fmt, Loadable, s } from "./common";
import type { WidgetProps } from "./registry";
import { isComposing } from "../../lib/ime";

/** The size of an element, live. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, number, number] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s[0] === el.clientWidth && s[1] === el.clientHeight ? s : [el.clientWidth, el.clientHeight]));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size[0], size[1]];
}
const useWidth = <T extends HTMLElement>(): [React.RefObject<T | null>, number] => {
  const [ref, w] = useSize<T>();
  return [ref, w];
};

export type Unit = ChartData["unit"];

/** A value as the chart shows it: hours („28,00 h“), a count or a number. */
export function fmtValue(v: number, unit: Unit): string {
  if (unit === "minutes") return `${fmtHours(v)} h`;
  if (unit === "count") return int(v);
  return decimal(v);
}

const SERIES = 8;
/** The categorical slot of the `i`-th group (fixed order, never cycled: the rest is gray). */
export const seriesVar = (i: number) => (i < SERIES ? `var(--series-${i + 1})` : "var(--series-rest)");

// ------------------------------------------------------------------ renderer

/** Bars, a line or a donut of `data`, with a hidden data table; `table` shows that table instead. */
export function Chart({ data, type, unit, title, table = false }: { data: Datum[]; type: ChartType; unit: Unit; title: string; table?: boolean }) {
  const [ref, width, height] = useSize<HTMLDivElement>();
  const total = data.reduce((a, d) => a + d.value, 0);
  const summary = data.map((d) => `${d.label}: ${fmtValue(d.value, unit)}`).join(", ");
  const tableEl = (
    <table className={table ? "wc-table" : "sr-only"}>
      <caption className="sr-only">{title}</caption>
      <thead>
        <tr>
          <th scope="col">{t("work.chart.group")}</th>
          <th scope="col" className="num">{t("work.chart.value")}</th>
          {type === "pie" && <th scope="col" className="num">{t("work.chart.share")}</th>}
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.key}>
            <th scope="row">{d.label}</th>
            <td className="num">{fmtValue(d.value, unit)}</td>
            {type === "pie" && <td className="num">{total > 0 ? `${int((d.value / total) * 100)} %` : "–"}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <figure className={`wc is-${type} ${table ? "wc-table-on" : ""}`} ref={ref}>
      {!table && width > 0 && (type === "pie" ? <Donut data={data} unit={unit} title={title} summary={summary} width={width} height={height} /> : <Cartesian data={data} type={type} unit={unit} title={title} summary={summary} width={width} height={height} />)}
      {tableEl}
    </figure>
  );
}

function Cartesian({ data, type, unit, title, summary, width, height: room }: { data: Datum[]; type: "bar" | "line"; unit: Unit; title: string; summary: string; width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // As tall as the widget allows, within reason.
  const height = Math.max(110, Math.min(260, room - 4));
  const left = 34;
  const bottom = 20;
  const plotW = Math.max(40, width - left - 4);
  const plotH = height - bottom - 8;
  const max = Math.max(0, ...data.map((d) => d.value));
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1] || 1;
  const bs = bars(data.map((d) => d.value), plotW, plotH, top);
  const slot = data.length ? plotW / data.length : plotW;
  const every = Math.max(1, Math.ceil(42 / Math.max(1, slot)));
  const pts = linePoints(data.map((d) => d.value), plotW, plotH, top);
  const id = useMemo(() => `wc${Math.random().toString(36).slice(2, 8)}`, []);
  const tickText = (v: number) => (unit === "minutes" ? int(v) : unit === "count" ? int(v) : decimal(v, 1));
  const h = hover != null ? data[hover] : null;
  return (
    <div className="wc-plot" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{summary}</desc>
        <g transform="translate(0 8)">
          {ticks.map((v) => {
            const y = plotH - (v / top) * plotH;
            return (
              <g key={v} className="wc-grid">
                <line x1={left} x2={left + plotW} y1={y} y2={y} />
                <text x={left - 6} y={y} textAnchor="end" dominantBaseline="central">
                  {tickText(v)}
                </text>
              </g>
            );
          })}
          <g transform={`translate(${left} 0)`}>
            {type === "bar" ? (
              bs.map((b, i) => <path key={data[i].key} d={barPath(b)} className={`wc-bar ${hover === i ? "on" : ""}`} style={data[i].color ? ({ "--wc-mark": data[i].color } as CSSProperties) : undefined} />)
            ) : (
              <>
                <path d={`${pathOf(pts)}L${pts[pts.length - 1]?.[0] ?? 0} ${plotH}L${pts[0]?.[0] ?? 0} ${plotH}Z`} className="wc-area" />
                <path d={pathOf(pts)} className="wc-line" />
                {pts.map(([x, y], i) => (
                  <circle key={data[i].key} cx={x} cy={y} r={hover === i ? 4 : 2.5} className={`wc-dot ${hover === i ? "on" : ""}`} />
                ))}
                {hover != null && <line className="wc-cross" x1={pts[hover][0]} x2={pts[hover][0]} y1={0} y2={plotH} />}
              </>
            )}
            <line className="wc-base" x1={0} x2={plotW} y1={plotH} y2={plotH} />
            {data.map((d, i) =>
              i % every === 0 ? (
                <text key={d.key} className="wc-xlabel" x={type === "bar" ? bs[i].cx : pts[i][0]} y={plotH + 14} textAnchor={type === "line" && i === 0 ? "start" : type === "line" && i === data.length - 1 ? "end" : "middle"}>
                  {short(d.label, Math.max(4, Math.floor((slot * every) / 6.5)))}
                </text>
              ) : null,
            )}
            {/* Hit targets wider than the marks: one per slot. */}
            {data.map((d, i) => (
              <rect key={d.key} className="wc-hit" x={type === "bar" ? slot * i : Math.max(0, pts[i][0] - slot / 2)} y={0} width={slot} height={plotH} onPointerEnter={() => setHover(i)}>
                <title>{`${d.label}: ${fmtValue(d.value, unit)}`}</title>
              </rect>
            ))}
          </g>
        </g>
      </svg>
      {h && hover != null && (
        <div className="wc-tip" style={{ left: Math.min(width - 8, Math.max(8, left + (type === "bar" ? bs[hover].cx : pts[hover][0]))) }} role="status">
          <span className="ellipsis">{h.label}</span>
          <b className="num">{fmtValue(h.value, unit)}</b>
        </div>
      )}
    </div>
  );
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

function Donut({ data, unit, title, summary, width, height }: { data: Datum[]; unit: Unit; title: string; summary: string; width: number; height: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const size = Math.max(80, Math.min(170, width * 0.4, height - 4));
  const outer = size / 2;
  const inner = outer * 0.62;
  const list = arcs(data, outer, inner);
  const total = data.reduce((a, d) => a + Math.max(0, d.value), 0);
  const color = (d: Datum, i: number) => d.color ?? seriesVar(i);
  const h = data.find((d) => d.key === hover);
  const id = useMemo(() => `wc${Math.random().toString(36).slice(2, 8)}`, []);
  return (
    <div className="wc-donut">
      <svg width={size} height={size} viewBox={`${-outer} ${-outer} ${size} ${size}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{summary}</desc>
        {list.map((a, i) =>
          a.path ? (
            <path key={a.key} d={a.path} className={`wc-slice ${hover === a.key ? "on" : ""} ${hover && hover !== a.key ? "dim" : ""}`} style={{ "--wc-mark": color(data[i], i) } as CSSProperties} onPointerEnter={() => setHover(a.key)} onPointerLeave={() => setHover(null)}>
              <title>{`${data[i].label}: ${fmtValue(data[i].value, unit)} (${int(a.share * 100)} %)`}</title>
            </path>
          ) : null,
        )}
        <text className="wc-donut-total num" y={-2} textAnchor="middle" dominantBaseline="central">
          {fmtValue(h ? h.value : total, unit)}
        </text>
        <text className="wc-donut-sub" y={14} textAnchor="middle" dominantBaseline="central">
          {h ? short(h.label, 14) : t("work.chart.total")}
        </text>
      </svg>
      <ul className="wc-legend">
        {data.map((d, i) => (
          <li key={d.key} className={hover === d.key ? "on" : ""} onPointerEnter={() => setHover(d.key)} onPointerLeave={() => setHover(null)}>
            <span className="wc-swatch" style={{ background: color(d, i) }} aria-hidden />
            <span className="ellipsis grow">{d.label}</span>
            <span className="num faint">{fmtValue(d.value, unit)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ Diagramm

const weekLabel = (d: string) => t("work.chart.week", { n: isoWeek(new Date(`${d}T12:00:00`)) });
const monthLabel = (d: string) => fmt(new Date(`${d.slice(0, 10)}T12:00:00`), { month: "short", year: "2-digit" });

export function ChartWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  const q = chartQueryOf(c);
  const timeOn = useTimeTracking();
  const { data, error, loading } = useWidgetData<ChartData>(widget);
  const [table, setTable] = useState(false);
  const type: ChartType = c.type === "line" || c.type === "pie" ? c.type : "bar";
  if (q.source === "pages" && q.page == null) return <Empty icon={BarChart3}>{t("work.chart.pick")}</Empty>;
  if (q.source === "bookings" && !timeOn) return <Empty icon={BarChart3}>{t("work.timeOff")}</Empty>;
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const points = chartData(d, q.group, weekLabel, monthLabel);
        if (!points.length || d.total === 0) return <Empty icon={BarChart3}>{q.source === "bookings" ? t("work.chart.noBookings") : t("work.chart.noPages")}</Empty>;
        const title = widget.title?.trim() || t("work.w.chart");
        const unit: Unit = d.unit === "minutes" ? "minutes" : d.unit;
        return (
          <div className="wc-wrap">
            <div className="wc-top">
              <span className="num dw-big">{fmtValue(unit === "minutes" ? d.total / 60 : d.total, unit)}</span>
              <span className="faint small grow">{q.source === "bookings" ? t("work.chart.lastWeeks", { n: q.weeks }) : t("work.chart.pages", { n: d.points.length })}</span>
              <IconButton icon={table ? BarChart3 : Table2} size="sm" label={table ? t("work.chart.asChart") : t("work.chart.asTable")} active={table} onClick={() => setTable(!table)} />
            </div>
            <Chart data={points} type={type} unit={unit} title={title} table={table} />
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ heatmap

export function HeatmapWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  const timeOn = useTimeTracking();
  const mode = c.mode === "hours" && timeOn ? "hours" : "notes";
  const { data, error, loading } = useWidgetData<HeatmapData>(widget);
  const [ref, width] = useWidth<HTMLDivElement>();
  const { today } = useDash();
  return (
    <div className="wh" ref={ref}>
      <Loadable loading={loading} error={error}>
        {() => <Heatmap data={data!} mode={mode} width={width} today={today} />}
      </Loadable>
    </div>
  );
}

function Heatmap({ data, mode, width, today }: { data: HeatmapData; mode: "notes" | "hours"; width: number; today: Date }) {
  const grid = useMemo(() => heatGrid(heatStart(today), today, heatValues(data)), [data, today]);
  const [hover, setHover] = useState<string | null>(null);
  const left = 22;
  const gap = 2;
  const cell = Math.max(9, Math.min(13, Math.floor((width - left) / grid.cols) - gap));
  const step = cell + gap;
  // Fewer weeks when the widget is narrow: the newest ones.
  const cols = Math.min(grid.cols, Math.max(4, Math.floor((width - left) / step)));
  const first = grid.cols - cols;
  const height = 16 + 7 * step;
  const wd = [0, 2, 4].map((i) => fmt(new Date(2024, 0, 1 + i), { weekday: "short" }).replace(/\.$/, "").slice(0, 2));
  const valueText = (v: number) => (mode === "hours" ? `${fmtHours(v / 60)} h` : t("work.heat.pages", { n: v }));
  const label = (date: string, v: number) => `${fmtDate(`${date}T12:00:00`)}: ${valueText(v)}`;
  const h = hover ? grid.cells.find((x) => x.date === hover) : null;
  const total = mode === "hours" ? `${fmtHours(data.total / 60)} h` : t("work.heat.pages", { n: data.total });
  return (
    <div className="wh-in">
      <div className="wh-top">
        <span className="small">
          <b className="num">{total}</b> <span className="faint">{t("work.heat.activeDays", { n: data.active })}</span>
        </span>
        <span className="grow" />
        <span className="faint small num" role="status">
          {h ? label(h.date, h.value) : ""}
        </span>
      </div>
      {width > 0 && (
        <svg width={left + cols * step} height={height} role="img" aria-label={`${mode === "hours" ? t("work.heat.titleHours") : t("work.heat.titleNotes")}: ${total}`} className="wh-svg">
          {grid.months
            .filter((m) => m.col >= first)
            .map((m) => (
              <text key={`${m.year}-${m.month}`} x={left + (m.col - first) * step} y={9} className="wh-label">
                {fmt(new Date(m.year, m.month, 1), { month: "short" }).replace(/\.$/, "")}
              </text>
            ))}
          {wd.map((d, i) => (
            <text key={d} x={0} y={16 + (i * 2 + 1) * step - gap - 1} className="wh-label">
              {d}
            </text>
          ))}
          {grid.cells
            .filter((x) => x.col >= first && !x.future)
            .map((x) => (
              <rect
                key={x.date}
                x={left + (x.col - first) * step}
                y={16 + x.row * step}
                width={cell}
                height={cell}
                rx={2}
                className={`wh-cell l${x.level} ${hover === x.date ? "on" : ""}`}
                data-date={x.date}
                onPointerEnter={() => setHover(x.date)}
                onPointerLeave={() => setHover(null)}
              >
                <title>{label(x.date, x.value)}</title>
              </rect>
            ))}
        </svg>
      )}
      <div className="wh-legend faint small" aria-hidden>
        {t("work.heat.less")}
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`wh-key l${l}`} />
        ))}
        {t("work.heat.more")}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Kanban

type Drag = { row: Row; from: string; x: number; y: number; target: string | null; moved: boolean };

export function KanbanWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  const { data, error, loading } = useWidgetData<KanbanData>(widget);
  if (typeof c.page !== "number") return <Empty icon={KanbanSquare}>{t("work.kanban.pick")}</Empty>;
  return <Loadable loading={loading} error={error}>{() => <Kanban data={data!} />}</Loadable>;
}

function Kanban({ data }: { data: KanbanData }) {
  const { refresh } = useDash();
  const defs = useMemo(() => parseSchema(data.frontmatter), [data.frontmatter]);
  const view = useMemo(() => parseView(data.frontmatter), [data.frontmatter]);
  // Moves not yet back from the backend.
  const [local, setLocal] = useState<Map<number, string>>(new Map());
  useEffect(() => setLocal(new Map()), [data]);
  const rows = useMemo(() => data.rows.map((r) => makeRow(r, local.get(r.id) ?? r.frontmatter)), [data.rows, local]);
  const candidates = (defs ?? []).filter((d) => groupable(d.kind));
  const def: PropDef | undefined = (view.group ? defOf(candidates, view.group) : undefined) ?? candidates[0];
  const [drag, setDrag] = useState<Drag | null>(null);
  if (!def)
    return (
      <Empty icon={KanbanSquare} action={<button type="button" className="dw-link" onClick={() => s().openPage(data.page_id)}>{t("work.kanban.open")}</button>}>
        {t("work.kanban.noGroup")}
      </Empty>
    );
  const groups = groupRows(rows, def);
  const move = (row: Row, to: Group) => {
    const value = groupWrite(def, to.key);
    setLocal((m) => new Map(m).set(row.id, writeValue(row.fm, def.key, value)));
    updateFrontmatter(row.id, (fm) => writeValue(fm, def.key, value))
      .then(() => refresh(["pages"]))
      .catch((e) => {
        s().error(t("work.kanban.moveFailed"), e);
        setLocal(new Map());
      });
  };
  const onDown = (e: ReactPointerEvent<HTMLElement>, row: Row, from: string) => {
    if (e.button !== 0) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let cur: Drag = { row, from, x: x0, y: y0, target: from, moved: false };
    const onMove = (ev: PointerEvent) => {
      if (!cur.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      const col = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-kanban-col]");
      cur = { ...cur, x: ev.clientX, y: ev.clientY, moved: true, target: col?.dataset.kanbanCol ?? null };
      setDrag(cur);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (!cur.moved) {
        s().openPage(row.id);
        return;
      }
      const to = groups.find((g) => g.key === cur.target);
      if (to && cur.target !== from) move(row, to);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const onKey = (e: ReactKeyboardEvent, row: Row, gi: number) => {
    if (isComposing(e)) return;
    if (e.key === "Enter") s().openPage(row.id);
    if (!e.altKey || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    e.preventDefault();
    e.stopPropagation();
    const to = groups[gi + (e.key === "ArrowRight" ? 1 : -1)];
    if (to) move(row, to);
  };
  return (
    <div className="wk">
      <button type="button" className="wk-title dw-row" onClick={() => s().openPage(data.page_id)}>
        <PageIcon name={data.icon} size={14} />
        <span className="ellipsis">{data.title}</span>
        <span className="faint small">· {def.key}</span>
      </button>
      <div className="wk-cols" role="list">
        {groups.map((g, gi) => (
          <section key={g.key || "__none"} role="listitem" className={`wk-col ${drag?.moved && drag.target === g.key ? "drop" : ""}`} data-kanban-col={g.key} aria-label={`${g.label}: ${g.rows.length}`}>
            <h3 className="wk-head">
              <span className={`opt-chip ${g.color != null ? `opt-${g.color}` : "opt-none"}`}>{g.label}</span>
              <span className="faint num">{g.rows.length}</span>
            </h3>
            <ul className="wk-cards">
              {g.rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className={`wk-card ${drag?.moved && drag.row.id === r.id ? "dragging" : ""}`}
                    data-page={r.id}
                    onPointerDown={(e) => onDown(e, r, g.key)}
                    onKeyDown={(e) => onKey(e, r, gi)}
                    onClick={(e) => e.preventDefault()}
                    aria-label={t("work.kanban.card", { title: r.title, column: g.label })}
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                  >
                    <PageIcon name={r.icon} size={13} />
                    <span className="ellipsis">{r.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {drag?.moved && (
        <div className="wk-ghost" style={{ left: drag.x + 8, top: drag.y + 8 }} aria-hidden>
          {drag.row.title}
        </div>
      )}
    </div>
  );
}

