// What users type works in both languages: frontmatter keys, collection schema and view,
// generated-block markers, callouts, `due:` words, `/time`, and command names. What the app
// writes for new content follows the display language; existing notes keep their words.

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { buildExtensions, toMarkdown } from "./schema";
import { insertColumns, splitColumns } from "./blocks";
import { calloutLabel, slashItems } from "./extensions";
import { zeitCommand, zeitToken } from "./zeit-suggest";
import { inOtherLanguage, setLang, t } from "../lib/i18n";
import { canonicalKey, keyName, parseFrontmatter, propertyValue } from "../lib/frontmatter";
import { defaultView, parseSchema, parseView, setSchema, setView, type PropDef } from "../lib/collection";
import { findReviewBlock, upsertReviewBlock } from "../lib/dayreview";
import { calloutType } from "../lib/callouts";
import { captureKind } from "../lib/capture";

afterEach(() => setLang("de"));

const editorFor = (md: string) => new Editor({ element: document.createElement("div"), extensions: buildExtensions(), content: md, contentType: "markdown" });
const fm = (body: string) => `---\n${body}\n---\n`;

describe("frontmatter keys", () => {
  it("reads German and English keys alike; the first one wins", () => {
    expect(canonicalKey("Activity")).toBe("vorgang");
    expect(canonicalKey("vorgang")).toBe("vorgang");
    expect(canonicalKey("network")).toBe("netzplan");
    expect(canonicalKey("status")).toBe("status");
    expect(keyName("vorgang", "en")).toBe("activity");
    expect(keyName("vorgang", "de")).toBe("vorgang");
    expect(propertyValue(parseFrontmatter(fm("activity: NP-8801/1020")), "vorgang")).toBe("NP-8801/1020");
    expect(propertyValue(parseFrontmatter(fm("vorgang: NP-1/1\nactivity: NP-2/2")), "vorgang")).toBe("NP-1/1");
    expect(propertyValue(parseFrontmatter(fm("activity: NP-2/2\nvorgang: NP-1/1")), "vorgang")).toBe("NP-2/2");
  });
});

describe("collection schema and view", () => {
  const defs: PropDef[] = [
    { key: "status", kind: "select", options: [{ name: "Open", color: "grau" }, { name: "Done", color: "grün" }] },
    { key: "effort", kind: "number", options: [] },
  ];

  it("reads the English names", () => {
    const page = fm("properties:\n  status: {type: select, options: {Open: gray, Done: green}}\n  effort: number\nview:\n  type: table\n  sort: {field: title, dir: desc}\n  filter: [{field: status, op: is not, value: Done}]\n  columns: [title, status]");
    expect(parseSchema(page)).toEqual(defs);
    const v = parseView(page);
    expect(v.type).toBe("tabelle");
    expect(v.sort).toEqual({ field: "titel", dir: "ab" });
    expect(v.filters).toEqual([{ field: "status", op: "ist nicht", value: "Done" }]);
    expect(v.columns).toEqual(["titel", "status"]);
  });

  it("writes new content in the display language, existing entries in theirs", () => {
    setLang("en");
    const fresh = setView(setSchema("", defs), { ...defaultView(), type: "tabelle", sort: { field: "titel", dir: "ab" }, filters: [{ field: "status", op: "ist", value: "Open" }] });
    expect(fresh).toContain("properties:\n  status: {type: select, options: {Open: gray, Done: green}}\n  effort: number");
    expect(fresh).toContain("view:\n  type: table\n  sort: {field: title, dir: desc}\n  filter: [{field: status, op: is, value: Open}]");
    expect(parseSchema(fresh)).toEqual(defs);
    expect(parseView(fresh).filters).toEqual([{ field: "status", op: "ist", value: "Open" }]);
    // A German page stays German in English mode (no second key, no rewrite of its words).
    const german = fm("eigenschaften:\n  status: auswahl\nansicht: tabelle");
    const changed = setView(setSchema(german, defs), { ...defaultView(), type: "board" });
    expect(changed).toContain("eigenschaften:\n  status: {typ: auswahl, optionen: {Open: grau, Done: grün}}");
    expect(changed).toContain("ansicht: board");
    expect(changed).not.toMatch(/properties:|view:/);
    // And the other way round.
    setLang("de");
    const english = setView(setSchema(fm("properties:\n  a: text\nview: list"), defs), { ...defaultView(), type: "tabelle" });
    expect(english).toContain("properties:");
    expect(english).toContain("view: table");
    expect(english).not.toMatch(/eigenschaften|ansicht/);
  });
});

describe("markers of generated blocks", () => {
  it("finds the review block in either language and never writes it twice", () => {
    const de = "Text\n\n<!-- rückblick -->\nalt\n<!-- /rückblick -->\n";
    const en = "Text\n\n<!-- review -->\nold\n<!-- /review -->\n";
    expect(findReviewBlock(de)).not.toBeNull();
    expect(findReviewBlock(en)).not.toBeNull();
    const block = "<!-- review -->\nnew\n<!-- /review -->";
    expect(upsertReviewBlock(de, block)).toBe(`Text\n\n${block}\n`);
    expect(upsertReviewBlock(en, block)).toBe(`Text\n\n${block}\n`);
  });

  it("reads English column markers and keeps the markers a block was read with", () => {
    const en = "<!-- columns -->\n\nA\n\n<!-- column -->\n\nB\n\n<!-- /columns -->\n";
    expect(splitColumns(en)!.parts).toEqual(["A", "B"]);
    expect(splitColumns(en)!.lang).toBe("en");
    setLang("de");
    let editor = editorFor(en);
    expect(editor.state.doc.firstChild!.type.name).toBe("columns");
    expect(toMarkdown(editor)).toBe(en);
    editor.destroy();
    setLang("en");
    const de = "<!-- spalten -->\n\nA\n\n<!-- spalte -->\n\nB\n\n<!-- /spalten -->\n";
    editor = editorFor(de);
    expect(toMarkdown(editor)).toBe(de);
    editor.destroy();
    // New columns get the display language's markers.
    editor = editorFor("");
    insertColumns(editor, 2);
    expect(toMarkdown(editor)).toMatch(/^<!-- columns -->[\s\S]*<!-- column -->[\s\S]*<!-- \/columns -->\n$/);
    editor.destroy();
  });
});

describe("callouts", () => {
  it("German names style and label like their English type", () => {
    expect(calloutType("Warnung")).toBe("warning");
    expect(calloutType("tipp")).toBe("tip");
    expect(calloutType("note")).toBe("note");
    setLang("en");
    expect(calloutLabel("warnung")).toBe(t("callout.warning"));
    const editor = editorFor("> [!warnung] Achtung\n> Text\n");
    expect(editor.view.dom.querySelector(".callout-warning")).not.toBeNull();
    expect(toMarkdown(editor)).toBe("> [!warnung] Achtung\n> Text\n");
    editor.destroy();
  });
});

describe("due words and /time in the editor", () => {
  const typeAt = (editor: Editor, text: string) => {
    for (const ch of text) {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (f) => f(editor.view, from, to, ch, () => editor.state.tr.insertText(ch, from, to)));
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(ch, from, to));
    }
  };
  it("turns due:tomorrow and fällig:morgen into dates once a space follows", () => {
    const editor = editorFor("- [ ] Call Bob \n");
    editor.commands.setTextSelection(editor.state.doc.content.size - 2);
    typeAt(editor, "due:tomorrow ");
    expect(toMarkdown(editor)).toMatch(/^- \[ \] Call Bob due:\d{4}-\d{2}-\d{2}\s*$/);
    editor.destroy();
    const de = editorFor("- [ ] Angebot \n");
    de.commands.setTextSelection(de.state.doc.content.size - 2);
    typeAt(de, "fällig:morgen ");
    expect(toMarkdown(de)).toMatch(/^- \[ \] Angebot fällig:\d{4}-\d{2}-\d{2}\s*$/);
    // A word that is no date stays as typed.
    const other = editorFor("- [ ] x \n");
    other.commands.setTextSelection(other.state.doc.content.size - 2);
    typeAt(other, "due:someday ");
    expect(toMarkdown(other)).toMatch(/due:someday/);
    de.destroy();
    other.destroy();
  });

  it("offers /time in English and /zeit in German, and accepts both", () => {
    setLang("en");
    expect(zeitCommand()).toBe("/time");
    expect(slashItems({ onTemplate: null, onImage: null, onAi: null, onSummary: null, onDrawing: null, onFile: null }).find((i) => i.id === "zeit")!.hint).toBe("/time");
    setLang("de");
    expect(zeitCommand()).toBe("/zeit");
    expect(zeitToken("/time NP-88")).not.toBeNull();
    expect(zeitToken("/zeit NP-88")).not.toBeNull();
    expect(captureKind("/time 1h x")).toBe("zeit");
  });
});

describe("command names", () => {
  it("are found in the other language too", () => {
    setLang("de");
    const de = t("cmd.settings");
    setLang("en");
    expect(inOtherLanguage(t("cmd.settings"), "cmd.")).toBe(de);
    expect(inOtherLanguage(t("slash.todo"), "slash.")).not.toBe("");
  });
});
