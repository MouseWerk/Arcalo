// A canvas changed here and on another computer (Git sync): the conflict is decided as a whole
// („Meine behalten“, „Andere übernehmen“, „Beide behalten“), never as a text merge of its JSON.
// „Beide behalten“ keeps this computer's board and adds the server's as „<Titel> (Server)“.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, base, bare, other;
before(async () => {
  app = await launch();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-cvconflict-"));
  bare = path.join(base, "notizen.git");
  other = path.join(base, "anderer-rechner");
  execFileSync("git", ["init", "-q", "--bare", bare]);
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Anderer", "-c", "user.email=anderer@example.com", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const fileOf = (name) => git(bare, "ls-tree", "-r", "--name-only", "main").split("\n").find((f) => path.posix.basename(f) === name);
const card = (id, text) => ({ id, type: "text", text, x: 0, y: 0, width: 260, height: 120 });
const board = (...nodes) => JSON.stringify({ nodes, edges: [] }, null, "\t");

test("a canvas conflict offers mine, theirs or both and keeps both as two canvases", async () => {
  const cv = await app.invoke("canvas_create", { parentId: null, title: "Strategie" });
  await app.invoke("page_save", { id: cv.id, content: board(card("a", "Start")) });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, git_sync: { ...view.settings.git_sync, enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com" } } });
  assert.equal((await app.invoke("git_sync_now")).committed, true);

  // The other computer adds a card; here another card is added.
  git(base, "clone", "-q", "-b", "main", bare, other);
  const file = fileOf("Strategie.canvas");
  assert.ok(file, "the canvas is in the repository");
  const theirs = board(card("a", "Start"), card("b", "Vom anderen Rechner"));
  fs.writeFileSync(path.join(other, file), theirs);
  git(other, "commit", "-q", "-am", "Anderer Rechner");
  git(other, "push", "-q", "origin", "main");
  const mine = board(card("a", "Start"), card("c", "Hier ergänzt"), card("d", "Noch eine"));
  await app.invoke("page_save", { id: cv.id, content: mine });
  await app.invoke("git_sync_now");
  assert.deepEqual((await app.invoke("git_conflicts")).map((c) => c.page_id), [cv.id]);
  await app.dismissToasts();

  // The board shows the banner; the conflict view decides the canvas as a whole.
  await app.invoke("search_open", { target: { kind: "page", page_id: cv.id, new_tab: false } });
  await app.waitText(".pane.active .cv-conflict .cf-banner", /Konflikt/);
  await app.click(".pane.active .cv-conflict .cf-banner button");
  await app.waitFor(".pane.active .cf-keep-both");
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".pane.active .cf-conflict, .pane.active .cf-result").length), 0, "no text merge of the JSON");
  const sums = await app.browser.execute(() => [...document.querySelectorAll(".pane.active .cf-canvas-sum")].map((e) => e.textContent.trim()));
  assert.deepEqual(sums, ["3 Karten · 0 Verbindungen", "2 Karten · 0 Verbindungen"]);
  await app.shot("132-canvas-conflict");

  await app.click(".pane.active .cf-keep-both");
  await app.waitText(".toast-detail", /Strategie \(Server\)/);
  assert.deepEqual(await app.invoke("git_conflicts"), []);
  assert.equal((await app.invoke("page_get", { id: cv.id })).content, mine, "this computer's board stays");
  const copy = await app.invoke("page_resolve", { title: "Strategie (Server)", create: false });
  const doc = await app.invoke("page_get", { id: copy.id });
  assert.equal(doc.content, theirs, "the server's board is kept as a canvas of its own");
  assert.equal(doc.kind, "canvas");
  // Both are on the server after the sync that followed.
  assert.equal(git(bare, "show", `main:${file}`), mine);
  assert.ok(fileOf("Strategie (Server).canvas"), "the copy is synced too");
  await app.waitFor(".pane.active .cv-board");
  assert.equal(await app.browser.execute(() => document.querySelectorAll(".pane.active .cv-conflict .cf-banner").length), 0);
});
