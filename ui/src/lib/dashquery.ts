// The „Abfrage“ widget's query builder: a query written as one line
// (`#projekt status: offen fällig: woche "Angebot"`) and the structured query the backend
// runs (annalo_core::dashboard::query). Filters use the operators of the table view.

import type { Lang, TKey } from "./i18n";

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

// English aliases. A query is stored with the German field names, words and operators (the
// backend's names, shared with the table view); the line accepts both languages and is written
// in the display language.

/** English field names → the stored (German) ones. */
const FIELD_ALIASES: Record<string, string> = {
  title: "titel",
  changed: "geändert",
  modified: "geändert",
  due: "fällig",
  priority: "prio",
  page: "seite",
  parent: "eltern",
  activity: "vorgang",
  network: "netzplan",
  project: "projekt",
  activitytype: "leistungsart",
  hours: "stunden",
  minutes: "minuten",
  date: "datum",
  location: "ort",
  calendar: "kalender",
  organizer: "organisator",
  attendees: "teilnehmer",
  booked: "gebucht",
  description: "beschreibung",
  range: "zeitraum",
  days: "tage",
};
/** The English name of each stored field that has one (the first alias wins). */
const FIELD_NAMES_EN: Record<string, string> = {};
for (const [en, de] of Object.entries(FIELD_ALIASES)) FIELD_NAMES_EN[de] ??= en;

/** English value words → the stored ones, by the (stored) field they belong to. */
const VALUE_ALIASES: Record<string, Record<string, string>> = {
  fällig: { overdue: "überfällig", today: "heute", week: "woche", later: "später", none: "ohne" },
  prio: { high: "hoch", medium: "mittel", none: "keine" },
  status: { open: "offen", done: "erledigt", all: "alle", running: "läuft", draft: "entwurf", released: "freigegeben", exported: "exportiert" },
  gebucht: { yes: "ja", no: "nein" },
};
const VALUE_NAMES_EN: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(VALUE_ALIASES).map(([field, words]) => [field, Object.fromEntries(Object.entries(words).map(([en, de]) => [de, en]))]),
);
/** Range words in English: the backend's own names, plus spelled-out forms. */
const RANGE_ALIASES: Record<string, string> = { "7days": "last7", "30days": "last30" };
const RANGE_NAMES_EN: Record<string, string> = { last7: "7days", last30: "30days" };
/** „leer“ in both languages. */
const EMPTY_WORDS = new Set(["leer", "empty"]);

/** The stored name of a field written in either language. */
export const canonicalField = (field: string): string => FIELD_ALIASES[field.toLowerCase()] ?? field.toLowerCase();

/** A field's name in the display language (property names are the user's own and stay). */
export const fieldName = (field: string, lang: Lang): string => (lang === "en" ? (FIELD_NAMES_EN[field] ?? field) : field);

const canonicalValue = (field: string, value: string): string => VALUE_ALIASES[field]?.[value.toLowerCase()] ?? value;
const valueName = (field: string, value: string, lang: Lang): string => (lang === "en" ? (VALUE_NAMES_EN[field]?.[value.toLowerCase()] ?? value) : value);

/** Built-in fields whose group labels are words of the backend (translated for display). */
const WORD_GROUPS = new Set(["fällig", "prio", "status", "gebucht"]);
/** The backend's labels of rows without a value and of the groups beyond the largest. */
export const EMPTY_GROUP = "(leer)";
export const OTHER_GROUP = "Andere";

/** A bar chart's group label in the display language. */
export function groupLabel(label: string, group: string, lang: Lang): string {
  if (lang !== "en") return label;
  if (label === EMPTY_GROUP) return "(empty)";
  if (label === OTHER_GROUP) return "Other";
  const field = canonicalField(group);
  return WORD_GROUPS.has(field) ? valueName(field, label, lang) : label;
}

/** Word operators in both languages and the short form each one stands for. */
const WORD_OPS: [string, string][] = [
  ["ist nicht", "!="],
  ["is not", "!="],
  ["enthält nicht", ":!~"],
  ["does not contain", ":!~"],
  ["enthält", ":~"],
  ["contains", ":~"],
  ["ist", ":"],
  ["is", ":"],
];
const WORD_OP_RE = new RegExp(`([^\\s":<>=!~#]+)\\s+(${WORD_OPS.map(([w]) => w.replace(/ /g, "\\s+")).join("|")})\\s+(?=\\S)`, "gi");

/** Fields a word operator may follow: the built-in ones in both languages (so a search for
 *  „what is new“ stays text; page properties use `key: value`). */
const WORD_OP_FIELDS = new Set([...Object.values(FIELDS).flat(), ...Object.values(GROUPS).flat(), ...Object.keys(FIELD_ALIASES), ...Object.values(FIELD_ALIASES)]);

/** `status is open`, `titel enthält x`: word operators become the short forms (outside quotes). */
export function wordOperators(line: string): string {
  return line
    .split(/("[^"]*"?)/)
    .map((part) =>
      part.startsWith('"')
        ? part
        : part.replace(WORD_OP_RE, (m, field: string, word: string) => {
            if (!WORD_OP_FIELDS.has(field.toLowerCase())) return m;
            const w = word.toLowerCase().replace(/\s+/g, " ");
            return `${field}${WORD_OPS.find(([x]) => x === w)![1]}`;
          }),
    )
    .join("");
}

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
    const field = canonicalField(m[1]);
    let op = op0;
    let value = m[2].trim();
    if (op === "ist") {
      if (value.startsWith("!~")) (op = "enthält nicht"), (value = value.slice(2));
      else if (value.startsWith("~")) (op = "enthält"), (value = value.slice(1));
      else if (value.startsWith("!")) (op = "ist nicht"), (value = value.slice(1));
      if (EMPTY_WORDS.has(value.toLowerCase())) return { field, op: op === "ist nicht" ? "ist nicht leer" : "ist leer", value: "" };
    }
    value = value.replace(/^"|"$/g, "");
    return { field, op, value: op === "ist" || op === "ist nicht" ? canonicalValue(field, value) : value };
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
  for (const tok of tokenize(wordOperators(line))) {
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
      const v = f.value.toLowerCase();
      const r = RANGE_WORDS[v] ?? RANGE_ALIASES[v] ?? v;
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

/** One filter as `key:value` (the inverse of `parseFilter`), German unless `lang` is "en". */
export function filterText(f: QueryFilter, lang: Lang = "de"): string {
  const k = fieldName(f.field, lang);
  const empty = lang === "en" ? "empty" : "leer";
  switch (f.op) {
    case "ist":
      return `${k}:${quote(valueName(f.field, f.value, lang))}`;
    case "ist nicht":
      return `${k}!=${quote(valueName(f.field, f.value, lang))}`;
    case "enthält":
      return `${k}:~${quote(f.value)}`;
    case "enthält nicht":
      return `${k}:!~${quote(f.value)}`;
    case "ist leer":
      return `${k}:${empty}`;
    case "ist nicht leer":
      return `${k}:!${empty}`;
    case "vor":
      return `${k}<${quote(f.value)}`;
    case "nach":
      return `${k}>${quote(f.value)}`;
    default:
      return `${k}${f.op}${quote(f.value)}`;
  }
}

const RANGE_BACK: Record<string, string> = Object.fromEntries(Object.entries(RANGE_WORDS).map(([k, v]) => [v, k]));

/** The query line of a query (tag, filters, range, days, text), German unless `lang` is "en". */
export function queryLine(q: Pick<WidgetQuery, "tag" | "text" | "filters" | "range" | "days" | "source">, lang: Lang = "de"): string {
  const en = lang === "en";
  const parts: string[] = [];
  if (q.tag) parts.push(`#${q.tag}`);
  for (const f of q.filters) parts.push(filterText(f, lang));
  if (q.source === "entries" && q.range && q.range !== "week")
    parts.push(en ? `range:${RANGE_NAMES_EN[q.range] ?? q.range}` : `zeitraum:${RANGE_BACK[q.range] ?? q.range}`);
  if (q.source === "events" && q.days && q.days !== 7) parts.push(`${en ? "days" : "tage"}:${q.days}`);
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
        .map((f) => ({ field: canonicalField(f.field.trim()), op: str(f.op, "ist"), value: str(f.value, "") }))
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
    group: str(r.group, "").trim() ? canonicalField(str(r.group, "").trim()) : "",
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
