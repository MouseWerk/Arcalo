// YAML-lite for page properties: `key: value`, dates, lists (`[a, b]` or `- a`).
// Anything more complex stays a raw row and is written back verbatim.

export type PropType = "text" | "date" | "list" | "raw";

export interface Property {
  /** Empty for raw lines without a key (comments, stray text). */
  key: string;
  type: PropType;
  /** Text or date; for raw rows the complete original lines. */
  value: string;
  items: string[];
  /** Original lines; written back unchanged until the property is edited. */
  source?: string;
}

/** Keys Obsidian treats as lists. */
export const LIST_KEYS = new Set(["tags", "tag", "aliases", "alias", "cssclasses"]);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Names the property editor accepts: plain YAML keys that read back as the same key. */
export const VALID_KEY_RE = /^[^\s#:\-[\]{}'"&*!|>%@`?,][^:]*$/u;
export const isValidKey = (key: string) => VALID_KEY_RE.test(key);

const KEY_RE = /^([^\s#:\-[\]{}'"][^:]*?)\s*:(?:\s+(.*?))?\s*$/;
const ITEM_RE = /^\s*-(?:\s+(.*?))?\s*$/;
/**
 * A frontmatter block is only recognized when its first line looks like this (a `key:` line
 * with any Unicode key, e.g. `Priorität:` or `due date:`); shared with splitFrontmatter.
 */
export const FIRST_LINE_RE = /^[^\s#:\-[\]{}'"][^:]*:/u;

/** Unquotes a plain or quoted YAML scalar; `null` when it is not a simple one. */
function scalar(v: string): string | null {
  v = v.trim();
  const dq = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  if (dq) return dq[1].replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c));
  const sq = /^'((?:[^']|'')*)'$/.exec(v);
  if (sq) return sq[1].replace(/''/g, "'");
  if (/^[[\]{}&*!|>'"%@`]/.test(v) || / #/.test(v) || /:(\s|$)/.test(v)) return null;
  return v;
}

/** Items of a flow list body (`a, "b, c", d`); `null` if it is not a simple one. */
function flowItems(inner: string): string[] | null {
  const raw: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') cur += inner[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === ",") {
      raw.push(cur);
      cur = "";
    } else cur += c;
  }
  if (quote) return null;
  raw.push(cur);
  if (raw.length && !raw[raw.length - 1].trim()) raw.pop();
  const items: string[] = [];
  for (const r of raw) {
    const s = scalar(r);
    if (s === null || (!s && raw.length > 1)) return null;
    if (s) items.push(s);
  }
  return items;
}

function classify(key: string, value: string, cont: string[], source: string): Property {
  const raw: Property = { key, type: "raw", value: source, items: [], source };
  if (cont.length) {
    if (value) return raw;
    const items: string[] = [];
    for (const l of cont) {
      const m = ITEM_RE.exec(l);
      const s = m ? scalar(m[1] ?? "") : null;
      if (s === null || !s) return raw;
      items.push(s);
    }
    return { key, type: "list", value: "", items, source };
  }
  const flow = /^\[(.*)\]$/.exec(value);
  if (flow) {
    const items = flowItems(flow[1]);
    return items ? { key, type: "list", value: "", items, source } : raw;
  }
  const s = scalar(value);
  if (s === null) return raw;
  if (!s && LIST_KEYS.has(key.toLowerCase())) return { key, type: "list", value: "", items: [], source };
  return { key, type: DATE_RE.test(s) ? "date" : "text", value: s, items: [], source };
}

/** Parses a frontmatter block (with or without the `---` lines). */
export function parseFrontmatter(fm: string): Property[] {
  let lines = fm.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines[0]?.trim() === "---") {
    lines = lines.slice(1);
    if (lines[lines.length - 1]?.trim() === "---") lines = lines.slice(0, -1);
  }
  if (lines.length === 1 && lines[0] === "") return [];
  const out: Property[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = KEY_RE.exec(lines[i]);
    const start = i++;
    const cont: string[] = [];
    while (i < lines.length && /^(\s|-)/.test(lines[i]) && lines[i].trim()) cont.push(lines[i++]);
    const source = lines.slice(start, i).join("\n");
    if (m) {
      out.push(classify(m[1], m[2] ?? "", cont, source));
      continue;
    }
    // Keyless lines (comments, blank lines, stray text) are kept together as one raw row.
    const prev = out[out.length - 1];
    if (prev && !prev.key) {
      prev.value = prev.source = `${prev.source}\n${source}`;
    } else out.push({ key: "", type: "raw", value: source, items: [], source });
  }
  return out;
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** Plain scalars YAML would read as booleans, null, numbers or timestamps instead of text. */
const YAML_TYPED_RE = /^(true|false|null|~|[-+]?(\d[\d_.:eE+-]*|\.\d[\d_eE+-]*|\.inf|0x[\da-f_]+|0o[0-7_]+)|\.nan|\d{4}-\d{2}-\d{2}T.*)$/i;

function fmtScalar(s: string, inList = false) {
  // Dates (`YYYY-MM-DD`) are date properties and stay plain; other typed-looking text is quoted.
  const typed = YAML_TYPED_RE.test(s) && !DATE_RE.test(s);
  const plain = !typed && s === s.trim() && scalar(s) === s && !/\n/.test(s) && !/^(- |-$|[#,?])/.test(s) && !(inList && /[,[\]]/.test(s));
  return plain ? s : quote(s);
}

/** YAML lines of one property. */
export function propertyLines(p: Property): string {
  if (p.source !== undefined) return p.source;
  if (p.type === "raw") return p.value;
  if (p.type === "list") return `${p.key}: [${p.items.map((s) => fmtScalar(s, true)).join(", ")}]`;
  return p.value ? `${p.key}: ${fmtScalar(p.value)}` : `${p.key}:`;
}

/** Frontmatter block with `---` lines and a trailing newline; empty without properties. */
export function serializeFrontmatter(props: Property[]): string {
  const rows = props.filter((p) => p.key || p.value.trim());
  if (!rows.length) return "";
  // A block must start with a plain `key:` line to be recognized again.
  const first = rows.findIndex((p) => FIRST_LINE_RE.test(propertyLines(p)));
  if (first > 0) rows.unshift(...rows.splice(first, 1));
  return `---\n${rows.map(propertyLines).join("\n")}\n---\n`;
}

/** A new or edited property: drops the original lines so it is written in canonical form. */
export function edited(p: Property, change: Partial<Property>): Property {
  const next = { ...p, ...change };
  delete next.source;
  if (next.type !== "raw" && next.type !== "list") next.type = DATE_RE.test(next.value) ? "date" : "text";
  return next;
}

/** Splits a list typed as text: `a, b` → `[a, b]`. */
export function splitItems(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter(Boolean);
}

/** Value of a scalar property (case-insensitive key). */
export function propertyValue(props: Property[], key: string): string | null {
  const want = canonicalKey(key);
  const p = props.find((x) => canonicalKey(x.key) === want && (x.type === "text" || x.type === "date"));
  return p?.value.trim() || null;
}

/**
 * Frontmatter keys Annalo reads, German (as older notes have them) → English alias. Both
 * always work; the first one in a page wins. New content uses the display language's name.
 */
export const KEY_ALIASES: Record<string, string> = {
  vorgang: "activity",
  netzplan: "network",
  eigenschaften: "properties",
  ansicht: "view",
  datum: "date",
  uhrzeit: "time",
  ort: "location",
  organisator: "organizer",
  teilnehmer: "attendees",
  von: "from",
  an: "to",
  betreff: "subject",
};
const KEY_DE: Record<string, string> = Object.fromEntries(Object.entries(KEY_ALIASES).map(([de, en]) => [en, de]));
/** A key in either language under its German name (lowercase). */
export const canonicalKey = (key: string) => {
  const l = key.trim().toLowerCase();
  return KEY_DE[l] ?? l;
};
/** The name to write for a known key (given by its German name) in a language. */
export const keyName = (de: string, lang: "de" | "en") => (lang === "en" ? (KEY_ALIASES[de] ?? de) : de);
