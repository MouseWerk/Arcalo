// Code highlighting: rarer languages are loaded when a code block asks for them.

import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { ensureLanguages, highlightCodeBlocks, lazyGrammar, loadLanguage, lowlight } from "./languages";
import { renderMarkdown } from "../lib/markdown";
import { buildExtensions } from "./schema";

describe("languages", () => {
  it("builds in the everyday languages", () => {
    for (const l of ["ts", "js", "json", "python", "bash", "yaml", "md", "html", "css", "sql", "java"]) expect(lowlight.registered(l), l).toBe(true);
    expect(lazyGrammar("ts")).toBeNull();
    expect(lazyGrammar("gibtsnicht")).toBeNull();
    expect(lazyGrammar(null)).toBeNull();
  });

  it("knows the others by name and alias", () => {
    expect(lazyGrammar("rust")).toBe("rust");
    expect(lazyGrammar("RS")).toBe("rust");
    expect(lazyGrammar("c++")).toBe("cpp");
    expect(lazyGrammar("golang")).toBe("go");
  });

  it("loads and registers a grammar once", async () => {
    expect(lowlight.registered("kotlin")).toBe(false);
    const a = loadLanguage("kt");
    const b = loadLanguage("kotlin");
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(lowlight.registered("kotlin")).toBe(true);
    expect(lazyGrammar("kotlin")).toBeNull();
    expect(await loadLanguage("kotlin")).toBe(false);
    await ensureLanguages(["go", "go", "ts"]);
    expect(lowlight.registered("golang")).toBe(true);
  });

  it("highlights a code block of a lazy language once loaded, without an update", async () => {
    let updates = 0;
    const editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: "```swift\nlet x = 1\n```\n\nText", contentType: "markdown", onUpdate: () => updates++ });
    for (let i = 0; i < 50 && !lowlight.registered("swift"); i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    expect(lowlight.registered("swift")).toBe(true);
    expect(editor.view.dom.querySelector("pre .hljs-keyword")?.textContent).toBe("let");
    expect(updates).toBe(0);
    expect(editor.can().undo()).toBe(false);
    editor.destroy();
  });

  it("highlights rendered Markdown like the editor (slides), loading grammars on demand", async () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("# Folie\n\n```ts\nconst x: number = 1; // Kommentar\n```\n\n```rust\nfn main() {}\n```\n\n```\nplain\n```\n\n```gibtsnicht\nx\n```\n");
    expect(await highlightCodeBlocks(root)).toBe(2);
    const [ts, rust, plain, unknown] = [...root.querySelectorAll("pre > code")];
    expect(ts.classList.contains("hljs")).toBe(true);
    expect(ts.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(ts.querySelector(".hljs-comment")?.textContent).toBe("// Kommentar");
    expect(ts.textContent).toBe("const x: number = 1; // Kommentar\n");
    expect(rust.querySelector(".hljs-keyword")?.textContent).toBe("fn");
    expect(plain.querySelector("span")).toBeNull();
    expect(unknown.querySelector("span")).toBeNull();
    // Twice is harmless.
    expect(await highlightCodeBlocks(root)).toBe(0);
  });
});
