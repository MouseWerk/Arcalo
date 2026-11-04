// q124 round 4: two computers share a workspace through a Git repository (a local bare one) and
// work on the same things before syncing: the office computer titles its daily notes „04.11.2026“,
// the laptop „2026-11-04“; the office renames a page and a drawing and ticks a task while the
// laptop links the old title in a new page, draws on the drawing and ticks the next task. After
// the syncs nothing is doubled, no link points nowhere, the drawing keeps the laptop's strokes
// under its new name, and the two ticks merge without a decision.
process.env.TZ = "Europe/Berlin";

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, base, bare, office, laptop;
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const todayDe = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
const git = (...args) => execFileSync("git", ["-C", bare, ...args], { encoding: "utf8" });
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const pages = async () => flat(await app.invoke("workspace_tree"));
const named = async (title) => (await pages()).filter((p) => p.title === title);
const one = async (title) => {
  const found = await named(title);
  assert.equal(found.length, 1, `${title}: ${(await pages()).map((p) => p.title).join(", ")}`);
  return found[0];
};
const content = async (id) => (await app.invoke("page_get", { id })).content;
const file = (dir, name) => {
  try {
    return fs.readFileSync(path.join(dir, "attachments", name), "utf8");
  } catch {
    return null;
  }
};
const TASKS = "## Woche\n\n- [ ] Bericht\n- [ ] Anruf\n- [ ] Angebot\n";

async function start(dataDir) {
  await stop();
  app = await launch({ demo: false, dataDir, env: { TZ: "Europe/Berlin" } });
}
async function stop() {
  await app?.close();
  app = null;
}
async function enableSync(name, notes = {}) {
  const view = await app.invoke("settings_get");
  const s = view.settings;
  await app.invoke("settings_save", {
    settings: { ...s, notes: { ...s.notes, ...notes }, git_sync: { ...s.git_sync, enabled: true, remote_url: bare, author_name: name, author_email: `${name.toLowerCase()}@example.com` } },
  });
}
async function sync() {
  const out = await app.invoke("git_sync_now");
  assert.ok(!out.error, JSON.stringify(out));
  return out;
}
async function tick(title, text) {
  const page = await one(title);
  const task = (await app.invoke("tasks_list", { filter: { page_id: page.id } })).find((t) => t.text === text);
  await app.invoke("task_set_done", { pageId: page.id, ordinal: task.ordinal, done: true, expectedText: task.text });
}

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-603-"));
  bare = path.join(base, "notizen.git");
  office = path.join(base, "office");
  laptop = path.join(base, "laptop");
  for (const dir of [office, laptop]) fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", bare]);
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

test("the office computer writes its notes and syncs them", async () => {
  fs.writeFileSync(path.join(office, "attachments", "Skizze.excalidraw"), '{"type":"excalidraw","v":1}');
  fs.writeFileSync(path.join(office, "attachments", "Skizze.excalidraw.svg"), "<svg>1</svg>");
  await start(office);
  await enableSync("Office", { daily_title: "de" });
  const daily = await app.invoke("daily_note", { date: today });
  assert.equal(daily.title, todayDe);
  await app.invoke("page_save", { id: daily.id, content: "## Notizen\n\nIm Büro begonnen.\n" });
  await app.invoke("page_create", { parentId: null, title: "Konzept", icon: null, content: "Felder: Kunde, Auftrag" });
  await app.invoke("page_create", { parentId: null, title: "Verweis", icon: null, content: "Siehe [[Konzept]]." });
  await app.invoke("page_create", { parentId: null, title: "Aufgaben", icon: null, content: TASKS });
  await app.invoke("page_create", { parentId: null, title: "Skizzen", icon: null, content: "Der Plan: ![[Skizze.excalidraw]]" });
  await sync();
  await stop();
});

test("the laptop takes the office's daily note as its own and goes on before the next sync", async () => {
  await start(laptop);
  await enableSync("Laptop");
  await sync();
  // „Heute“ opens the office's daily note although the laptop titles daily notes „2026-11-04“.
  const daily = await app.invoke("daily_note", { date: today });
  assert.equal(daily.title, todayDe);
  assert.match(await content(daily.id), /Im Büro begonnen/);
  assert.equal((await named(today)).length, 0, "no second daily note of today");
  // Work of its own: a link to „Konzept“, strokes on the drawing, the second task done.
  await app.invoke("page_create", { parentId: null, title: "Neu vom Laptop", icon: null, content: "Bezug: [[Konzept]]" });
  fs.writeFileSync(path.join(laptop, "attachments", "Skizze.excalidraw"), '{"type":"excalidraw","v":2}');
  fs.writeFileSync(path.join(laptop, "attachments", "Skizze.excalidraw.svg"), "<svg>2</svg>");
  await tick("Aufgaben", "Anruf");
  await stop();
});

test("the office renames the page and the drawing and ticks the first task", async () => {
  await start(office);
  const konzept = await one("Konzept");
  await app.invoke("page_rename", { id: konzept.id, title: "Konzept 2026", updateLinks: true });
  await app.invoke("attachment_rename", { name: "Skizze.excalidraw", newName: "Plan.excalidraw" });
  assert.equal(await content((await one("Skizzen")).id), "Der Plan: ![[Plan.excalidraw]]");
  await tick("Aufgaben", "Bericht");
  await sync();
  await stop();
});

test("the laptop syncs: links and the drawing follow the renames, the ticks merge", async () => {
  await start(laptop);
  await sync();
  const neu = await one("Neu vom Laptop");
  assert.equal(await content(neu.id), "Bezug: [[Konzept 2026]]");
  assert.equal((await named("Konzept")).length, 0);
  assert.equal(await content((await one("Skizzen")).id), "Der Plan: ![[Plan.excalidraw]]");
  assert.equal(file(laptop, "Plan.excalidraw"), '{"type":"excalidraw","v":2}', "the laptop's strokes under the new name");
  assert.equal(file(laptop, "Plan.excalidraw.svg"), "<svg>2</svg>");
  assert.equal(file(laptop, "Skizze.excalidraw"), null);
  // Both computers changed „Aufgaben“: a conflict whose block merge needs no decision.
  const aufgaben = await one("Aufgaben");
  assert.deepEqual((await app.invoke("git_conflicts")).map((c) => c.page_id), [aufgaben.id]);
  const view = await app.invoke("git_conflict_get", { pageId: aufgaben.id });
  assert.equal(view.merge.conflicts, 0, JSON.stringify(view.merge.chunks));
  const merged = view.merge.chunks.map((c) => c.text).join("");
  assert.equal(merged, "## Woche\n\n- [x] Bericht\n- [x] Anruf\n- [ ] Angebot\n");
  await app.invoke("git_conflict_resolve", { pageId: aufgaben.id, content: merged });
  assert.deepEqual(await app.invoke("git_conflicts"), []);
  await sync();
  assert.equal(git("show", "main:attachments/Plan.excalidraw"), '{"type":"excalidraw","v":2}');
  assert.ok(!git("ls-tree", "-r", "--name-only", "main").split("\n").includes("attachments/Skizze.excalidraw"));
  await stop();
});

test("the office takes the laptop's work over", async () => {
  await start(office);
  await sync();
  assert.equal(await content((await one("Neu vom Laptop")).id), "Bezug: [[Konzept 2026]]");
  assert.equal(await content((await one("Aufgaben")).id), "## Woche\n\n- [x] Bericht\n- [x] Anruf\n- [ ] Angebot\n");
  assert.equal(file(office, "Plan.excalidraw"), '{"type":"excalidraw","v":2}');
  assert.equal((await app.invoke("daily_note", { date: today })).title, todayDe);
  assert.equal((await named(today)).length, 0);
  assert.equal((await named("Konzept")).length, 0);
  assert.deepEqual(await app.invoke("git_conflicts"), []);
});
