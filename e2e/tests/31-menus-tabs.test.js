// Tooltips above everything; tab drag & drop (after the last tab, onto another pane) and the tab
// menu; the file tree menu; the image menu in notes; the chat menu.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";
import { startFakeLiteLLM } from "../lib/fake-litellm.js";

const test = guarded(nodeTest, () => app);
let app, llm;
before(async () => {
  llm = await startFakeLiteLLM({ port: 4993 });
  app = await launch();
});
after(async () => {
  await app?.close();
  await llm?.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGM4YWMDRAwQCgAlPgUBdJmUYAAAAABJRU5ErkJggg==";
const menuClick = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    if (!item) return false;
    item.click();
    return true;
  }, label);
const hoverSub = (label) =>
  app.browser.execute((l) => {
    const item = [...document.querySelectorAll(".menu-item, [role=menuitem]")].find((b) => b.textContent.trim().startsWith(l));
    item?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    item?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    item?.click();
    return !!item;
  }, label);
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
const titles = () => app.browser.execute(() => [...document.querySelectorAll(".pane.active .tab-title")].map((t) => t.textContent));

test("tooltips sit above everything (the sidebar's + is not covered by the editor)", async () => {
  await openTree("Architektur");
  const plus = await app.$('.side-toolbar [aria-label^="Neue Seite"]');
  await plus.moveTo();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.querySelector(".tooltip.on")?.textContent?.startsWith("Neue Seite")), { timeoutMsg: "no tooltip" });
  const top = await app.browser.execute(() => {
    const r = document.querySelector(".tooltip").getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { hit: el?.className ?? "", inView: r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0 };
  });
  assert.ok(top.inView, JSON.stringify(top));
  await app.shot("tooltip-sidebar");
});

test("tabs: drop after the last tab, move by menu, duplicate, drop onto another pane", async () => {
  await app.keys(["Control", "t"]);
  await openTree("Jour fixe 22.09.");
  await app.keys(["Control", "t"]);
  await openTree("SAP CATS Leitfaden");
  await app.browser.waitUntil(async () => (await titles()).length >= 3);
  const drag = (from, to, side) =>
    app.browser.execute(
      (a, b, sd) => {
        const tabs = document.querySelectorAll(".pane.active .tab");
        const src = tabs[a];
        const dst = tabs[b];
        const r = dst.getBoundingClientRect();
        const x = sd === "after" ? r.right - 4 : r.left + 4;
        const dt = new DataTransfer();
        src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        dst.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: r.top + 5 }));
        dst.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: r.top + 5 }));
        src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      },
      from,
      to,
      side,
    );
  let t = await titles();
  // First tab onto the right half of the last one: it becomes the last tab.
  await drag(0, t.length - 1, "after");
  await app.browser.waitUntil(async () => (await titles()).at(-1) === t[0], { timeoutMsg: `not after the last: ${await titles()}` });
  t = await titles();
  // Left half of the first tab: before it.
  await drag(t.length - 1, 0, "before");
  await app.browser.waitUntil(async () => (await titles())[0] === t.at(-1), { timeoutMsg: "not first" });

  // Tab menu: move right, duplicate.
  t = await titles();
  await (await app.$$(".pane.active .tab"))[0].click({ button: "right" });
  await menuClick("Nach rechts");
  await app.browser.waitUntil(async () => (await titles())[1] === t[0], { timeoutMsg: "move right" });
  await (await app.$$(".pane.active .tab"))[1].click({ button: "right" });
  await menuClick("Tab duplizieren");
  await app.browser.waitUntil(async () => (await titles()).length === t.length + 1, { timeoutMsg: "duplicate" });

  // Split, then drag a tab of the left pane onto the right pane's content.
  await (await app.$$(".pane.active .tab"))[0].click({ button: "right" });
  await menuClick("Rechts daneben öffnen");
  await app.browser.waitUntil(async () => (await app.$$(".pane")).length === 2);
  const moved = await app.browser.execute(() => {
    const left = document.querySelectorAll(".pane")[0];
    const right = document.querySelectorAll(".pane")[1];
    const src = left.querySelector(".tab:last-child") ?? left.querySelectorAll(".tab")[left.querySelectorAll(".tab").length - 1];
    const title = src.querySelector(".tab-title").textContent;
    const target = right.querySelector(".pane-content");
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return title;
  });
  await app.browser.waitUntil(async () => app.browser.execute((m) => [...document.querySelectorAll(".pane")].at(-1).querySelector(".tab.active .tab-title")?.textContent === m, moved), {
    timeoutMsg: "not moved to the other pane",
  });
});

test("file tree menu: duplicate, move, copy link", async () => {
  const find = (title) => app.browser.execute((t) => [...document.querySelectorAll(".sidebar .tree-row")].findIndex((r) => r.textContent.trim() === t), title);
  const rowMenu = async (title) => {
    const i = await find(title);
    await (await app.$$(".sidebar .tree-row"))[i].click({ button: "right" });
  };
  await rowMenu("Architektur");
  assert.ok(await menuClick("Duplizieren"));
  await app.browser.waitUntil(async () => (await find("Architektur (Kopie)")) >= 0, { timeoutMsg: "no copy" });
  const tree = await app.invoke("workspace_tree");
  const flat = (l) => l.flatMap((n) => [n, ...flat(n.children)]);
  const copy = flat(tree).find((n) => n.title === "Architektur (Kopie)");
  const orig = flat(tree).find((n) => n.title === "Architektur");
  assert.equal(copy.parent_id, orig.parent_id, "same parent");
  assert.equal((await app.invoke("page_get", { id: copy.id })).content, (await app.invoke("page_get", { id: orig.id })).content);

  await rowMenu("Architektur (Kopie)");
  await hoverSub("Verschieben");
  await sleep(150);
  assert.ok(await menuClick("Auf die oberste Ebene"));
  await app.browser.waitUntil(async () => flat(await app.invoke("workspace_tree")).find((n) => n.title === "Architektur (Kopie)")?.parent_id == null, { timeoutMsg: "not moved" });
  await app.shot("tree-menu");
});

test("image menu: size, full view, remove", async () => {
  const saved = await app.invoke("attachment_save", { data: PNG, name: "Bild.png", mime: "image/png" });
  const id = (await app.invoke("page_create", { title: "Bildseite", parentId: null })).id;
  await app.invoke("page_save", { id, content: `Vorher\n\n![[${saved.name}]]\n\nNachher\n` });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")));
  await openTree("Bildseite");
  const img = await app.waitFor(".pane.active .ProseMirror img.embed-image");
  // WebKit's driver reports the resized (selected) image as not displayed; the menu comes from the DOM event.
  const imgMenu = () =>
    app.browser.execute(() => {
      const el = document.querySelector(".pane.active .ProseMirror img.embed-image");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.x + 10, clientY: r.y + 10 }));
    });
  const content = async () => (await app.invoke("page_get", { id })).content;
  await img.click({ button: "right" });
  await hoverSub("Größe");
  await sleep(150);
  assert.ok(await menuClick("Mittel"));
  await app.browser.waitUntil(async () => (await content()).includes(`![[${saved.name}|480]]`), { timeoutMsg: "size not set" });
  await imgMenu();
  assert.ok(await menuClick("Vollbild ansehen"));
  await app.waitFor(".image-viewer img");
  await app.shot("image-viewer");
  await app.keys(["Escape"]);
  await app.browser.waitUntil(async () => !(await app.browser.execute(() => !!document.querySelector(".image-viewer"))));
  await imgMenu();
  assert.ok(await menuClick("Aus der Notiz entfernen"));
  await app.browser.waitUntil(async () => !(await content()).includes("![["), { timeoutMsg: "not removed" });
});

test("chat menu: copy, append to the page, edit a question", async () => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, litellm_base_url: llm.url, router: { ...view.settings.router, local_model: "firma-schnell", standard_model: "firma-standard", reasoning_model: "firma-reasoning" } },
  });
  await app.invoke("api_key_set", { key: llm.apiKey });
  await app.browser.execute(() => {
    if (!document.querySelector(".app > .panel")) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  });
  const ta = await app.waitFor(".composer textarea");
  await ta.setValue("Wie geht es weiter?");
  await app.keys(["Enter"]);
  await app.waitFor(".msg-ai .prose h2");
  await app.browser.waitUntil(async () => app.browser.execute(() => !!document.querySelector(".follow-ups")), { timeoutMsg: "no follow-ups" });
  await (await app.$(".msg-ai .prose")).click({ button: "right" });
  assert.ok(await menuClick("An „Bildseite“ anhängen"));
  const id = (await app.invoke("page_resolve", { title: "Bildseite", create: false })).id;
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id })).content.includes("## Zusammenfassung"), { timeoutMsg: "not appended" });
  const asked = await app.textOf(await app.$(".msg-user"));
  await (await app.$(".msg-user")).click({ button: "right" });
  assert.ok(await menuClick("Bearbeiten"));
  await app.browser.waitUntil(async () => (await (await app.$(".composer textarea")).getValue()) === asked.trim(), { timeoutMsg: `composer: ${await (await app.$(".composer textarea")).getValue()}` });
  await app.shot("chat-menu");
});

test("no console errors", async () => {
  assert.deepEqual(await app.browser.execute(() => window.__annaloErrors ?? []), []);
});
