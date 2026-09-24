// Templates (palette, slash menu, daily note) and image attachments (![[x.png]] embeds, paste).
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

// 2×2 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4YWMDRAwQCgAlPgUBdJmUYAAAAABJRU5ErkJggg==";

const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const title = async () => (await (await app.$(".pane.active .page-title")).getValue());
const today = () => new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

test("palette creates a page from a template", async () => {
  await app.keys(["Control", "k"]);
  await app.waitFor(".palette");
  await app.type("aus Vorlage");
  await app.waitText(".pal-item.sel", /Neue Seite aus Vorlage/);
  await app.keys(["Enter"]);
  await app.waitText(".tpl-list .sugg-item.sel", /Besprechung/);
  const input = await app.waitFor('input[aria-label="Titel der neuen Seite"]');
  assert.equal(await input.getValue(), `Besprechung ${today()}`);
  await app.shot("templates-new-page");
  await app.keys(["Control", "a"]);
  await app.type("Jour fixe Vertrieb");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await title()) === "Jour fixe Vertrieb", { timeoutMsg: "page from template not opened" });
  await app.waitText(".ProseMirror h2", /Teilnehmer/);
  const md = await content("Jour fixe Vertrieb");
  assert.match(md, /## Agenda/);
  assert.ok(md.includes(today()), md);
  assert.doesNotMatch(md, /\{\{/);
});

test("slash command inserts a template at the caret", async () => {
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("/vorlage");
  await app.waitText(".sugg-item.sel", /Vorlage einfügen/);
  await app.keys(["Enter"]);
  await app.waitText(".tpl-list .sugg-item.sel", /Besprechung/);
  await app.keys(["ArrowDown"]);
  await app.waitText(".tpl-list .sugg-item.sel", /Kundentermin/);
  await app.keys(["Enter"]);
  await app.waitText(".ProseMirror h2", /Ziel des Termins/);
  await app.browser.waitUntil(async () => /Termin: Jour fixe Vertrieb/.test(await content("Jour fixe Vertrieb")), {
    timeoutMsg: "inserted template not saved",
  });
  assert.doesNotMatch(await content("Jour fixe Vertrieb"), /\/vorlage/);
});

test("settings pick the template for new daily notes", async () => {
  await app.keys(["Control", ","]);
  for (const b of await app.$$(".settings-nav-item")) if ((await app.textOf(b)) === "Notizen") await b.click();
  const sel = '[role="combobox"][aria-label="Vorlage für Tagesnotizen"]';
  await app.waitFor(sel);
  const id = String(await pageId("Kundentermin"));
  await app.select(sel, id);
  await app.click(".savebar .btn-primary");
  await app.waitText(".toast", /gespeichert/);
  assert.equal((await app.invoke("settings_get")).settings.daily_template, Number(id));
  const day = await app.invoke("daily_note", { date: "2030-01-02" });
  assert.match((await app.invoke("page_get", { id: day.id })).content, /^Termin: 2030-01-02$/m);
});

test("an attachment embed renders as an image", async () => {
  const saved = await app.invoke("attachment_save", { data: PNG, name: "Bildschirmfoto.png", mime: "image/png" });
  assert.match(saved.name, /^[0-9a-f]{16}\.png$/);
  assert.equal(saved.markdown, `![[${saved.name}]]`);
  await app.keys(["Control", "n"]);
  await app.browser.waitUntil(() => app.browser.execute(() => document.activeElement?.classList.contains("page-title") && document.activeElement.selectionEnd > 0));
  await app.type("Screenshots");
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("page_resolve", { title: "Screenshots", create: false })) !== null);
  await app.invoke("page_save", { id: await pageId("Screenshots"), content: `Fehlerbild:\n\n${saved.markdown}\n` });
  await app.browser.execute(() => window.dispatchEvent(new CustomEvent("annalo:reload-pages", { detail: {} })));
  const img = await app.waitFor(".ProseMirror img.embed-image");
  await app.browser.waitUntil(() => app.browser.execute((el) => el.complete && el.naturalWidth === 2, img), { timeoutMsg: "attachment did not load" });
  await app.shot("attachment-embed");

  // Only plain names inside the attachments folder are served.
  const blocked = await app.browser.executeAsync((src, done) => {
    const i = new Image();
    i.onload = () => done("loaded");
    i.onerror = () => done("error");
    i.src = src;
  }, (await img.getAttribute("src")).replace(saved.name, `..%2F${saved.name}`));
  assert.equal(blocked, "error");

  // Editing keeps the embed syntax.
  await app.caretToEnd();
  await app.keys(["Enter"]);
  await app.type("Nachtrag");
  await app.browser.waitUntil(async () => /Nachtrag/.test(await content("Screenshots")));
  assert.ok((await content("Screenshots")).includes(saved.markdown));
});

test("pasting an image file stores it and inserts an embed", async () => {
  await app.caretToEnd();
  await app.keys(["Enter"]);
  const ok = await app.browser.execute((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    // A trailing byte: different content, different file.
    dt.items.add(new File([bytes, new Uint8Array([0])], "paste.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".pane.active .ProseMirror").dispatchEvent(ev);
    return ev.defaultPrevented;
  }, PNG);
  assert.ok(ok, "paste handled");
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .ProseMirror img.embed-image")).length === 2, { timeoutMsg: "pasted image not inserted" });
  await app.browser.waitUntil(async () => ((await content("Screenshots")).match(/!\[\[[0-9a-f]{16}\.png\]\]/g) ?? []).length === 2, {
    timeoutMsg: "pasted embed not saved",
  });
});
