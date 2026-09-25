// The „Abfrage“ widget's query builder: a query written as one line
// (`#projekt status: offen fällig: woche "Angebot"`) and the structured query the backend
// runs (annalo_core::dashboard::query). Filters use the operators of the table view.

import type { TKey } from "./i18n";

export type QuerySource = "pages" | "tasks" | "entries" | "events";
export type QueryDisplay = "list" | "table" | "number" | "bar";

export interface QueryFilter {
  field: string;
  op: string;
  value: string;
}

/** What the backend runs (field names as in Rust). */
export interface WidgetQuery {
  source: QuerySource;
  tag: string | null;
  text: string;
  parent_id: number | null;
  filters: QueryFilter[];
  /** Time entries: today, week, last7, month, last30, year. */
  range: string;
  /** Meetings: days from today. */
  days: number;
  group: string;
  columns: string[];
  sort: string;
  limit: number;
}

export const emptyQuery = (source: QuerySource = "pages"): WidgetQuery => ({
  source,
  tag: null,
  text: "",
  parent_id: null,
  filters: [],
  range: source === "entries" ? "week" : "",
  days: source === "events" ? 7 : 0,
  group: "",
  columns: [],
  sort: "",
  limit: 20,
});

export const SOURCES: { value: QuerySource; label: TKey }[] = [
  { value: "pages", label: "dash.q.src.pages" },
  { value: "tasks", label: "dash.q.src.tasks" },
  { value: "entries", label: "dash.q.src.entries" },
  { value: "events", label: "dash.q.src.events" },
];

export const DISPLAYS: { value: QueryDisplay; label: TKey }[] = [
  { value: "list", label: "dash.q.disp.list" },
  { value: "table", label: "dash.q.disp.table" },
  { value: "number", label: "dash.q.disp.number" },
  { value: "bar", label: "dash.q.disp.bar" },
];

/** Fields each source knows besides page properties (suggested in the builder). */
export const FIELDS: Record<QuerySource, string[]> = {
  pages: ["titel", "geändert"],
  tasks: ["status", "fällig", "prio", "seite", "tag", "text"],
  entries: ["netzplan", "vorgang", "wbs", "projekt", "leistungsart", "status", "stunden", "datum", "text"],
  events: ["titel", "ort", "kalender", "organisator", "teilnehmer", "gebucht", "datum"],
};

/** Fields to group a bar chart by; pages group by any property besides these. */
export const GROUPS: Record<QuerySource, string[]> = {
  pages: ["tag", "eltern"],
  tasks: ["fällig", "prio", "seite", "tag"],
  entries: ["wbs", "netzplan", "projekt", "tag", "leistungsart", "status"],
  events: ["tag", "kalender"],
};

export const RANGES = ["today", "week", "last7", "month", "last30", "year"] as const;

/** Keys that set a part of the query instead of a filter. */
const SPECIAL: Record<string, "range" | "days"> = { zeitraum: "range", tage: "days" };
/** German range words to the backend's names. */
const RANGE_WORDS: Record<string, string> = { heute: "today", woche: "week", "7tage": "last7", monat: "month", "30tage": "last30", jahr: "year" };

/** Words and quoted strings; `key: value` with a space after the colon stays one token. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  // A token is a run of non-blank characters and quoted strings: `titel:"Neues Angebot"`.
  for (const m of line.matchAll(/(?:[^\s"]+|"[^"]*"?)+/g)) {
    const tok = m[0];
    const prev = out[out.length - 1];
    // `status: offen` (a blank after the colon) is one filter.
    if (prev && /^[^\s"#]*[^\s"#:<>=!~][:<>=~!]+$/.test(prev) && !tok.startsWith("#")) out[out.length - 1] = prev + tok;
    else out.push(tok);
  }
  return out;
}

const OPS: [RegExp, string][] = [
  [/^([^\s:<>=!~]+)\s*!=\s*(.*)$/, "ist nicht"],
  [/^([^\s:<>=!~]+)\s*>=\s*(.*)$/, ">="],
  [/^([^\s:<>=!~]+)\s*<=\s*(.*)$/, "<="],
  [/^([^\s:<>=!~]+)\s*>\s*(.*)$/, ">"],
  [/^([^\s:<>=!~]+)\s*<\s*(.*)$/, "<"],
  [/^([^\s:<>=!~]+)\s*:\s*(.*)$/, "ist"],
];

/** One `key:value` token as a filter; `null` when it is none. */
export function parseFilter(token: string): QueryFilter | null {
  for (const [re, op0] of OPS) {
    const m = token.match(re);
    if (!m) continue;
    const field = m[1].toLowerCase();
    let op = op0;
    let value = m[2].trim();
    if (op === "ist") {
      if (value.startsWith("!~")) (op = "enthält nicht"), (value = value.slice(2));
      else if (value.startsWith("~")) (op = "enthält"), (value = value.slice(1));
      else if (value.startsWith("!")) (op = "ist nicht"), (value = value.slice(1));
      if (value === "leer") return { field, op: op === "ist nicht" ? "ist nicht leer" : "ist leer", value: "" };
    }
    return { field, op, value: value.replace(/^"|"$/g, "") };
  }
  return null;
}

export interface Parsed {
  tag: string | null;
  text: string;
  filters: QueryFilter[];
  range?: string;
  days?: number;
  /** What could not be read (e.g. a second tag). */
  problems: string[];
}

/** Reads a query line. Unknown words become the text filter. */
export function parseQueryLine(line: string): Parsed {
  const out: Parsed = { tag: null, text: "", filters: [], problems: [] };
  const words: string[] = [];
  for (const tok of tokenize(line)) {
    if (tok.startsWith('"')) {
      words.push(tok.replace(/^"|"$/g, ""));
      continue;
    }
    if (/^#[^\s#]+$/.test(tok)) {
      if (out.tag) out.problems.push(tok);
      else out.tag = tok.slice(1).toLowerCase();
      continue;
    }
    const f = parseFilter(tok);
    if (!f || !f.field) {
      words.push(tok);
      continue;
    }
    const special = SPECIAL[f.field];
    if (special === "range") {
      const r = RANGE_WORDS[f.value.toLowerCase()] ?? f.value.toLowerCase();
      if ((RANGES as readonly string[]).includes(r)) out.range = r;
      else out.problems.push(tok);
    } else if (special === "days") {
      const n = Number(f.value);
      if (Number.isInteger(n) && n > 0 && n <= 31) out.days = n;
      else out.problems.push(tok);
    } else out.filters.push(f);
  }
  out.text = words.join(" ").trim();
  return out;
}

const quote = (v: string) => (/[\s"]/.test(v) || v === "" ? `"${v.replace(/"/g, "")}"` : v);

/** One filter as `key:value` (the inverse of `parseFilter`). */
export function filterText(f: QueryFilter): string {
  const k = f.field;
  switch (f.op) {
    case "ist":
      return `${k}:${quote(f.value)}`;
    case "ist nicht":
      return `${k}!=${quote(f.value)}`;
    case "enthält":
      return `${k}:~${quote(f.value)}`;
    case "enthält nicht":
      return `${k}:!~${quote(f.value)}`;
    case "ist leer":
      return `${k}:leer`;
    case "ist nicht leer":
      return `${k}:!leer`;
    case "vor":
      return `${k}<${quote(f.value)}`;
    case "nach":
      return `${k}>${quote(f.value)}`;
    default:
      return `${k}${f.op}${quote(f.value)}`;
  }
}

const RANGE_BACK: Record<string, string> = Object.fromEntries(Object.entries(RANGE_WORDS).map(([k, v]) => [v, k]));

/** The query line of a query (tag, filters, range, days, text). */
export function queryLine(q: Pick<WidgetQuery, "tag" | "text" | "filters" | "range" | "days" | "source">): string {
  const parts: string[] = [];
  if (q.tag) parts.push(`#${q.tag}`);
  for (const f of q.filters) parts.push(filterText(f));
  if (q.source === "entries" && q.range && q.range !== "week") parts.push(`zeitraum:${RANGE_BACK[q.range] ?? q.range}`);
  if (q.source === "events" && q.days && q.days !== 7) parts.push(`tage:${q.days}`);
  if (q.text.trim()) parts.push(q.text.includes(":") || q.text.startsWith("#") ? `"${q.text.trim()}"` : q.text.trim());
  return parts.join(" ");
}

/** `q` with the parts of `line` (range and days fall back to the source's default). */
export function applyLine(q: WidgetQuery, line: string): WidgetQuery {
  const p = parseQueryLine(line);
  const base = emptyQuery(q.source);
  return { ...q, tag: p.tag, text: p.text, filters: p.filters, range: p.range ?? base.range, days: p.days ?? base.days };
}

/** A query read from stored widget settings (anything missing gets its default). */
export function normalizeQuery(raw: unknown): WidgetQuery {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<WidgetQuery>;
  const source: QuerySource = SOURCES.some((s) => s.value === r.source) ? (r.source as QuerySource) : "pages";
  const base = emptyQuery(source);
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  const filters = Array.isArray(r.filters)
    ? r.filters
        .filter((f): f is QueryFilter => !!f && typeof f === "object" && typeof (f as QueryFilter).field === "string")
        .map((f) => ({ field: f.field.trim().toLowerCase(), op: str(f.op, "ist"), value: str(f.value, "") }))
        .filter((f) => f.field)
        .slice(0, 12)
    : [];
  return {
    source,
    tag: typeof r.tag === "string" && r.tag.trim() ? r.tag.trim().replace(/^#/, "").toLowerCase() : null,
    text: str(r.text, ""),
    parent_id: typeof r.parent_id === "number" ? r.parent_id : null,
    filters,
    range: (RANGES as readonly string[]).includes(str(r.range, "")) ? (r.range as string) : base.range,
    days: typeof r.days === "number" && r.days > 0 ? Math.min(31, Math.round(r.days)) : base.days,
    group: str(r.group, "").toLowerCase(),
    columns: Array.isArray(r.columns) ? r.columns.filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim()).slice(0, 6) : [],
    sort: r.sort === "title" ? "title" : "",
    limit: typeof r.limit === "number" && r.limit > 0 ? Math.min(200, Math.round(r.limit)) : base.limit,
  };
}

/** The group a bar chart needs, or a hint why the query cannot be shown that way. */
export function displayProblem(q: WidgetQuery, display: QueryDisplay): TKey | null {
  if (display === "bar" && !q.group) return "dash.q.needGroup";
  if (display === "table" && q.source === "pages" && q.columns.length === 0) return "dash.q.needColumns";
  return null;
}

/** Bars for a chart: labels with values scaled 0..1 against the largest. */
export function bars(groups: { label: string; value: number }[]): { label: string; value: number; share: number }[] {
  const max = Math.max(0, ...groups.map((g) => g.value));
  return groups.map((g) => ({ ...g, share: max > 0 ? g.value / max : 0 }));
}
