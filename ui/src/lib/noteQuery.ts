// Queries in notes: a fenced ```query block runs a query of the dashboard's „Abfrage“ widget
// (arcalo_core::dashboard::query). Its first lines may set options (`from: tasks`,
// `show: table`, `sort: due`, `limit: 10`, `group:`, `columns:`, in English or German); the other
// lines are the widget's query line (`#projekt status: offen fällig: woche`).

import { emptyQuery, parseQueryLine, type QueryDisplay, type QuerySource, type WidgetQuery } from "./dashquery";
import type { QueryRow } from "./dashtypes";

export type NoteDisplay = "list" | "table" | "count" | "chart";

export interface NoteQuery {
  query: WidgetQuery;
  display: NoteDisplay;
  /** Sorting done here (the backend sorts pages only); null keeps the backend's order. */
  sort: { key: SortKey; desc: boolean } | null;
  /** What could not be read, as written (shown inline under the result). */
  problems: string[];
}

type SortKey = "title" | "date" | "prio" | "hours" | "page";

const SOURCE_WORDS: Record<string, QuerySource> = {
  tasks: "tasks",
  task: "tasks",
  aufgaben: "tasks",
  pages: "pages",
  page: "pages",
  seiten: "pages",
  notes: "pages",
  notizen: "pages",
  bookings: "entries",
  entries: "entries",
  buchungen: "entries",
  zeiten: "entries",
  zeiteinträge: "entries",
  meetings: "events",
  events: "events",
  termine: "events",
  besprechungen: "events",
};

const DISPLAY_WORDS: Record<string, NoteDisplay> = {
  list: "list",
  liste: "list",
  table: "table",
  tabelle: "table",
  count: "count",
  number: "count",
  anzahl: "count",
  zahl: "count",
  chart: "chart",
  bar: "chart",
  diagramm: "chart",
  balken: "chart",
};

const SORT_WORDS: Record<string, SortKey> = {
  title: "title",
  titel: "title",
  name: "title",
  due: "date",
  fällig: "date",
  date: "date",
  datum: "date",
  changed: "date",
  modified: "date",
  geändert: "date",
  start: "date",
  prio: "prio",
  priority: "prio",
  priorität: "prio",
  hours: "hours",
  stunden: "hours",
  page: "page",
  seite: "page",
};

const OPTION_KEYS: Record<string, "from" | "show" | "sort" | "limit" | "group" | "columns"> = {
  from: "from",
  source: "from",
  quelle: "from",
  aus: "from",
  show: "show",
  display: "show",
  view: "show",
  zeige: "show",
  anzeige: "show",
  ansicht: "show",
  sort: "sort",
  sortierung: "sort",
  sortiere: "sort",
  limit: "limit",
  max: "limit",
  group: "group",
  gruppe: "group",
  gruppierung: "group",
  columns: "columns",
  spalten: "columns",
};

/** The default group of a chart per source. */
const CHART_GROUP: Record<QuerySource, string> = { tasks: "fällig", pages: "tag", entries: "wbs", events: "kalender" };

/** Reads a ```query block. */
export function parseNoteQuery(src: string): NoteQuery {
  const lines = src.split("\n");
  const problems: string[] = [];
  let source: QuerySource = "tasks";
  let display: NoteDisplay = "list";
  let sort: NoteQuery["sort"] = null;
  let limit: number | null = null;
  let group = "";
  let columns: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^([\p{L}]+)\s*:\s*(.*)$/u.exec(line);
    const key = m ? OPTION_KEYS[m[1].toLowerCase()] : undefined;
    if (!m || !key) break;
    const value = m[2].trim();
    const word = value.toLowerCase();
    if (key === "from") {
      if (SOURCE_WORDS[word]) source = SOURCE_WORDS[word];
      else problems.push(line);
    } else if (key === "show") {
      if (DISPLAY_WORDS[word]) display = DISPLAY_WORDS[word];
      else problems.push(line);
    } else if (key === "sort") {
      const sm = /^(-)?\s*([\p{L}]+)(?:\s+(asc|desc|auf|ab|aufsteigend|absteigend))?$/u.exec(word);
      const k = sm ? SORT_WORDS[sm[2]] : undefined;
      if (sm && k) sort = { key: k, desc: !!sm[1] || /^(desc|ab|absteigend)$/.test(sm[3] ?? "") };
      else problems.push(line);
    } else if (key === "limit") {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n <= 200) limit = n;
      else problems.push(line);
    } else if (key === "group") group = value;
    else
      columns = value
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 6);
  }
  const parsed = parseQueryLine(lines.slice(i).join(" ").trim());
  problems.push(...parsed.problems);
  const base = emptyQuery(source);
  const query: WidgetQuery = {
    ...base,
    tag: parsed.tag,
    text: parsed.text,
    filters: parsed.filters,
    range: parsed.range ?? base.range,
    days: parsed.days ?? base.days,
    group: group ? group.toLowerCase() : display === "chart" ? CHART_GROUP[source] : "",
    columns,
    sort: source === "pages" && sort?.key === "title" && !sort.desc ? "title" : "",
    limit: limit ?? base.limit,
  };
  return { query, display, sort, problems };
}

/** What the backend is asked for: more rows when the note sorts them itself. */
export function backendQuery(nq: NoteQuery): WidgetQuery {
  return nq.sort && nq.query.sort !== "title" ? { ...nq.query, limit: 200 } : nq.query;
}

/** The dashboard display a note display uses. */
export const widgetDisplay = (d: NoteDisplay): QueryDisplay => (d === "count" ? "number" : d === "chart" ? "bar" : d);

const fold = (s: string) => s.toLocaleLowerCase();

/** Rows in the block's order, cut to its limit. */
export function sortRows(nq: NoteQuery, rows: QueryRow[]): QueryRow[] {
  const s = nq.sort;
  if (!s || nq.query.sort === "title") return rows.slice(0, nq.query.limit);
  const val = (r: QueryRow): string | number | null => {
    switch (s.key) {
      case "title":
        return fold(r.title);
      case "date":
        return r.date;
      case "prio":
        return r.priority ?? 0;
      case "hours":
        return r.minutes ?? 0;
      case "page":
        return fold(r.detail);
    }
  };
  const out = [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    // Rows without a value go last either way.
    if (x == null || x === "") return y == null || y === "" ? 0 : 1;
    if (y == null || y === "") return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return s.desc ? -c : c;
  });
  return out.slice(0, nq.query.limit);
}
