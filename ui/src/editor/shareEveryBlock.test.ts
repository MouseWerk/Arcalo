// q124 round 2, H5: every block type shared as HTML shows as that block, nothing of its Markdown
// syntax leaks into the text, and text in other scripts (RTL, combining marks, CJK) and tabs in
// code arrive unchanged.

import { describe, expect, it } from "vitest";
import { renderPageHtml, type AttachmentSource } from "./shareHtml";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const files: AttachmentSource = {
  read: async (n) => (n === "bild.png" ? PNG : n === "Plan.excalidraw.svg" ? new TextEncoder().encode("<svg/>") : null),
  size: async (n) => (n === "bild.png" ? PNG.length : null),
};

const PAGE = [
  "# Titel",
  "",
  "[TOC]",
  "",
  "## Text",
  "",
  "**fett** *kursiv* ~~durch~~ ==markiert== `code` [[Seite]] #tag/unter [Web](https://example.com) Fußnote[^1]",
  "",
  "שלום עולם · مرحبا · é · 中文 日本語 한국어",
  "",
  "## Listen",
  "",
  "- eins",
  "  - zwei",
  "1. Klonen:",
  "   ```sh",
  "   git clone x",
  "   ```",
  "2. Bauen",
  "    - Unterpunkt",
  "    - noch einer",
  "",
  "- [ ] offen due:2026-10-01",
  "- [x] erledigt",
  "",
  "## Blöcke",
  "",
  "> Zitat",
  "",
  "> [!warning] Achtung",
  "> Inhalt",
  "",
  "> [!faq]- Frage",
  "> Antwort",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | **2** |",
  "",
  "```go",
  "func main() {",
  "\tif x {",
  "\t\treturn",
  "\t}",
  "}",
  "```",
  "",
  "<!-- spalten -->",
  "",
  "Links",
  "",
  "<!-- spalte -->",
  "",
  "Rechts",
  "",
  "<!-- /spalten -->",
  "",
  "---",
  "",
  "![[bild.png]] ![[Plan.excalidraw]]",
  "",
  'Gebucht: <time-entry id="7" hours="1,5" target="NP-1/10">Arbeit</time-entry>',
  "",
  "[^1]: Die Fußnote.",
  "",
].join("\n");

async function shared() {
  const html = await renderPageHtml(PAGE, { id: "p", files, anchors: new Map() });
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return { html, doc };
}

/** The visible text outside code. */
function prose(doc: Document): string {
  const copy = doc.body.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("pre, code").forEach((n) => n.remove());
  return copy.textContent ?? "";
}

describe("share as HTML: every block", () => {
  it("shows each block as itself", async () => {
    const { doc } = await shared();
    const has = (sel: string) => expect(doc.querySelector(sel), sel).not.toBeNull();
    for (const sel of ["h1", "h2", "strong", "em", "s, del", "mark", "a[href='https://example.com']", "ul ul", "ol pre", "ol ul", "blockquote", "details", "table td strong", "hr", "img"]) has(sel);
    expect(doc.querySelectorAll("input[type=checkbox]").length).toBe(2);
    expect(doc.querySelector("input[type=checkbox][checked]")).not.toBeNull();
    // The second bullet under „Bauen“ is its sibling, not its child.
    const sub = [...doc.querySelectorAll("ol > li")].find((li) => li.textContent?.includes("Bauen"));
    expect(sub?.querySelectorAll(":scope > ul > li").length).toBe(2);
  });

  it("leaks no Markdown syntax into the text", async () => {
    const { doc } = await shared();
    const text = prose(doc);
    for (const raw of ["**", "~~", "==", "[[", "]]", "[TOC]", "[^1]", "<!--", "> [!", "- [ ]", "<time-entry", "![["]) expect(text, raw).not.toContain(raw);
  });

  it("keeps other scripts and tabs in code", async () => {
    const { doc } = await shared();
    expect(prose(doc)).toContain("שלום עולם · مرحبا · é · 中文 日本語 한국어");
    const code = [...doc.querySelectorAll("pre")].map((p) => p.textContent ?? "");
    expect(code).toContain("git clone x");
    expect(code.some((c) => c.includes("\tif x {\n\t\treturn"))).toBe(true);
  });
});
