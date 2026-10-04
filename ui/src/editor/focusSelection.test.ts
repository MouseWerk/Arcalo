import { Editor, type Extensions } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExtensions } from "./schema";
import { FOCUS_RESTORE_MS } from "./focusSelection";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TEXT = "Die Middleware verbindet das ERP über IDocs mit dem Auftragsportal.";

// WebKit reports a selection made right after a focus late when the main thread is busy:
// `selectionchange` arrives after ProseMirror's restore timer. The test DOM reports it at once,
// so here every `selectionchange` is held back and delivered later, as WebKit does then.
let held = 0;
const holdBack = (e: Event) => {
  if ((e as Event & { late?: boolean }).late) return;
  e.stopImmediatePropagation();
  held++;
  setTimeout(() => document.dispatchEvent(Object.assign(new Event("selectionchange"), { late: true })), FOCUS_RESTORE_MS * 3);
};
beforeEach(() => {
  held = 0;
  window.addEventListener("selectionchange", holdBack, true);
});
afterEach(() => {
  window.removeEventListener("selectionchange", holdBack, true);
  document.body.innerHTML = "";
});

/** Focuses a fresh editor and selects the paragraph through the DOM (a mouse drag, a script) at once. */
async function selectRightAfterFocus(extensions: Extensions) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = new Editor({ element: host, extensions, content: `# Architektur\n\n${TEXT}\n`, contentType: "markdown" });
  const dom = editor.view.dom as HTMLElement;
  // The note has rendered (its DOM mutations are delivered) before the click into it.
  await sleep(10);
  dom.focus();
  const range = document.createRange();
  range.selectNodeContents(dom.querySelector("p")!);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await sleep(FOCUS_RESTORE_MS * 5);
  const { from, to } = editor.state.selection;
  const result = { dom: String(window.getSelection()), state: editor.state.doc.textBetween(from, to) };
  editor.destroy();
  return result;
}

describe("a selection right after the editor gets the focus", () => {
  it("is kept although the browser reports it after ProseMirror's restore", async () => {
    const r = await selectRightAfterFocus(buildExtensions());
    expect(held).toBeGreaterThan(0);
    expect(r.dom).toBe(TEXT);
    expect(r.state).toBe(TEXT);
  });

  it("is lost without the extension (the case it exists for)", async () => {
    const r = await selectRightAfterFocus(buildExtensions().filter((e) => e.name !== "focusSelection"));
    expect(r.state).toBe("");
    expect(r.dom).toBe("");
  });
});
