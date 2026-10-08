// Assistant answers never widen the chat: code blocks and tables get their own scroll box,
// everything else wraps. happy-dom has no layout, so the DOM structure and the computed styles
// from the real stylesheet are checked here; e2e 98 measures the widths in the app.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chatHtml, openFence, renderChatMarkdown, renderChatMarkdownCached, renderMarkdown } from "./markdown";
import { linkCitations } from "./citations";

const URL_LONG = `https://example.com/${"pfad/".repeat(60)}datei.pdf?x=${"1".repeat(40)}`;
const WORD = "W".repeat(300);
const CODE = "```bash\n" + `echo ${"sehr-lange-zeile-".repeat(30)}\n` + "```";
const TABLE = `| ${Array.from({ length: 12 }, (_, i) => `Spalte ${i + 1}`).join(" | ")} |\n|${" --- |".repeat(12)}\n| ${Array.from({ length: 12 }, (_, i) => `Wert ${i + 1}`).join(" | ")} |`;
const ANSWER = `Hier: ${URL_LONG}\n\n${WORD}\n\nPfad \`C:\\Users\\${"ordner\\".repeat(30)}datei.txt\`\n\n${CODE}\n\n${TABLE}\n\n![Bild](https://example.com/bild.png)`;

describe("chat Markdown", () => {
  it("puts every code block into a box with its language and a copy button", () => {
    // (happy-dom's parser drops a block element at the very start of DOMPurify's input; WebKit does not.)
    const html = renderChatMarkdown("Code:\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```");
    const root = document.createElement("div");
    root.innerHTML = html;
    const boxes = root.querySelectorAll(".code-box");
    expect(boxes.length).toBe(2);
    expect(root.querySelectorAll("pre").length).toBe(2);
    for (const pre of root.querySelectorAll("pre")) expect(pre.parentElement?.classList.contains("code-box")).toBe(true);
    expect(boxes[0].querySelector(".code-lang")?.textContent).toBe("ts");
    expect(boxes[0].querySelector("code")?.className).toBe("language-ts hljs");
    expect(boxes[1].querySelector(".code-lang")).toBeNull();
    const copy = boxes[0].querySelector<HTMLButtonElement>("[data-code-copy]");
    expect(copy?.getAttribute("aria-label")).toBe("Code kopieren");
    expect(copy?.type).toBe("button");
    // The plain renderer (previews, slides) stays as it was.
    expect(renderMarkdown("```ts\nx\n```")).not.toContain("code-box");
  });

  it("wraps tables in a scroll container and keeps citations out of code", () => {
    const root = document.createElement("div");
    root.innerHTML = linkCitations(renderChatMarkdown(`Tabelle:\n\n${TABLE}\n\nText [1]\n\n\`\`\`\nx [1]\n\`\`\``), 1);
    const table = root.querySelector("table")!;
    expect(table.parentElement?.classList.contains("table-scroll")).toBe(true);
    expect(table.querySelectorAll("th").length).toBe(12);
    expect(root.querySelectorAll("sup.cite").length).toBe(1);
  });

  it("escapes what it does not own: a language class cannot inject markup", () => {
    const html = chatHtml('<pre><code class="language-x&quot;onclick=&quot;alert(1)">y</code></pre>');
    expect(html).not.toContain("onclick=\"alert");
    const evil = renderChatMarkdown('```"><img src=x onerror=alert(1)>\nx\n```');
    expect(evil).not.toMatch(/onerror=/);
  });

  const dom = (md: string) => {
    const root = document.createElement("div");
    // A paragraph first: happy-dom drops a block element at the very start (see above).
    root.innerHTML = renderChatMarkdown(`Antwort:\n\n${md}`);
    return root;
  };

  it("renders GitHub-flavored Markdown: headings, nested lists, task lists, quotes, rules, strikethrough", () => {
    const root = dom("## Plan\n\n1. Erst\n   - eins\n   - zwei\n2. Dann\n\n- [x] erledigt\n- [ ] offen\n\n> Zitat\n\n---\n\n~~alt~~ neu");
    expect(root.querySelector("h2")?.textContent).toBe("Plan");
    expect(root.querySelector("ol > li > ul > li")?.textContent).toBe("eins");
    const boxes = root.querySelectorAll<HTMLInputElement>("li input[type=checkbox]");
    expect([...boxes].map((b) => b.checked)).toEqual([true, false]);
    expect([...boxes].every((b) => b.disabled)).toBe(true);
    expect(root.querySelector("blockquote")?.textContent?.trim()).toBe("Zitat");
    expect(root.querySelector("hr")).not.toBeNull();
    expect(root.querySelector("del")?.textContent).toBe("alt");
  });

  it("tables keep their alignment and scroll in their box", () => {
    const root = dom("| Name | Stunden |\n| :-- | --: |\n| Atlas | 12,5 |");
    const table = root.querySelector(".table-scroll > table")!;
    expect(table.querySelectorAll("thead th").length).toBe(2);
    expect(table.querySelector("tbody td:last-child")?.getAttribute("style")).toBe("text-align:right");
  });

  it("highlights code with the editor's grammars and names the language", () => {
    const root = dom("```typescript\nconst n: number = 1;\n```\n\n```sql\nSELECT name FROM pages WHERE id = 1;\n```\n\n```nichtda\nx\n```");
    const [ts, sql, unknown] = [...root.querySelectorAll(".code-box")];
    expect(ts.querySelector(".code-lang")?.textContent).toBe("typescript");
    expect(ts.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(sql.querySelector(".code-lang")?.textContent).toBe("sql");
    expect(sql.querySelector(".hljs-keyword")?.textContent).toBe("SELECT");
    expect(sql.querySelector("code")?.textContent).toBe("SELECT name FROM pages WHERE id = 1;\n");
    // An unknown language stays plain, still with its name and the copy button.
    expect(unknown.querySelector(".hljs-keyword")).toBeNull();
    expect(unknown.querySelector(".code-copy-text")?.textContent).toBe("Kopieren");
  });

  it("an unclosed fence while streaming is already a code box, and stays one when closed", () => {
    const partial = "Hier:\n\n```ts\nconst a = 1;\nconst b";
    expect(openFence(partial)).toBe(true);
    expect(openFence(`${partial}\n\`\`\``)).toBe(false);
    expect(openFence("```\na\n```\n\n~~~py\nx")).toBe(true);
    expect(openFence("Kein Code")).toBe(false);
    const streaming = dom(partial);
    const done = dom(`${partial} = 2;\n\`\`\`\n\nFertig.`);
    expect(streaming.querySelectorAll(".code-box").length).toBe(1);
    expect(done.querySelectorAll(".code-box").length).toBe(1);
    expect(streaming.querySelector("code")?.textContent).toContain("const b");
  });

  it("never runs what the model writes: raw HTML is text, scripts and handlers go", () => {
    const root = dom('<script>alert(1)</script>\n\n<img src="x" onerror="alert(2)">\n\nText <b onclick="x()">fett</b> [klick](javascript:alert(3)) [ok](https://example.com "Beispiel")');
    expect(root.querySelector("script, img, b")).toBeNull();
    // What is left of them is text: no element carries a handler or a script address.
    for (const el of root.querySelectorAll("*")) for (const a of el.attributes) expect(a.name.startsWith("on") || /javascript:/i.test(a.value)).toBe(false);
    expect(root.textContent).toContain("<script>alert(1)</script>");
    const links = root.querySelectorAll("a");
    expect(links.length).toBe(1);
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[0].getAttribute("title")).toBe("Beispiel");
    expect(links[0].hasAttribute("data-external")).toBe(true);
    // Without a title the address shows on hover.
    expect(dom("<https://arcalo.mousewerk.de>").querySelector("a")?.getAttribute("title")).toBe("https://arcalo.mousewerk.de");
  });

  it("marks ```mermaid blocks for a diagram with a switch to the source; [[pages]] link", () => {
    const root = dom("```mermaid\ngraph TD\n  A --> B\n```\n\nSiehe [[Architektur|die Architektur]].");
    const box = root.querySelector("[data-mermaid]")!;
    expect(box.querySelector("code")?.textContent).toContain("A --> B");
    expect(box.querySelector("[data-mermaid-toggle]")).not.toBeNull();
    expect(box.querySelector(".mermaid-view")).not.toBeNull();
    const link = root.querySelector("a[data-wikilink]")!;
    expect(link.getAttribute("data-target")).toBe("Architektur");
    expect(link.textContent).toBe("die Architektur");
    expect(dom("```ts\nx\n```").querySelector("[data-mermaid]")).toBeNull();
  });

  it("caches finished answers", () => {
    const a = renderChatMarkdownCached(ANSWER);
    expect(renderChatMarkdownCached(ANSWER)).toBe(a);
    expect(a).toBe(renderChatMarkdown(ANSWER));
  });
});

describe("chat layout styles", () => {
  const style = document.createElement("style");
  beforeAll(() => {
    // Only the rules of the chat: happy-dom's parser need not understand the whole app.
    const css = ["editor.css", "app.css"].map((f) => readFileSync(resolve(__dirname, "../styles", f), "utf8")).join("\n");
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(^|\n)([^{}@\n][^{}]*)\{([^{}]*)\}/g)]
      .filter((m) => /prose-chat|\.prose |\.prose\s*(pre|code|img|table)|msg-|assistant|chat-|composer|tool-/.test(m[2]))
      .map((m) => `${m[2].trim()} { ${m[3]} }`);
    style.textContent = rules.join("\n");
    document.head.append(style);
  });
  afterAll(() => style.remove());

  it("breaks long words, links and paths, scrolls code and tables inside, fits images", () => {
    const panel = document.createElement("div");
    panel.className = "assistant";
    panel.style.width = "320px";
    panel.innerHTML = `<div class="assistant-scroll"><div class="assistant-content"><div class="chat-log"><div class="msg-user-wrap"><div class="msg-user">${WORD}</div></div><div class="msg-ai"><div class="prose prose-chat">${renderChatMarkdown(ANSWER)}</div></div></div></div></div>`;
    document.body.append(panel);
    const cs = (sel: string) => getComputedStyle(panel.querySelector(sel)!);
    expect(cs(".prose-chat").overflowWrap).toBe("anywhere");
    expect(cs(".prose-chat p").overflowWrap).toBe("anywhere");
    expect(cs(".prose-chat a").overflowWrap).toBe("anywhere");
    expect(cs(".prose-chat p > code").whiteSpace).toBe("pre-wrap");
    expect(cs(".prose-chat p > code").overflowWrap).toBe("anywhere");
    expect(cs(".msg-user").overflowWrap).toBe("anywhere");
    expect(cs(".prose-chat .code-box pre").overflowX).toBe("auto");
    expect(cs(".prose-chat .code-box").maxWidth).toBe("100%");
    expect(cs(".prose-chat .table-scroll").overflowX).toBe("auto");
    expect(cs(".prose-chat .table-scroll").maxWidth).toBe("100%");
    expect(cs(".prose-chat img").maxWidth).toBe("100%");
    // Grid and flex children may shrink below their content (else a wide child widens the column).
    expect(cs(".msg-ai").gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(cs(".prose-chat").minWidth).toBe("0");
    expect(cs(".chat-log").minWidth).toBe("0");
    expect(cs(".assistant-scroll").overflowX).toBe("hidden");
    // Every wide element sits in a box that scrolls.
    for (const pre of panel.querySelectorAll("pre")) expect(pre.closest(".code-box")).not.toBeNull();
    for (const table of panel.querySelectorAll("table")) expect(table.closest(".table-scroll")).not.toBeNull();
    panel.remove();
  });
});
