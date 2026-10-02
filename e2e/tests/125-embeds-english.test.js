// Embeds, queries and Mermaid (1.9) in English and the dark theme: the frames, notices, query
// result and diagram bar are English, a query written in English runs, a broken diagram explains
// itself, and nothing German is left in the new UI.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";

const test = guarded(nodeTest, () => app);
let app, dataDir;
const ids = {};

const SOURCE = "# Source\nIntro text\n\n## Goals\nShip early.\n\n## Risks\nToo late. ^r1\n";
const HOST = [
  "![[Source#Goals]]",
  "![[Source#^r1]]",
  "![[Loop A]]",
  "![[Nowhere]]",
  "![[Source#Missing]]",
  "```query\nfrom: tasks\nshow: table\n#e2een status: open\n```",
  "```query\nfrom: tasks\nshow: count\n#e2een status: all\n```",
  "```mermaid\nsequenceDiagram\n  Client->>Sales: Request\n  Sales-->>Client: Offer\n```",
  "```mermaid\nflowchart LR\n  A[[[ --> B\n```",
].join("\n\n");

async function open(id, title) {
  await app.invoke("search_open", { target: { kind: "page", page_id: id, new_tab: false } });
  await app.browser.waitUntil(async () => (await app.browser.execute(() => document.querySelector(".pane.active .page-title")?.value)) === title, { timeoutMsg: `${title} not open` });
  await app.waitFor(".pane.active .ProseMirror");
}

before(async () => {
  ({ app, dataDir } = await launchEnglish());
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark" } });
  const make = async (key, title, content) => (ids[key] = (await app.invoke("page_create", { parentId: null, title, icon: null, content })).id);
  await make("source", "Source", SOURCE);
  await make("a", "Loop A", "In A\n\n![[Loop B]]\n");
  await make("b", "Loop B", "In B\n\n![[Loop A]]\n");
  await make("tasks", "Task list", "- [ ] Write the offer #e2een\n- [ ] Call the client #e2een\n- [x] Old one #e2een\n");
  await make("host", "Embedded", `${HOST}\n`);
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test("embeds, queries and diagrams in English and dark", async () => {
  await open(ids.host, "Embedded");
  const n = await app.browser.execute(() => document.querySelectorAll(".pane.active .ProseMirror > p > .page-embed, .pane.active .rich-preview").length);
  assert.equal(n, 9);
  for (let i = 0; i < n; i++) {
    await app.browser.execute((k) => document.querySelectorAll(".pane.active .ProseMirror > p > .page-embed, .pane.active .rich-preview")[k].scrollIntoView({ block: "center" }), i);
    await app.browser.pause(150);
  }
  const text = () => app.browser.execute(() => document.querySelector(".pane.active .ProseMirror").innerText);
  await app.browser.waitUntil(async () => /Ship early\.[\s\S]*Too late\.[\s\S]*Offer/.test(await text()) && !/Loading/.test(await text()), { timeout: 15000, timeoutMsg: "not rendered" });
  await app.browser.waitUntil(() => app.browser.execute(() => !!document.querySelector('.pane.active .mmd[data-state="ready"] svg') && !!document.querySelector('.pane.active .mmd[data-state="error"]')), { timeout: 15000, timeoutMsg: "diagrams not rendered" });
  const all = await text();
  assert.match(all, /Source › Goals\s+Goals\s+Ship early\./);
  assert.doesNotMatch(all, /Risks[\s\S]*Source › \^r1/, "the section ends before Risks");
  assert.match(all, /“Loop A” is already shown around this embed, so it is not repeated here\./);
  assert.match(all, /There is no page “Nowhere” yet\.\s*Create page/);
  assert.match(all, /“Missing” was not found in “Source”\./);
  assert.match(all, /Task\s+Page\s+Due[\s\S]*Call the client/);
  assert.match(all, /Task\s+Page\s+Due[\s\S]*Write the offer/);
  assert.doesNotMatch(all, /Old one/);
  assert.match(all, /Tasks\s*·\s*2 results/);
  assert.match(all, /3\s+tasks/);
  assert.match(all, /The diagram has an error/);
  assert.match(all, /Mermaid · sequenceDiagram\s+Source/);
  assert.equal((await app.invoke("page_get", { id: ids.host })).content, `${HOST}\n`, "the Markdown stays as written");
  const left = await germanLeftovers(app, [/Ship early|Too late|Intro text/]);
  assert.deepEqual(left, []);
  await app.browser.execute(() => document.querySelector(".pane.active .ProseMirror > p > .page-embed").scrollIntoView({ block: "start" }));
  await app.shot("125-embeds-dark");
  await app.browser.execute(() => document.querySelector(".pane.active .rich-preview.rich-query").scrollIntoView({ block: "start" }));
  await app.shot("125-queries-mermaid-dark");
});
