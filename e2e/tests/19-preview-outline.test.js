// Hover preview of [[links]] and the scroll outline of long notes.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const openFromTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`tree row ${title} not found`);
};

test("hovering a [[link]] shows a preview card of that page", async () => {
  await openFromTree("PRJ-2026-X Rollout");
  const link = await app.waitFor('.ProseMirror a[data-wikilink][data-target="Architektur"]');
  await link.moveTo();
  await app.waitText(".link-preview-title", /Architektur/);
  assert.match(await app.textOf(await app.$(".link-preview-body")), /Middleware/);
  await app.shot("link-preview");
  await (await app.$(".link-preview-title")).click();
  await app.waitText(".pane.active .tab.active .tab-title", /Architektur/);
  assert.equal((await app.$$(".link-preview")).length, 0, "card closes after opening");
});

test("long notes get a scroll outline with heading marks", async () => {
  const id = (await app.invoke("page_create", { title: "Lange Seite", parentId: null })).id;
  const body = Array.from({ length: 12 }, (_, i) => `## Abschnitt ${i + 1}\n\n${"Text zum Scrollen. ".repeat(60)}`).join("\n\n");
  await app.invoke("page_save", { id, content: body + "\n" });
  await app.browser.refresh();
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.body.classList.contains("ready"))) === true, { timeout: 20000 });
  await openFromTree("Lange Seite");
  await app.waitFor(".scroll-outline");
  await app.browser.waitUntil(async () => (await app.$$(".so-mark")).length === 12, { timeoutMsg: "12 heading marks" });
  const before = await app.browser.execute(() => document.querySelector(".pane.active .page-scroll").scrollTop);
  await app.browser.execute(() => document.querySelectorAll(".so-mark")[9].click());
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-scroll").scrollTop)) > before + 500, { timeoutMsg: "did not scroll" });
  await app.browser.waitUntil(async () => (await app.$$(".so-mark.on")).length === 1);
  await app.shot("scroll-outline");
});
