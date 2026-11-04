// Property: for any document made of the editor's block types, writing it from the editor's
// document is lossless (parsing the written text gives the same document) and stable (writing it
// again gives the same text). Documents are random compositions of block snippets, also nested in
// quotes, callouts and list items, seeded so a failure can be repeated.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, textShape, toMarkdown, withShape } from "./schema";
import { setSourceBlocks } from "./sourceStyle";
import { joinFrontmatter, splitFrontmatter } from "./extensions";

const CORPUS = import.meta.glob("./corpus/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function open(md: string) {
  return new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
}

/** The document as JSON and as Markdown written from the document alone (every block counts as edited). */
function pass(md: string): { doc: unknown; out: string } {
  setSourceBlocks(false);
  const editor = open(md);
  try {
    return { doc: strip(editor.getJSON()), out: toMarkdown(editor) };
  } finally {
    editor.destroy();
    setSourceBlocks(true);
  }
}

/** Attributes that only remember how the source was written (spacing, indentation, fence length). */
const STYLE = new Set(["src", "gap", "fence", "info", "cont", "indent", "loose", "spacedBefore"]);

/** The document without its style attributes. */
function strip(node: unknown): unknown {
  // Empty paragraphs stand for extra blank lines, which a rewrite collapses on purpose.
  if (Array.isArray(node)) return node.filter((n) => !(n?.type === "paragraph" && !n.content)).map(strip);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (!STYLE.has(k)) out[k] = strip(v);
  return out;
}

// Inline pieces: formatting, links, scripts that are not Latin (RTL, combining marks, CJK).
const INLINE = [
  "Text mit **fett** und *kursiv*",
  "~~durch~~ und ==markiert==",
  "`code` und ``a ` b``",
  "[[Seite]] und [[Seite#Abschnitt|Alias]]",
  "[Link](https://example.com/a_b) und https://example.com/x",
  "#tag und #tag/unter",
  "שלום עולם, مرحبا بالعالم",
  "é und ä (kombinierend)",
  "中文 日本語のテキスト 한국어",
  "a < b & c > d",
  "Fußnote[^1]",
  "![[bild.png|300]] und ![[Bericht.pdf]]",
  "Zeile mit  \nUmbruch",
  "Preis: 5 * 3 = 15 und snake_case",
  "\\*kein fett\\* und \\[\\[kein Link]]",
];
const ONE_LINE = INLINE.filter((s) => !s.includes("\n"));

// Block snippets, each a complete Markdown block.
const BLOCKS: ((r: Rand) => string)[] = [
  (r) => r.pick(INLINE),
  (r) => `${"#".repeat(r.int(1, 6))} ${r.pick(ONE_LINE)}`,
  (r) => `- ${r.pick(INLINE)}\n- ${r.pick(INLINE)}\n  - ${r.pick(INLINE)}`,
  (r) => `1. ${r.pick(INLINE)}\n2. ${r.pick(INLINE)}`,
  (r) => `3. ${r.pick(INLINE)}\n4. ${r.pick(INLINE)}`,
  (r) => `- [ ] ${r.pick(INLINE)}\n- [x] ${r.pick(INLINE)}\n  - [ ] ${r.pick(INLINE)}`,
  (r) => `> ${r.pick(INLINE)}\n> ${r.pick(INLINE)}`,
  (r) => `> [!${r.pick(["note", "tip", "warning", "todo"])}]${r.pick(["", "-", "+"])} Titel\n> ${r.pick(INLINE)}`,
  (r) => "```" + r.pick(["", "ts", "py", "go", "make"]) + "\n" + r.pick(CODE) + "\n```",
  (r) => `| A | B |\n| --- | --- |\n| ${r.pick(ONE_LINE).replace(/\|/g, "\\|")} | ${r.pick(ONE_LINE).replace(/\|/g, "\\|")} |`,
  () => "---",
  () => "[TOC]",
  () => "[^1]: Eine Fußnote mit **fett**.",
  () => "<!-- spalten -->\n\nLinks\n\n<!-- spalte -->\n\nRechts\n\n<!-- /spalten -->",
  () => "![[Plan.excalidraw]]",
  () => '<time-entry id="7" hours="1,5" target="NP-1/10">Arbeit</time-entry>',
  () => "$$\nx^2 + y^2\n$$",
];

// Code with tabs, mixed indentation, trailing spaces, CRLF-free blank lines and fence-like lines.
const CODE = [
  "func main() {\n\tif x {\n\t\treturn\n\t}\n}",
  "all:\n\t$(CC) -o app main.c\n\n\nclean:\n\trm -f app",
  "def f():\n    pass   \n\n\n    return 1",
  "  indented\n\tmixed \t tabs",
  "~~~\nnot a fence end\n```js",
  "שלום\n中文\né",
  "",
];

class Rand {
  constructor(private s: number) {}
  next() {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
}

function block(r: Rand, depth = 0): string {
  const b = r.pick(BLOCKS)(r);
  if (depth > 1 || r.next() > 0.2) return b;
  // Nested once: in a quote, a callout or a list item.
  const inner = [b, block(r, depth + 1)].join("\n\n");
  // The table of contents is a block of the page itself (in a list it is listed as low in r2-editor-export.md).
  if (inner.includes("[TOC]")) return b;
  // A numbered list right after a bullet (`- 1. a`) is read as text (listed as low in r2-editor-export.md).
  switch (/^\d/.test(inner) ? 0 : r.int(0, 2)) {
    case 0:
      return inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    case 1:
      return "> [!note] Box\n" + inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    default:
      return "- " + inner.split("\n").map((l, i) => (i === 0 || !l ? l : `  ${l}`)).join("\n");
  }
}

function document_(seed: number): string {
  const r = new Rand(seed);
  const n = r.int(2, 7);
  return Array.from({ length: n }, () => block(r)).join("\n\n") + "\n";
}

/** The first place where two documents differ, as a path and the two values. */
function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return `${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const d = firstDiff(x[k], y[k], `${path}/${k}`);
    if (d) return d;
  }
  return path;
}

function check(md: string) {
  const first = pass(md);
  const second = pass(first.out);
  // Lossless: the written text parses to the same document.
  const lost = firstDiff(first.doc, second.doc);
  expect(lost, `lost on writing ${JSON.stringify(md)}\nwritten ${JSON.stringify(first.out)}`).toBeNull();
  // Stable: writing it again changes nothing.
  expect(second.out, `not stable: ${JSON.stringify(md)}`).toBe(first.out);
}

describe("markdown round trip, property", () => {
  for (const [path, md] of Object.entries(CORPUS)) {
    it(`corpus ${path.replace("./corpus/", "")}`, () => check(splitFrontmatter(md).body));
  }
  it("every block alone", () => {
    const r = new Rand(1);
    for (const make of BLOCKS) for (let i = 0; i < 8; i++) check(make(r) + "\n");
  });
  it("200 random documents", () => {
    for (let seed = 1; seed <= 200; seed++) check(document_(seed));
  });
});

/** Opens `md` like the note editor, types `text` at the start of the paragraph with `needle` and saves. */
function editAndSave(md: string, needle: string, text: string): string {
  const { frontmatter, gap, body } = splitFrontmatter(md);
  const editor = open(body);
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === "paragraph" && node.textContent.includes(needle)) at = pos + 1;
    return at < 0;
  });
  expect(at, `no paragraph with ${needle}`).toBeGreaterThan(0);
  editor.commands.insertContentAt(at, text);
  const out = joinFrontmatter(frontmatter, gap, withShape(toMarkdown(editor), textShape(body)));
  editor.destroy();
  return out;
}

// R2A-1..R2A-5 (docs/quality/q124/r2-editor-export.md): an edit in a list rewrote the whole list
// from a document that had read it wrong, or wrote blocks inside items so that they left the item.
describe("an edited list keeps its blocks", () => {
  it("code under a numbered item keeps its indentation (it gained a space per save)", () => {
    const md = "1. Klonen:\n   ```sh\n   git clone x\n   cd x\n   ```\n2. Bauen\n";
    let out = md;
    for (let i = 0; i < 3; i++) out = editAndSave(out, "Bauen", "x");
    expect(out).toBe("1. Klonen:\n   ```sh\n   git clone x\n   cd x\n   ```\n2. xxxBauen\n");
  });
  it("bullets indented four spaces under a numbered item stay siblings", () => {
    expect(editAndSave("1. Süd\n    - Schulung\n    - Support\n", "Süd", "x")).toBe("1. xSüd\n    - Schulung\n    - Support\n");
    expect(editAndSave("3) Süd\n    - a\n    - b\n", "Süd", "x")).toBe("3) xSüd\n    - a\n    - b\n");
  });
  it("a quote, callout or table first in an item stays in the item", () => {
    expect(editAndSave("- > Zitat\n  > weiter\n- b\n", "b", "x")).toBe("- > Zitat\n  > weiter\n- xb\n");
    expect(editAndSave("- > [!note] T\n  > Text\n- b\n", "b", "x")).toBe("- > [!note] T\n  > Text\n- xb\n");
    expect(editAndSave("- | A | B |\n  | --- | --- |\n  | 1 | 2 |\n- b\n", "b", "x")).toBe("- | A | B |\n  | --- | --- |\n  | 1 | 2 |\n- xb\n");
  });
  it("a rule under an item's text does not underline it, a list under a quote does not continue it", () => {
    expect(editAndSave("- a\n\n  ---\n- b\n", "b", "x")).toBe("- a\n\n  ---\n- xb\n");
    expect(editAndSave("- > q\n\n  1. eins\n- b\n", "b", "x")).toBe("- > q\n\n  1. eins\n- xb\n");
  });
  it("a task's second line continues its text (it became a paragraph of its own)", () => {
    expect(editAndSave("- [ ] Zeile  \n  Umbruch\n- [ ] Ende\n", "Ende", "x")).toBe("- [ ] Zeile  \n  Umbruch\n- [ ] xEnde\n");
    expect(editAndSave("- [ ] eins\n  zwei\n  - [ ] sub\n", "sub", "x")).toBe("- [ ] eins\n  zwei\n  - [ ] xsub\n");
  });
  it("tabs in code inside a list stay tabs", () => {
    const md = "- Schritt\n\t```go\n\tfunc main() {\n\t\treturn\n\t}\n\t```\n- b\n";
    expect(editAndSave(md, "b", "x")).toBe(md.replace("- b", "- xb"));
    const make = "- ```make\n  all:\n  \trm -f app\n  ```\n- b\n";
    expect(editAndSave(make, "b", "x")).toBe(make.replace("- b", "- xb"));
  });
  it("blank lines in code inside a list stay", () => {
    const md = "- ```py\n  def f():\n      pass\n\n\n  def g():\n      pass\n  ```\n- b\n";
    expect(editAndSave(md, "b", "x")).toBe(md.replace("- b", "- xb"));
  });
  it("text after code in an item keeps its formatting (it was escaped, more on every save)", () => {
    expect(editAndSave("- ```sh\n  x\n  ```\n  **fett** [[Seite]]\n- b\n", "b", "x")).toBe("- ```sh\n  x\n  ```\n\n  **fett** [[Seite]]\n- xb\n");
  });
  it("indented code under a numbered item stays code", () => {
    expect(editAndSave("3. Tests:\n\n       npm test\n4. b\n", "b", "x")).toBe("3. Tests:\n   ```\n   npm test\n   ```\n4. xb\n");
  });
  it("a table in a quote gets no bare `>` lines", () => {
    let out = "> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n>\n> | C | D |\n> | --- | --- |\n> | 3 | 4 |\n>\n> Text\n";
    for (let i = 0; i < 2; i++) out = editAndSave(out, "Text", "x");
    expect(out).toBe("> | A | B |\n> | --- | --- |\n> | 1 | 2 |\n>\n> | C | D |\n> | --- | --- |\n> | 3 | 4 |\n>\n> xxText\n");
  });
});
