// The YAML subset of nested page properties (schema and view settings): scalars, flow lists and
// maps (`[a, b]`, `{typ: zahl}`) and indented block lists and maps. Same grammar as the core's
// `properties.rs`; maps keep their order.

export interface YMap {
  entries: [string, Yaml][];
}
export type Yaml = string | Yaml[] | YMap;

export const isMap = (v: Yaml | null | undefined): v is YMap => typeof v === "object" && v !== null && !Array.isArray(v);
export const ymap = (entries: [string, Yaml][]): YMap => ({ entries });

/** Value of a map key (case-insensitive). */
export function yget(v: Yaml | null | undefined, key: string): Yaml | undefined {
  if (!isMap(v)) return undefined;
  const lower = key.toLowerCase();
  return v.entries.find(([k]) => k.toLowerCase() === lower)?.[1];
}

/** `key: rest` of a map line; keys follow the property editor's rules. */
function splitKey(line: string): [string, string] | null {
  if (!line || /^[\s#:\-[\]{}'"]/.test(line)) return null;
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const rest = line.slice(colon + 1);
  if (rest && !/^[ \t]/.test(rest)) return null;
  return [line.slice(0, colon).trimEnd(), rest.trim()];
}

class Flow {
  i = 0;
  constructor(readonly s: string) {}
  peek() {
    return this.s[this.i];
  }
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  value(): Yaml | null {
    this.ws();
    const c = this.peek();
    if (c === undefined) return null;
    if (c === "[") {
      this.i++;
      const items: Yaml[] = [];
      for (;;) {
        this.ws();
        if (this.peek() === undefined) return null;
        if (this.peek() === "]") {
          this.i++;
          return items;
        }
        const v = this.value();
        if (v === null) return null;
        items.push(v);
        this.ws();
        if (this.peek() === ",") this.i++;
        else if (this.peek() !== "]") return null;
      }
    }
    if (c === "{") {
      this.i++;
      const entries: [string, Yaml][] = [];
      for (;;) {
        this.ws();
        if (this.peek() === undefined) return null;
        if (this.peek() === "}") {
          this.i++;
          return { entries };
        }
        const key = this.peek() === '"' || this.peek() === "'" ? this.quoted() : this.plain(true);
        if (key === null) return null;
        this.ws();
        if (this.peek() !== ":") return null;
        this.i++;
        this.ws();
        let v: Yaml | null = "";
        if (this.peek() !== "," && this.peek() !== "}") v = this.value();
        if (v === null) return null;
        entries.push([key, v]);
        this.ws();
        if (this.peek() === ",") this.i++;
        else if (this.peek() !== "}") return null;
      }
    }
    if (c === '"' || c === "'") return this.quoted();
    if (c === "]" || c === "}" || c === ",") return null;
    return this.plain(false);
  }
  /** A plain scalar inside a flow collection: up to `,`, `]`, `}` or a `: `. */
  plain(key: boolean): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "," || c === "]" || c === "}") break;
      const n = this.s[this.i + 1];
      if (c === ":" && (key || n === undefined || /[\s,}\]]/.test(n))) break;
      this.i++;
    }
    return this.s.slice(start, this.i).trim();
  }
  quoted(): string | null {
    const q = this.s[this.i++];
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) return null;
      if (q === '"' && c === "\\") {
        const e = this.s[this.i++];
        if (e === undefined) return null;
        out += e === "n" ? "\n" : e === "t" ? "\t" : e;
      } else if (c === q) {
        if (q === "'" && this.s[this.i] === "'") {
          this.i++;
          out += "'";
        } else return out;
      } else out += c;
    }
  }
}

/** A plain or quoted scalar with an optional comment; `null` for block scalars, anchors, `a: b`. */
function scalar(text: string): string | null {
  const v = text.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const p = new Flow(v);
    const s = p.quoted();
    if (s === null) return null;
    const rest = v.slice(p.i);
    const trimmed = rest.trimStart();
    return !trimmed || (trimmed.startsWith("#") && trimmed.length < rest.length) ? s : null;
  }
  const m = /(^|[ \t])#/.exec(v);
  const plain = (m ? v.slice(0, m.index) : v).trim();
  if (/^[[\]{}&*!|>%]/.test(plain) || plain.includes(": ") || plain.endsWith(":")) return null;
  return plain;
}

/** A value on one line: a flow list or map, or a scalar. */
export function parseInline(text: string): Yaml | null {
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) {
    const p = new Flow(t);
    const v = p.value();
    if (v === null) return null;
    const rest = t.slice(p.i).trim();
    return !rest || rest.startsWith("#") ? v : null;
  }
  return scalar(t);
}

interface Line {
  indent: number;
  text: string;
}
const isItem = (t: string) => t === "-" || t.startsWith("- ");

/** An indented block (the lines under `key:`): a block list or a block map. */
export function parseBlock(raw: string[]): Yaml | null {
  const lines: Line[] = raw
    .map((l) => {
      const text = l.trimStart();
      return { indent: l.length - text.length, text: text.trimEnd() };
    })
    .filter((l) => l.text && !l.text.startsWith("#"));
  if (!lines.length) return "";
  const pos = { i: 0 };
  const v = blockAt(lines, pos, lines[0].indent);
  return v !== null && pos.i === lines.length ? v : null;
}

function nested(lines: Line[], pos: { i: number }, indent: number): Yaml | null {
  if (pos.i < lines.length && lines[pos.i].indent > indent) return blockAt(lines, pos, lines[pos.i].indent);
  return "";
}

function blockAt(lines: Line[], pos: { i: number }, indent: number): Yaml | null {
  if (isItem(lines[pos.i].text)) {
    const items: Yaml[] = [];
    while (pos.i < lines.length && lines[pos.i].indent === indent && isItem(lines[pos.i].text)) {
      const rest = lines[pos.i].text.slice(1).trim();
      pos.i++;
      let item: Yaml | null;
      if (!rest) item = nested(lines, pos, indent);
      else if (splitKey(rest) && !/^["']/.test(rest)) return null;
      else item = parseInline(rest);
      if (item === null) return null;
      items.push(item);
    }
    return items;
  }
  const entries: [string, Yaml][] = [];
  while (pos.i < lines.length && lines[pos.i].indent === indent) {
    const kv = splitKey(lines[pos.i].text);
    if (!kv) return null;
    pos.i++;
    const [key, rest] = kv;
    let v: Yaml | null;
    if (!rest || rest.startsWith("#")) {
      v = pos.i < lines.length && lines[pos.i].indent === indent && isItem(lines[pos.i].text) ? blockAt(lines, pos, indent) : nested(lines, pos, indent);
    } else v = parseInline(rest);
    if (v === null) return null;
    entries.push([key, v]);
  }
  if (pos.i < lines.length && lines[pos.i].indent > indent) return null;
  return { entries };
}

/** The value of a top-level entry from its lines (`key: …` plus indented continuation lines). */
export function parseEntry(source: string): Yaml | null {
  const [head, ...cont] = source.replace(/\r\n/g, "\n").split("\n");
  const kv = splitKey(head);
  if (!kv) return null;
  if (!cont.length) return parseInline(kv[1]);
  if (kv[1] && !kv[1].startsWith("#")) return null;
  return parseBlock(cont);
}

/** A scalar inside flow collections: plain when it reads back unchanged. */
export function flowScalar(s: string): string {
  const plain = !!s && s === s.trim() && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/[,[\]{}\n]/.test(s) && !s.includes(": ") && !s.includes(" #") && !s.endsWith(":");
  return plain ? s : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** A value in flow style. */
export function dumpFlow(v: Yaml): string {
  if (typeof v === "string") return flowScalar(v);
  if (Array.isArray(v)) return `[${v.map(dumpFlow).join(", ")}]`;
  return `{${v.entries.map(([k, x]) => `${flowScalar(k)}: ${dumpFlow(x)}`).join(", ")}}`;
}

/** Strings of a scalar or a list of scalars; `null` for anything else. */
export function yitems(v: Yaml | null | undefined): string[] | null {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const x of v) {
      if (typeof x !== "string") return null;
      out.push(x.trim());
    }
    return out;
  }
  return null;
}
