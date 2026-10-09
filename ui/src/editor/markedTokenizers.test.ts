import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, markedTokenizerCount } from "./schema";

// Each editor used to register its tokenizers on the shared `marked` again, bound to its own Markdown manager:
// closed editors stayed reachable (memory after many tabs) and every inline position ran one more copy of
// each tokenizer per note opened.
describe("markdown tokenizers", () => {
  const open = () => {
    const ed = new Editor({ extensions: buildExtensions({}), content: "# Titel\n\nText mit [[Link]] und ![[Seite]].\n\n- [ ] Aufgabe\n", contentType: "markdown" });
    const md = ed.getMarkdown();
    ed.destroy();
    return md;
  };

  it("are registered once, however many editors open", () => {
    const first = open();
    const count = markedTokenizerCount();
    expect(count).toBeGreaterThan(5);
    for (let i = 0; i < 5; i++) expect(open()).toBe(first);
    expect(markedTokenizerCount()).toBe(count);
  });

  it("still parse the editor's syntax", () => {
    const ed = new Editor({ extensions: buildExtensions({}), content: "Siehe [[Ziel]] und ![[Seite]]\n", contentType: "markdown" });
    const types: string[] = [];
    ed.state.doc.descendants((n) => void types.push(n.type.name));
    expect(types).toContain("wikiLink");
    expect(types).toContain("pageEmbed");
    expect(ed.getMarkdown().trim()).toBe("Siehe [[Ziel]] und ![[Seite]]");
    ed.destroy();
  });
});
