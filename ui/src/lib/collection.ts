// Typed page properties and the table/board views of a page's child pages.
//
// The parent page's frontmatter holds the schema (`eigenschaften:`) and the view settings
// (`ansicht:`); the child pages keep plain values (`status: Offen`). Same format as the core's
// `properties.rs`, see docs/ARCHITECTURE.md. Values that do not fit their type are marked, never
// changed.

import { DATE_RE, parseFrontmatter, propertyLines, serializeFrontmatter, type Property } from "./frontmatter";
import { dumpFlow, flowScalar, isMap, parseEntry, yget, yitems, type Yaml } from "./yaml";

export type PropKind = "text" | "select" | "multi_select" | "number" | "date" | "person" | "checkbox" | "link";

/** The kinds in menu order, with their schema name and label. */
export const KINDS: { kind: PropKind; name: string; label: string }[] = [
  { kind: "text", name: "text", label: "Text" },
  { kind: "select", name: "auswahl", label: "Auswahl" },
  { kind: "multi_select", name: "mehrfachauswahl", label: "Mehrfachauswahl" },
  { kind: "number", name: "zahl", label: "Zahl" },
  { kind: "date", name: "datum", label: "Datum" },
  { kind: "person", name: "person", label: "Person" },
  { kind: "checkbox", name: "checkbox", label: "Checkbox" },
  { kind: "link", name: "link", label: "Link" },
];
export const kindLabel = (k: PropKind) => KINDS.find((x) => x.kind === k)!.label;
const ALIASES: Record<string, PropKind> = {
  select: "select",
  "multi-select": "multi_select",
  multiselect: "multi_select",
  multi_select: "multi_select",
  number: "number",
  date: "date",
  kontrollkästchen: "checkbox",
  haken: "checkbox",
  url: "link",
  verweis: "link",
};
export function parseKind(s: string): PropKind | null {
  const lower = s.trim().toLowerCase();
  return KINDS.find((k) => k.name === lower)?.kind ?? ALIASES[lower] ?? null;
}

/** Option colors; the first is the default. CSS: `.opt-<index>`. */
export const COLORS = ["grau", "braun", "orange", "gelb", "grün", "blau", "lila", "rosa", "rot"] as const;
export const COLOR_LABELS = ["Grau", "Braun", "Orange", "Gelb", "Grün", "Blau", "Lila", "Rosa", "Rot"];
export const colorIndex = (c: string) => Math.max(0, COLORS.indexOf(c as (typeof COLORS)[number]));

export interface SelectOption {
  name: string;
  color: string;
}
export interface PropDef {
  key: string;
  kind: PropKind;
  options: SelectOption[];
}

export const SCHEMA_KEY = "eigenschaften";
export const VIEW_KEY = "ansicht";
/** The page title as a column / filter field. */
export const TITLE = "titel";
/** Label of a field in headers, menus and filters. */
export const fieldLabel = (key: string) => (key === TITLE ? "Titel" : key);
/** Keys the views manage themselves; the property editor does not list them. */
export const isManagedKey = (key: string) => /^(eigenschaften|ansicht)$/i.test(key.trim());
export const hasOptions = (k: PropKind) => k === "select" || k === "multi_select";

// ------------------------------------------------------------------ schema

function colorOf(name: string, index: number): string {
  const lower = name.trim().toLowerCase();
  const c = lower === "gruen" ? "grün" : lower;
  return (COLORS as readonly string[]).includes(c) ? c : COLORS[index % COLORS.length];
}

/** Reads the `eigenschaften:` value; entries with an unknown type are skipped. */
export function schemaFromYaml(v: Yaml | null): PropDef[] | null {
  if (v === null) return null;
  if (typeof v === "string") return v.trim() ? null : [];
  if (!isMap(v)) return null;
  const out: PropDef[] = [];
  for (const [key, def] of v.entries) {
    const typ = typeof def === "string" ? def : yget(def, "typ") ?? yget(def, "type");
    const kind = typeof typ === "string" ? parseKind(typ) : null;
    if (!kind || out.some((p) => p.key.toLowerCase() === key.toLowerCase())) continue;
    const options: SelectOption[] = [];
    const push = (name: string, color?: Yaml) => {
      const n = name.trim();
      if (n && !options.some((o) => o.name.toLowerCase() === n.toLowerCase())) options.push({ name: n, color: colorOf(typeof color === "string" ? color : "", options.length) });
    };
    const opts = typeof def === "string" ? undefined : yget(def, "optionen") ?? yget(def, "options");
    if (isMap(opts)) opts.entries.forEach(([n, c]) => push(n, c));
    else if (Array.isArray(opts))
      for (const it of opts) {
        if (typeof it === "string") push(it);
        else if (isMap(it)) it.entries.forEach(([n, c]) => push(n, c));
      }
    out.push({ key, kind, options });
  }
  return out;
}

const findProp = (props: Property[], key: string) => props.find((p) => p.key.toLowerCase() === key.toLowerCase());

/** The schema in a page's frontmatter; `null` when it defines none. */
export function parseSchema(fm: string): PropDef[] | null {
  const p = findProp(parseFrontmatter(fm), SCHEMA_KEY);
  return p ? schemaFromYaml(parseEntry(propertyLines(p))) : null;
}

/** The `eigenschaften:` block (as the core writes it). */
export function schemaLines(defs: PropDef[]): string {
  const rows = defs.map((p) => {
    const name = KINDS.find((k) => k.kind === p.kind)!.name;
    const def = p.options.length ? `{typ: ${name}, optionen: {${p.options.map((o) => `${flowScalar(o.name)}: ${o.color}`).join(", ")}}}` : name;
    return `\n  ${p.key}: ${def}`;
  });
  return `${SCHEMA_KEY}:${rows.join("")}`;
}

/** Replaces (or adds, or with `null` removes) a top-level entry, keeping every other line. */
export function setEntry(fm: string, key: string, lines: string | null): string {
  const props = parseFrontmatter(fm);
  const i = props.findIndex((p) => p.key.toLowerCase() === key.toLowerCase());
  const row: Property | null = lines === null ? null : { key, type: "raw", value: lines, items: [], source: lines };
  if (i < 0) return row ? serializeFrontmatter([...props, row]) : fm;
  if (row) {
    if (propertyLines(props[i]) === lines) return fm;
    props[i] = row;
  } else props.splice(i, 1);
  return serializeFrontmatter(props);
}

/** The frontmatter with a new schema; an empty schema removes the key (free text again). */
export const setSchema = (fm: string, defs: PropDef[] | null) => setEntry(fm, SCHEMA_KEY, defs && defs.length ? schemaLines(defs) : null);

// ------------------------------------------------------------------ view settings

export type ViewType = "liste" | "tabelle" | "board";
export interface SortSpec {
  field: string;
  dir: "auf" | "ab";
}
export interface FilterSpec {
  field: string;
  op: string;
  value: string;
}
export interface ViewSettings {
  type: ViewType;
  sort: SortSpec | null;
  filters: FilterSpec[];
  /** Column order (table); columns not listed follow in schema order. */
  columns: string[];
  hidden: string[];
  widths: Record<string, number>;
  /** Board: the property that makes the columns. */
  group: string | null;
  /** Board: properties shown on the cards. */
  cards: string[];
  /** Board: collapsed columns (option names, `""` for „Ohne Wert“). */
  collapsed: string[];
  /** Keys this version does not know, written back as they were read. */
  extra: [string, Yaml][];
}

export const defaultView = (): ViewSettings => ({ type: "liste", sort: null, filters: [], columns: [], hidden: [], widths: {}, group: null, cards: [], collapsed: [], extra: [] });
const KNOWN_VIEW_KEYS = ["typ", "sortierung", "filter", "spalten", "ausgeblendet", "breiten", "gruppierung", "karten", "eingeklappt"];

const viewType = (s: string): ViewType | null => {
  const l = s.trim().toLowerCase();
  return l === "tabelle" || l === "table" ? "tabelle" : l === "board" ? "board" : l === "liste" || l === "list" ? "liste" : null;
};

export function viewFromYaml(v: Yaml | null): ViewSettings {
  const out = defaultView();
  if (typeof v === "string") {
    out.type = viewType(v) ?? "liste";
    return out;
  }
  if (!isMap(v)) return out;
  const str = (x: Yaml | undefined) => (typeof x === "string" ? x : "");
  out.type = viewType(str(yget(v, "typ"))) ?? "liste";
  const sort = yget(v, "sortierung");
  if (isMap(sort) && str(yget(sort, "feld"))) out.sort = { field: str(yget(sort, "feld")), dir: /^(ab|absteigend|desc)$/i.test(str(yget(sort, "richtung"))) ? "ab" : "auf" };
  const filters = yget(v, "filter");
  for (const f of Array.isArray(filters) ? filters : isMap(filters) ? [filters] : []) {
    if (isMap(f) && str(yget(f, "feld")) && str(yget(f, "op"))) out.filters.push({ field: str(yget(f, "feld")), op: str(yget(f, "op")), value: str(yget(f, "wert")) });
  }
  out.columns = yitems(yget(v, "spalten")) ?? [];
  out.hidden = yitems(yget(v, "ausgeblendet")) ?? [];
  const widths = yget(v, "breiten");
  if (isMap(widths))
    for (const [k, w] of widths.entries) {
      const n = typeof w === "string" ? Number(w) : NaN;
      if (Number.isFinite(n) && n > 0) out.widths[k] = Math.round(n);
    }
  out.group = str(yget(v, "gruppierung")) || null;
  out.cards = yitems(yget(v, "karten")) ?? [];
  const collapsed = yget(v, "eingeklappt");
  out.collapsed = Array.isArray(collapsed) ? collapsed.filter((x): x is string => typeof x === "string") : [];
  out.extra = v.entries.filter(([k]) => !KNOWN_VIEW_KEYS.includes(k.toLowerCase()));
  return out;
}

export function parseView(fm: string): ViewSettings {
  const p = findProp(parseFrontmatter(fm), VIEW_KEY);
  return p ? viewFromYaml(parseEntry(propertyLines(p))) : defaultView();
}

const list = (items: string[]) => `[${items.map(flowScalar).join(", ")}]`;

/** The `ansicht:` entry; `null` for the default list view without settings. */
export function viewLines(v: ViewSettings): string | null {
  const rows: string[] = [];
  if (v.sort) rows.push(`sortierung: {feld: ${flowScalar(v.sort.field)}, richtung: ${v.sort.dir}}`);
  if (v.filters.length) rows.push(`filter: [${v.filters.map((f) => `{feld: ${flowScalar(f.field)}, op: ${flowScalar(f.op)}, wert: ${flowScalar(f.value)}}`).join(", ")}]`);
  if (v.columns.length) rows.push(`spalten: ${list(v.columns)}`);
  if (v.hidden.length) rows.push(`ausgeblendet: ${list(v.hidden)}`);
  const widths = Object.entries(v.widths);
  if (widths.length) rows.push(`breiten: {${widths.map(([k, w]) => `${flowScalar(k)}: ${Math.round(w)}`).join(", ")}}`);
  if (v.group) rows.push(`gruppierung: ${flowScalar(v.group)}`);
  if (v.cards.length) rows.push(`karten: ${list(v.cards)}`);
  // `""` is the „Ohne Wert“ column: always quoted.
  if (v.collapsed.length) rows.push(`eingeklappt: [${v.collapsed.map((c) => (c ? flowScalar(c) : '""')).join(", ")}]`);
  for (const [k, x] of v.extra) rows.push(`${k}: ${dumpFlow(x)}`);
  if (!rows.length) return v.type === "liste" ? null : `${VIEW_KEY}: ${v.type}`;
  return `${VIEW_KEY}:\n  typ: ${v.type}\n${rows.map((r) => `  ${r}`).join("\n")}`;
}

export const setView = (fm: string, v: ViewSettings) => setEntry(fm, VIEW_KEY, viewLines(v));

// ------------------------------------------------------------------ rows and cells

export type Typed =
  | { kind: "text"; value: string }
  | { kind: "select"; value: string }
  | { kind: "multi_select"; value: string[] }
  | { kind: "number"; value: number }
  | { kind: "date"; value: string }
  | { kind: "person"; value: string }
  | { kind: "checkbox"; value: boolean }
  | { kind: "link"; value: string };

export interface Cell {
  /** As written (lists joined with `, `); empty when missing. */
  text: string;
  /** The items of a list value (or the one scalar). */
  items: string[];
  value: Typed | null;
  error: string | null;
}

/** A child page in a view. */
export interface Row {
  id: number;
  title: string;
  icon: string | null;
  position: number;
  updated_at: string;
  /** Its frontmatter block. */
  fm: string;
  props: Property[];
}

export const makeRow = (p: { id: number; title: string; icon: string | null; position: number; updated_at: string }, fm: string): Row => ({
  id: p.id,
  title: p.title,
  icon: p.icon,
  position: p.position,
  updated_at: p.updated_at,
  fm,
  props: parseFrontmatter(fm),
});

/** A number as people type it: `3`, `-1.5`, `1,5`, `1.234,5`. */
export function parseNumber(text: string): number | null {
  const s = text.trim().replace(/[\s ]/g, "");
  if (!s || !/^[-+]?[\d.,]+$/.test(s)) return null;
  const c = s.lastIndexOf(",");
  const d = s.lastIndexOf(".");
  const n = c >= 0 && d >= 0 ? (c > d ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "")) : c >= 0 ? s.replace(",", ".") : s;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(n)) return null;
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

export const isLink = (s: string) => /^\[\[[^[\]]+\]\]$/.test(s) || /^(https?:\/\/|mailto:|file:|www\.)\S+$/i.test(s);

export function parseCheckbox(s: string): boolean | null {
  const l = s.trim().toLowerCase();
  if (["true", "ja", "yes", "x", "1", "wahr"].includes(l)) return true;
  if (["false", "nein", "no", "0", "falsch"].includes(l)) return false;
  return null;
}

const validDate = (s: string) => {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** The raw input of a property: `undefined` when missing, `null` when it is YAML the editor keeps raw. */
export function cellInput(props: Property[], key: string): { items: string[]; list: boolean } | null | undefined {
  const p = findProp(props, key);
  if (!p) return undefined;
  if (p.type === "list") return { items: p.items, list: true };
  if (p.type === "raw") {
    const v = parseEntry(propertyLines(p));
    const items = yitems(v);
    return items ? { items, list: Array.isArray(v) } : null;
  }
  return { items: p.value.trim() ? [p.value.trim()] : [], list: false };
}

/** Checks a value against its type (mirrors the core's `validate`). */
export function validate(def: PropDef | undefined, input: { items: string[]; list: boolean } | null | undefined): Cell {
  if (input === undefined) return { text: "", items: [], value: null, error: null };
  if (input === null) return { text: "", items: [], value: null, error: "Unbekanntes YAML-Format" };
  const items = input.items.filter(Boolean);
  const cell: Cell = { text: items.join(", "), items, value: null, error: null };
  if (!items.length) return cell;
  const kind = def?.kind ?? "text";
  const s = items[0];
  const option = (n: string) => def?.options.find((o) => o.name.toLowerCase() === n.toLowerCase());
  if (kind === "text") cell.value = { kind, value: cell.text };
  else if (input.list && kind !== "multi_select") cell.error = "Liste statt einzelnem Wert";
  else if (kind === "select") {
    const o = option(s);
    if (o) cell.value = { kind, value: o.name };
    else cell.error = `„${s}“ ist keine Option`;
  } else if (kind === "multi_select") {
    const unknown = items.filter((i) => !option(i));
    if (!unknown.length) cell.value = { kind, value: items.map((i) => option(i)!.name) };
    else cell.error = `${unknown.map((u) => `„${u}“`).join(", ")} ${unknown.length === 1 ? "ist" : "sind"} keine Option`;
  } else if (kind === "number") {
    const n = parseNumber(s);
    if (n !== null) cell.value = { kind, value: n };
    else cell.error = "Keine Zahl";
  } else if (kind === "date") {
    if (validDate(s)) cell.value = { kind, value: s };
    else cell.error = "Kein Datum (JJJJ-MM-TT)";
  } else if (kind === "person") {
    const name = s.replace(/^@+/, "").trim();
    if (name) cell.value = { kind, value: name };
    else cell.error = "Keine Person";
  } else if (kind === "checkbox") {
    const b = parseCheckbox(s);
    if (b !== null) cell.value = { kind, value: b };
    else cell.error = "Weder ja noch nein";
  } else if (kind === "link") {
    if (isLink(s)) cell.value = { kind, value: s };
    else cell.error = "Kein Link (URL oder [[Seite]])";
  }
  return cell;
}

export const cellOf = (row: Row, key: string, def?: PropDef): Cell =>
  key === TITLE && !def ? { text: row.title, items: [row.title], value: { kind: "text", value: row.title }, error: null } : validate(def, cellInput(row.props, key));

/** What a cell edit writes: text, a list, a number, a checkbox or nothing. */
export type CellWrite = string | string[] | number | boolean | null;

/** The frontmatter with one property set; every other line stays as it was. */
export function writeValue(fm: string, key: string, value: CellWrite): string {
  const props = parseFrontmatter(fm);
  const i = props.findIndex((p) => p.key.toLowerCase() === key.toLowerCase());
  const empty = value === null || value === "" || (Array.isArray(value) && !value.length);
  if (empty && i < 0) return fm;
  const name = i >= 0 ? props[i].key : key;
  let row: Property;
  if (empty) row = { key: name, type: "text", value: "", items: [] };
  else if (Array.isArray(value)) row = { key: name, type: "list", value: "", items: value };
  else if (typeof value === "number" || typeof value === "boolean") {
    // Plain, so YAML reads a number or a boolean.
    const text = typeof value === "number" ? String(Math.round(value * 1e9) / 1e9) : String(value);
    row = { key: name, type: "text", value: text, items: [], source: `${name}: ${text}` };
  } else row = { key: name, type: DATE_RE.test(value) ? "date" : "text", value, items: [] };
  if (i >= 0) {
    if (propertyLines(props[i]) === propertyLines(row)) return fm;
    props[i] = row;
  } else props.push(row);
  return serializeFrontmatter(props);
}

/** The value a typed edit writes for text typed into a cell (numbers as numbers, lists split). */
export function writeFromText(def: PropDef | undefined, text: string): CellWrite {
  const t = text.trim();
  if (!t) return null;
  const kind = def?.kind ?? "text";
  if (kind === "number") return parseNumber(t) ?? t;
  if (kind === "checkbox") return parseCheckbox(t) ?? t;
  if (kind === "multi_select")
    return t
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (kind === "person") return t.replace(/^@+/, "");
  return t;
}

// ------------------------------------------------------------------ filter, sort, group

export interface OpDef {
  op: string;
  label: string;
  /** Needs a value. */
  value: boolean;
}
const op = (o: string, label = o, value = true): OpDef => ({ op: o, label, value });
const EMPTY_OPS = [op("ist leer", "ist leer", false), op("ist nicht leer", "ist nicht leer", false)];

/** Operators a filter on a field of this kind offers. */
export function opsFor(kind: PropKind): OpDef[] {
  switch (kind) {
    case "select":
    case "person":
    case "multi_select":
      return [op("ist"), op("ist nicht"), ...EMPTY_OPS];
    case "number":
      return [op("ist", "="), op("ist nicht", "≠"), op(">"), op("<"), op(">="), op("<="), ...EMPTY_OPS];
    case "date":
      return [op("ist"), op("vor"), op("nach"), ...EMPTY_OPS];
    case "checkbox":
      return [op("ist")];
    default:
      return [op("enthält"), op("enthält nicht"), op("ist"), op("ist nicht"), ...EMPTY_OPS];
  }
}

/** Whether a cell passes `op wanted` (mirrors the core's `matches`); dates accept `heute`. */
export function matches(cell: Cell | null, operator: string, wanted: string, today: string): boolean {
  const text = cell?.text ?? "";
  const empty = !text.trim();
  const lower = wanted.trim().toLowerCase();
  const v = cell?.value;
  const values = v?.kind === "multi_select" ? v.value.map((s) => s.toLowerCase()) : v?.kind === "checkbox" ? [v.value ? "ja" : "nein"] : [text.trim().toLowerCase()];
  const wb = parseCheckbox(wanted);
  const wantedBool = wb === null ? null : wb ? "ja" : "nein";
  const eq = (x: string) => x === lower || (wantedBool !== null && x === wantedBool);
  const cmp = (): number | null => {
    if (v?.kind === "number") {
      const w = parseNumber(wanted);
      return w === null ? null : Math.sign(v.value - w);
    }
    if (v?.kind === "date") {
      const w = lower === "heute" ? today : wanted.trim();
      return validDate(w) ? Math.sign(v.value.localeCompare(w)) : null;
    }
    return null;
  };
  switch (operator) {
    case "ist":
      return values.some(eq) || (!lower && empty) || cmp() === 0;
    case "ist nicht":
      return !(values.some(eq) || cmp() === 0);
    case "enthält":
      return text.toLowerCase().includes(lower);
    case "enthält nicht":
      return !text.toLowerCase().includes(lower);
    case "ist leer":
      return empty;
    case "ist nicht leer":
      return !empty;
    case "vor":
    case "<":
      return cmp() === -1;
    case "nach":
    case ">":
      return cmp() === 1;
    case "<=":
      return cmp() === -1 || cmp() === 0;
    case ">=":
      return cmp() === 1 || cmp() === 0;
    default:
      return true;
  }
}

export const defOf = (defs: PropDef[] | null, key: string) => defs?.find((d) => d.key.toLowerCase() === key.toLowerCase());

/** The kind a field is filtered and sorted as (the title and unknown properties are text). */
export const kindOf = (defs: PropDef[] | null, key: string): PropKind => defOf(defs, key)?.kind ?? "text";

/** Filters that apply: a condition that needs a value counts once it has one. */
export const activeFilters = (filters: FilterSpec[]) => filters.filter((f) => f.value.trim() || /leer$/.test(f.op));

export function filterRows(rows: Row[], filters: FilterSpec[], defs: PropDef[] | null, today: string): Row[] {
  const active = activeFilters(filters);
  if (!active.length) return rows;
  return rows.filter((r) => active.every((f) => matches(cellOf(r, f.field, defOf(defs, f.field)), f.op, f.value, today)));
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

/** Sorts by one field; empty and invalid values go last in both directions. Stable. */
export function sortRows(rows: Row[], sort: SortSpec | null, defs: PropDef[] | null): Row[] {
  if (!sort) return rows;
  const def = defOf(defs, sort.field);
  const optIndex = (name: string) => def?.options.findIndex((o) => o.name === name) ?? -1;
  const keyed = rows.map((r, i) => {
    const c = cellOf(r, sort.field, def);
    const v = c.value;
    let k: number | string | null = null;
    if (v) {
      if (v.kind === "number") k = v.value;
      else if (v.kind === "checkbox") k = v.value ? 1 : 0;
      else if (v.kind === "select") k = optIndex(v.value);
      else if (v.kind === "multi_select") k = v.value.length ? optIndex(v.value[0]) : null;
      else k = String(v.value);
    }
    return { r, i, k };
  });
  const dir = sort.dir === "ab" ? -1 : 1;
  keyed.sort((a, b) => {
    if (a.k === null || b.k === null) return a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1;
    const c = typeof a.k === "number" && typeof b.k === "number" ? a.k - b.k : collator.compare(String(a.k), String(b.k));
    return c * dir || a.i - b.i;
  });
  return keyed.map((x) => x.r);
}

/** Kinds a board can be grouped by. */
export const groupable = (k: PropKind) => k === "select" || k === "person" || k === "checkbox";

export interface Group {
  /** Option name, person, `ja`/`nein`, or `""` for „Ohne Wert“. */
  key: string;
  label: string;
  /** Color index (`.opt-N`); `null` without a color. */
  color: number | null;
  rows: Row[];
  /** Values that are not an option of the property. */
  invalid?: boolean;
}

/** Board columns: one per option (or person, or ja/nein), then „Ohne Wert“. Rows keep their order. */
export function groupRows(rows: Row[], def: PropDef): Group[] {
  const groups: Group[] = [];
  const find = (key: string) => groups.find((g) => g.key.toLowerCase() === key.toLowerCase());
  if (def.kind === "select") def.options.forEach((o) => groups.push({ key: o.name, label: o.name, color: colorIndex(o.color), rows: [] }));
  if (def.kind === "checkbox") groups.push({ key: "ja", label: "Ja", color: null, rows: [] }, { key: "nein", label: "Nein", color: null, rows: [] });
  const none: Group = { key: "", label: "Ohne Wert", color: null, rows: [] };
  const extra: Group[] = [];
  for (const r of rows) {
    const c = cellOf(r, def.key, def);
    let key = "";
    if (def.kind === "checkbox") key = c.value?.kind === "checkbox" && c.value.value ? "ja" : c.text && c.error ? c.text : "nein";
    else key = c.value?.kind === "select" || c.value?.kind === "person" ? c.value.value : c.text;
    if (!key) {
      none.rows.push(r);
      continue;
    }
    let g = find(key) ?? extra.find((x) => x.key.toLowerCase() === key.toLowerCase());
    if (!g) {
      g = { key, label: key, color: null, rows: [], invalid: def.kind !== "person" };
      extra.push(g);
    }
    g.rows.push(r);
  }
  if (def.kind === "person") extra.sort((a, b) => collator.compare(a.key, b.key));
  return [...groups, ...extra, ...(def.kind === "checkbox" ? [] : [none])];
}

/** Properties shown on board cards: the chosen ones, else the first two besides the grouping. */
export function boardCards(view: ViewSettings, defs: PropDef[] | null, group: string | null): string[] {
  const other = (k: string) => !group || k.toLowerCase() !== group.toLowerCase();
  if (view.cards.length) return view.cards.filter(other);
  return (defs ?? []).map((d) => d.key).filter(other).slice(0, 2);
}

/** What dropping a card into a column writes. */
export function groupWrite(def: PropDef, key: string): CellWrite {
  if (def.kind === "checkbox") return key === "ja";
  return key || null;
}

/** The kind that fits all given values (for a property added to every page of a folder). */
export function inferKind(values: string[]): PropKind {
  const v = values.map((s) => s.trim()).filter(Boolean);
  if (!v.length) return "text";
  if (v.every((s) => parseNumber(s) !== null)) return "number";
  if (v.every(validDate)) return "date";
  if (v.every((s) => parseCheckbox(s) !== null && !/^[01]$/.test(s))) return "checkbox";
  if (v.every(isLink)) return "link";
  return "text";
}

/** Table columns: the title, the schema's properties and the other properties found on the rows, in the saved order. */
export function columnKeys(defs: PropDef[] | null, rows: Row[], view: ViewSettings): string[] {
  const keys: string[] = [TITLE];
  const add = (k: string) => {
    if (!keys.some((x) => x.toLowerCase() === k.toLowerCase())) keys.push(k);
  };
  defs?.forEach((d) => add(d.key));
  for (const r of rows) for (const p of r.props) if (p.key && !isManagedKey(p.key)) add(p.key);
  const pos = (k: string) => {
    const i = view.columns.findIndex((c) => c.toLowerCase() === k.toLowerCase());
    return i < 0 ? Infinity : i;
  };
  const ordered = keys.map((k, i) => ({ k, i })).sort((a, b) => (a.k === TITLE ? -1 : b.k === TITLE ? 1 : pos(a.k) - pos(b.k) || a.i - b.i));
  return ordered.map((x) => x.k).filter((k) => k === TITLE || !view.hidden.some((h) => h.toLowerCase() === k.toLowerCase()));
}

/** Today as `YYYY-MM-DD` (local). */
export function todayIso(now = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
