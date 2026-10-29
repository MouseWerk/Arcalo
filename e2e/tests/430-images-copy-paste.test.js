// Images copied and pasted with the real keys (the system clipboard, not synthetic events): a
// selected image pasted into another note, a table cell and the capture window embeds the same
// stored file with its size; cut moves it; a text selection takes its images along; other
// programs get the image itself (PNG) and HTML with the image's bytes; „Bild kopieren“ in the
// menu copies the same way; the pasted image keeps working after the first note is gone.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { helpers } from "../lib/linking-flows.js";
import { openCapture } from "../lib/capture.js";

const test = guarded(nodeTest, () => app);
let app;
let h;
before(async () => {
  app = await launch();
  h = helpers(app);
});
after(async () => app?.close());

// 2×2 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4YWMDRAwQCgAlPgUBdJmUYAAAAABJRU5ErkJggg==";
const ED = ".pane.active > .pane-content:not([hidden]) .ProseMirror";
let image;
let a;
let b;

const attachments = () => fs.readdirSync(path.join(app.dataDir, "attachments")).sort();
const loaded = (sel) =>
  app.browser.waitUntil(() => app.browser.execute((s) => [...document.querySelectorAll(s)].every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll(s).length > 0, sel), {
    timeoutMsg: `${sel} did not load`,
  });

/** Clicks the image: it is selected as a whole (ProseMirror's node selection). */
async function selectImage() {
  await (await app.$(`${ED} img.embed-image`)).click();
  await app.browser.waitUntil(() => app.browser.execute((s) => document.querySelector(s).editor.state.selection.node?.type.name === "imageEmbed", ED), { timeoutMsg: "image not selected" });
}

/** Ctrl+C in the note (its selection as it is). */
async function copy() {
  await app.browser.execute((s) => document.querySelector(s).editor.view.focus(), ED);
  await app.keys(["Control", "c"]);
}

/**
 * What a real paste (Ctrl+V into a scratch text field) finds on the clipboard: its formats, the
 * files and the HTML. Asked until `ready` holds; `again` copies again first (the images' bytes are
 * read when they are selected, a copy before that has their addresses only).
 */
async function clipboard(ready, again = async () => {}) {
  let last;
  const fail = (e) => {
    throw new Error(`clipboard not as expected: ${JSON.stringify(last)?.slice(0, 600)} (${e.message})`);
  };
  await app.browser.waitUntil(
    async () => {
      await again();
      await app.browser.execute(() => {
        const t = document.createElement("textarea");
        t.className = "clip-probe";
        t.style.cssText = "position:fixed;left:0;top:0;width:40px;height:20px";
        t.addEventListener("paste", (e) => {
          e.preventDefault();
          const d = e.clipboardData;
          window.__clip = { types: [...d.types], files: [...d.files].map((f) => f.type), html: d.getData("text/html"), text: d.getData("text/plain") };
        });
        document.body.append(t);
        window.__clip = null;
        t.focus();
      });
      await app.keys(["Control", "v"]);
      last = await app.browser.execute(() => {
        document.querySelector(".clip-probe")?.remove();
        return window.__clip;
      });
      return !!last && ready(last);
    },
    { timeout: 8000 },
  ).catch(fail);
  return last;
}

test("a selected image copied with Ctrl+C pastes into another note as the same file with its size", async () => {
  image = (await app.invoke("attachment_save", { data: PNG, name: "Skizze.png", mime: "image/png" })).name;
  a = await h.create("Bilder Quelle", `Vorher\n\n![[${image}|480]]\n\nNachher\n`);
  b = await h.create("Bilder Ziel", "Ziel\n\n| Spalte | Bild |\n| --- | --- |\n| eins | x |\n");
  await h.open(a.id, "Bilder Quelle");
  await loaded(`${ED} img.embed-image`);
  await selectImage();
  await app.shot("430-image-selected");
  // Other programs: HTML that carries the image's bytes (the app's address is of no use there). The
  // image itself (PNG) is added where the web clipboard allows it, not for WebDriver's keys.
  const clip = await clipboard((c) => /src="data:image\/png/.test(c.html), copy);
  assert.equal(clip.text, `![[${image}|480]]`);
  assert.match(clip.html, new RegExp(`data-embed="${image}"`));
  assert.match(clip.html, /src="data:image\/png;base64,iVBOR/);
  const before = attachments();

  await h.open(b.id, "Bilder Ziel");
  await app.caretToEnd();
  await app.keys(["Control", "v"]);
  await h.waitContent(b.id, (c) => c.endsWith(`![[${image}|480]]\n`), "pasted image not saved");
  await loaded(`${ED} img.embed-image`);
  // The same stored file: nothing new in the attachments folder.
  assert.deepEqual(attachments(), before);
  await app.shot("430-pasted-other-note");
});

test("pasted into a table cell, the embed stays in the cell", async () => {
  const cell = await app.browser.execute((s) => {
    const td = [...document.querySelectorAll(`${s} td`)].find((x) => x.textContent.trim() === "x");
    const ed = document.querySelector(s).editor;
    const pos = ed.view.posAtDOM(td.querySelector("p"), 0);
    ed.commands.focus();
    ed.commands.setTextSelection({ from: pos, to: pos + 1 });
    return !!td;
  }, ED);
  assert.ok(cell);
  await app.keys(["Control", "v"]);
  // In a cell the size's `|` is escaped.
  let saved = "";
  const cellRe = new RegExp(String.raw`\| eins +\| !\[\[${image}\\\|480\]\] +\|`);
  await app.browser.waitUntil(async () => cellRe.test((saved = await h.content(b.id))), { timeout: 8000 }).catch(() => assert.fail(`image not pasted into the cell: ${saved}`));
  await app.shot("430-pasted-table-cell");
});

test("the capture window takes the copied image as its embed, not as a new file", async () => {
  const before = attachments();
  const w = await openCapture(app);
  await app.keys(["Control", "v"]);
  await app.browser.waitUntil(() => app.browser.execute(() => /!\[\[/.test(document.querySelector(".capture-input")?.value ?? "")), {
    timeout: 5000,
    timeoutMsg: "nothing pasted into the capture window",
  });
  assert.equal(await app.browser.execute(() => document.querySelector(".capture-input").value), `![[${image}|480]]`);
  await app.shot("430-capture-paste");
  assert.deepEqual(attachments(), before);
  await app.keys(["Escape"]);
  await w.toMain();
});

test("a text selection with an image copies both; cut moves the image", async () => {
  await h.open(a.id, "Bilder Quelle");
  await loaded(`${ED} img.embed-image`);
  await app.browser.execute((s) => document.querySelector(s).editor.commands.selectAll(), ED);
  const clip = await clipboard((c) => /src="data:image\/png/.test(c.html), copy);
  assert.match(clip.text, /Vorher[\s\S]*Nachher/);
  // Text with an image: no single image for other programs, the HTML has it.
  assert.deepEqual(clip.files, []);

  const c = await h.create("Bilder Kopie", "");
  await h.open(c.id, "Bilder Kopie");
  await app.caretToEnd();
  await app.keys(["Control", "v"]);
  await h.waitContent(c.id, (t) => t.includes("Vorher") && t.includes(`![[${image}|480]]`) && t.includes("Nachher"), "selection not pasted");

  // Cut the image from the first note, paste it at the end of the copy.
  await h.open(a.id, "Bilder Quelle");
  await loaded(`${ED} img.embed-image`);
  await selectImage();
  await app.keys(["Control", "x"]);
  await h.waitContent(a.id, (t) => !t.includes("![["), "image not cut");
  await h.open(c.id, "Bilder Kopie");
  await app.caretToEnd();
  await app.keys(["Control", "v"]);
  await h.waitContent(c.id, (t) => (t.match(/!\[\[/g) ?? []).length === 2, "cut image not pasted");
});

test("„Bild kopieren“ in the image menu copies the image; pasted in a note it is embedded", async () => {
  await h.open(b.id, "Bilder Ziel");
  await loaded(`${ED} img.embed-image`);
  await (await app.$(`${ED} img.embed-image`)).click({ button: "right" });
  await app.waitText(".menu-item", /Bild kopieren/);
  await app.shot("430-image-menu");
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((m) => m.textContent.includes("Bild kopieren"))?.click());
  await app.waitText(".toast", /Bild kopiert/);
  await app.dismissToasts();
  // The web clipboard (image, HTML and text) or, where it refuses, the app's (the image alone).
  const clip = await clipboard((c) => c.files.includes("image/png") || /data-embed/.test(c.html));
  assert.ok(clip.text === "" || clip.text === `![[${image}|480]]`, clip.text);
  const c = await h.create("Bilder Menü", "");
  await h.open(c.id, "Bilder Menü");
  await app.caretToEnd();
  await app.keys(["Control", "v"]);
  await h.waitContent(c.id, (t) => /!\[\[[0-9a-f]{16}\.png(\|480)?\]\]/.test(t), "copied image not pasted");
  await loaded(`${ED} img.embed-image`);
});

test("a selected image: Delete removes it, Ctrl+Z brings it back, the size menu changes its width", async () => {
  const page = await h.create("Bilder Tasten", `Davor ![[${image}|240]] danach\n`);
  await h.open(page.id, "Bilder Tasten");
  await loaded(`${ED} img.embed-image`);
  await selectImage();
  await app.keys(["Delete"]);
  await h.waitContent(page.id, (t) => t === "Davor  danach\n", "image not deleted");
  await app.keys(["Control", "z"]);
  await h.waitContent(page.id, (t) => t === `Davor ![[${image}|240]] danach\n`, "image not back");
  await loaded(`${ED} img.embed-image`);
  await (await app.$(`${ED} img.embed-image`)).click({ button: "right" });
  await app.waitText(".menu-item", /Größe/);
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((m) => m.textContent.includes("Größe"))?.click());
  await app.waitText(".menu-item", /Groß \(720 px\)/);
  await app.browser.execute(() => [...document.querySelectorAll(".menu-item")].find((m) => m.textContent.includes("Groß (720 px)"))?.click());
  await h.waitContent(page.id, (t) => t === `Davor ![[${image}|720]] danach\n`, "size not set");
  await app.keys(["Control", "z"]);
  await h.waitContent(page.id, (t) => t === `Davor ![[${image}|240]] danach\n`, "size not undone");
});

test("the hover preview of a linked note shows its image, not „!name.png“", async () => {
  const page = await h.create("Bilder Link", "Siehe [[Bilder Ziel]] hier\n");
  await h.open(page.id, "Bilder Link");
  const link = await app.waitFor(`${ED} .wikilink`);
  await link.moveTo();
  await app.waitText(".link-preview-title", /Bilder Ziel/);
  await loaded(".link-preview-body img");
  assert.doesNotMatch(await app.textOf(await app.$(".link-preview-body")), /!\S+\.png/);
  await app.shot("430-hover-preview");
  await (await app.$(`${ED} p`)).moveTo({ xOffset: -200 });
});

test("the pasted image keeps working after the first note is deleted and the app reloads", async () => {
  await app.invoke("page_delete", { id: a.id });
  await app.reload();
  await h.open(b.id, "Bilder Ziel");
  await loaded(`${ED} img.embed-image`);
  assert.ok(attachments().includes(image));
  assert.deepEqual(await app.consoleErrors(), []);
});
