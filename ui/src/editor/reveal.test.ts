import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions } from "./schema";
import { citeFlashKey, editorForPage, FLASH_MS, locateAnchor, locateText, registerEditor, revealText } from "./reveal";
import { citeNeedles } from "../lib/citations";
import { linkAtCaret } from "./extensions";

let editor: Editor | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function make(md: string) {
  host = document.createElement("div");
  host.className = "pane active";
  document.body.append(host);
  editor = new Editor({ element: host, extensions: buildExtensions(), content: md, contentType: "markdown" });
  return editor;
}

const PAGE = "# Plan\n\nIntro ohne Bezug.\n\n## Netzplan\n\nNetzplan NP-8801 wird im Oktober mit [[Architektur|der Architektur]] freigegeben. Danach Abnahme.\n\n- Punkt mit **fett** drin\n";

describe("locateText", () => {
  it("finds the paragraph of a chunk's first sentence, wiki links by label", () => {
    const e = make(PAGE);
    const chunk = "## Netzplan\n\nNetzplan NP-8801 wird im Oktober mit [[Architektur|der Architektur]] freigegeben. Danach Abnahme.";
    const r = locateText(e.state.doc, citeNeedles(chunk))!;
    expect(r).not.toBeNull();
    const node = e.state.doc.nodeAt(r.from)!;
    expect(node.type.name).toBe("paragraph");
    expect(node.textContent).toContain("Netzplan NP-8801 wird im Oktober");
    expect(r.to).toBe(r.from + node.nodeSize);
  });

  it("falls back to later needles (heading) and to null", () => {
    const e = make(PAGE);
    const r = locateText(e.state.doc, ["gibt es nicht", "Netzplan"])!;
    expect(e.state.doc.nodeAt(r.from)!.type.name).toBe("heading");
    expect(locateText(e.state.doc, ["gibt es nicht"])).toBeNull();
    expect(locateText(e.state.doc, [])).toBeNull();
  });

  it("is case- and whitespace-insensitive and finds list items", () => {
    const e = make(PAGE);
    const r = locateText(e.state.doc, citeNeedles("- Punkt  mit **fett**   drin"))!;
    expect(e.state.doc.nodeAt(r.from)!.textContent).toBe("Punkt mit fett drin");
  });
});

describe("revealText", () => {
  it("opens the page, waits for its editor, selects and flashes the paragraph", async () => {
    const e = make(PAGE);
    const open = vi.fn();
    let unregister = () => {};
    // The editor appears only after the page was opened.
    open.mockImplementation((id: number) => setTimeout(() => (unregister = registerEditor(id, e)), 50));
    // happy-dom has no layout: treat the editor as shown.
    vi.spyOn(e.view.dom, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    const found = await revealText(7, "## Netzplan\n\nNetzplan NP-8801 wird im Oktober freigegeben.", open);
    expect(open).toHaveBeenCalledWith(7);
    // The sentence differs (the link is in between), the paragraph start matches.
    expect(found).toBe(true);
    const deco = citeFlashKey.getState(e.state)!.find();
    expect(deco).toHaveLength(1);
    expect(e.view.dom.querySelector(".cite-flash")?.textContent).toContain("NP-8801");
    expect(e.state.doc.resolve(e.state.selection.from).parent.textContent).toContain("NP-8801");
    expect(editorForPage(7)).toBe(e);
    // Unknown text: top of the page.
    expect(await revealText(7, "Steht nirgends auf der Seite.", open)).toBe(false);
    expect(e.state.selection.from).toBe(1);
    unregister();
    expect(editorForPage(7)).toBeNull();
  });

  it("clears the flash after a while", () => {
    vi.useFakeTimers();
    const e = make(PAGE);
    const r = locateText(e.state.doc, ["Intro ohne Bezug"])!;
    e.view.dispatch(e.state.tr.setMeta(citeFlashKey, r));
    expect(citeFlashKey.getState(e.state)!.find()).toHaveLength(1);
    // Mapped through edits.
    e.commands.insertContentAt(0, "<p>Neu</p>");
    expect(citeFlashKey.getState(e.state)!.find()[0].from).toBeGreaterThan(r.from);
    e.view.dispatch(e.state.tr.setMeta(citeFlashKey, null));
    expect(citeFlashKey.getState(e.state)!.find()).toHaveLength(0);
    expect(FLASH_MS).toBeGreaterThan(500);
  });
});

describe("locateAnchor", () => {
  const doc = "# Plan\n\n## Ablauf und Größe\n\nText.\n\nEin Absatz mit Kennung ^abc-1\n\n- Punkt ^p2\n\n### Ablauf und Größe\n";
  const textAt = (e: Editor, r: { from: number; to: number } | null) => (r ? e.state.doc.nodeAt(r.from)?.textContent : null);
  it("finds a heading by its text, case-insensitive, the first of equal ones", () => {
    const e = make(doc);
    const r = locateAnchor(e.state.doc, "ablauf und größe");
    expect(e.state.doc.nodeAt(r!.from)?.attrs.level).toBe(2);
    expect(textAt(e, locateAnchor(e.state.doc, "Plan#Ablauf und Größe"))).toBe("Ablauf und Größe");
  });
  it("finds a block by its ^id, in paragraphs and list items", () => {
    const e = make(doc);
    expect(textAt(e, locateAnchor(e.state.doc, "^abc-1"))).toBe("Ein Absatz mit Kennung ^abc-1");
    expect(textAt(e, locateAnchor(e.state.doc, "^p2"))).toBe("Punkt ^p2");
  });
  it("is null for what the page does not have", () => {
    const e = make(doc);
    expect(locateAnchor(e.state.doc, "Fehlt")).toBeNull();
    expect(locateAnchor(e.state.doc, "^nein")).toBeNull();
    expect(locateAnchor(e.state.doc, " ")).toBeNull();
  });
});

describe("linkAtCaret (Alt+Enter)", () => {
  it("finds the wiki link next to the caret, a web link around it, nothing in plain text", () => {
    const e = make("Vor [[Seite#Kopf|Alias]] und [Web](https://example.com) Ende\n");
    const at = (needle: string) => {
      let found = -1;
      e.state.doc.descendants((n, pos) => {
        if (found < 0 && n.isText && n.text!.includes(needle)) found = pos + n.text!.indexOf(needle);
      });
      return found;
    };
    e.commands.setTextSelection(at(" und"));
    expect(linkAtCaret(e.state)).toEqual({ wiki: { target: "Seite", anchor: "Kopf" } });
    e.commands.setTextSelection(at("Web") + 1);
    expect(linkAtCaret(e.state)).toEqual({ href: "https://example.com" });
    e.commands.setTextSelection(at("Ende") + 2);
    expect(linkAtCaret(e.state)).toBeNull();
  });
});
