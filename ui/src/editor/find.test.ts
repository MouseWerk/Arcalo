// Find & Replace: matches ignore case and land on the text that matched, also next to characters
// whose lowercase form is longer or shorter (İ, the Kelvin sign).

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { findKey } from "./find";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

function open(md: string) {
  editor = new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
  return editor;
}

const hits = (e: Editor) => (findKey.getState(e.state)?.matches ?? []).map((m) => e.state.doc.textBetween(m.from, m.to));

describe("find in page", () => {
  it("replaces every match after a dotted capital I", () => {
    const e = open("İstanbul Team und Team\n");
    e.commands.setFindQuery("team");
    expect(hits(e)).toEqual(["Team", "Team"]);
    e.commands.replaceAll("Gruppe");
    expect(toMarkdown(e)).toBe("İstanbul Gruppe und Gruppe\n");
  });

  it("replaces the current match after a dotted capital I", () => {
    const e = open("İİ Team\n");
    e.commands.setFindQuery("TEAM");
    e.commands.replaceCurrent("Gruppe");
    expect(toMarkdown(e)).toBe("İİ Gruppe\n");
  });

  it("matches across case and leaves regex characters literal", () => {
    const e = open("Kosten (netto) und KOSTEN (Netto) a.b axb\n");
    e.commands.setFindQuery("kosten (netto)");
    expect(hits(e)).toEqual(["Kosten (netto)", "KOSTEN (Netto)"]);
    e.commands.setFindQuery("a.b");
    expect(hits(e)).toEqual(["a.b"]);
  });

  it("a Kelvin sign matches k without shifting the next match", () => {
    const e = open("Kelvin kelvin\n");
    e.commands.setFindQuery("kelvin");
    expect(hits(e)).toEqual(["Kelvin", "kelvin"]);
  });
});
