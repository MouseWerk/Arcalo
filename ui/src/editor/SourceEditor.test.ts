import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SourceEditor, continuation, mapCaret, sourceOutline } from "./SourceEditor";
import { api } from "../lib/api";
import type { PageDoc } from "../lib/types";
import { saveDelay } from "./saves";
import { useApp } from "../store/app";
import type { SettingsView } from "../lib/types";

vi.mock("../lib/api", async (orig) => {
  const m = await orig<typeof import("../lib/api")>();
  return { ...m, api: { ...m.api, savePage: vi.fn(async () => ({})), chipStates: vi.fn(async () => []) } };
});

describe("continuation", () => {
  it("continues bullets, numbers and tasks with the same indent", () => {
    expect(continuation("- Apfel")).toEqual({ prefix: "- ", empty: false });
    expect(continuation("  * Birne")).toEqual({ prefix: "  * ", empty: false });
    expect(continuation("9. Neun")).toEqual({ prefix: "10. ", empty: false });
    expect(continuation("- [x] erledigt")).toEqual({ prefix: "- [ ] ", empty: false });
  });
  it("marks an empty item (Enter there ends the list) and ignores other lines", () => {
    expect(continuation("- ")).toEqual({ prefix: "- ", empty: true });
    expect(continuation("- [ ] ")).toEqual({ prefix: "- [ ] ", empty: true });
    expect(continuation("Text")).toBeNull();
    expect(continuation("-kein Punkt")).toBeNull();
  });
});

describe("mapCaret (text from another pane)", () => {
  it("keeps the caret on its text when text is added before or after it", () => {
    expect(mapCaret("eins\nzwei", "neu\neins\nzwei", 7)).toBe(11);
    expect(mapCaret("eins\nzwei", "eins\nzwei\ndrei", 3)).toBe(3);
    expect(mapCaret("eins\nzwei", "eins\nzwei", 6)).toBe(6);
  });
  it("puts a caret inside the changed part behind the new text", () => {
    expect(mapCaret("a XX b", "a YYYY b", 3)).toBe(6);
  });
});

describe("sourceOutline", () => {
  it("lists the headings of the source with their offset, not those in code or the properties", () => {
    const text = "---\ntitle: # nein\n---\n# Gamma\nText\n```\n# kein Titel\n```\n## Delta ##\n";
    expect(sourceOutline(text)).toEqual([
      { level: 1, text: "Gamma", pos: text.indexOf("# Gamma") },
      { level: 2, text: "Delta", pos: text.indexOf("## Delta") },
    ]);
    expect(sourceOutline("#Kein Titel\nText")).toEqual([]);
  });
});

describe("saveDelay", () => {
  it("is the autosave delay of Settings → Editor (both editors use it), within 250–3000 ms", () => {
    const view = (autosave_ms: number) => ({ settings: { editor: { autosave_ms } } }) as unknown as SettingsView;
    useApp.setState({ settings: view(1200) });
    expect(saveDelay()).toBe(1200);
    useApp.setState({ settings: view(10) });
    expect(saveDelay()).toBe(250);
    useApp.setState({ settings: null });
    expect(saveDelay()).toBe(450);
  });
});

describe("the source text box", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not write the whole text into the box again per key (React does not hold it)", async () => {
    const text = `# Lang\n\n${"Ein Absatz mit etwas Text.\n\n".repeat(2000)}- Punkt`;
    const doc = { id: 7, title: "Lang", content: text } as PageDoc;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(SourceEditor, { doc, onSaved: () => {} })));
    const el = host.querySelector("textarea")!;
    expect(el.value).toBe(text);
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "defaultValue")!;
    let writes = 0;
    vi.spyOn(HTMLTextAreaElement.prototype, "defaultValue", "set").mockImplementation(function (this: HTMLTextAreaElement, v: string) {
      if (v) writes++;
      proto.set!.call(this, v);
    });
    // Typed as the browser does: past React's own record of the value, so React sees a change.
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
    for (const ch of "neu") {
      native.set!.call(el, `${el.value}${ch}`);
      await act(async () => void el.dispatchEvent(new Event("input", { bubbles: true })));
    }
    expect(el.value).toBe(`${text}neu`);
    // Enter in a list continues it: written into the box by the editor.
    el.setSelectionRange(el.value.length, el.value.length);
    await act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(el.value).toBe(`${text}neu\n- `);
    expect(writes).toBe(0);
    await act(async () => root.unmount());
    // Unmounting saved the edits.
    expect(vi.mocked(api.savePage)).toHaveBeenLastCalledWith(7, `${text}neu\n- `);
    host.remove();
  });
});
