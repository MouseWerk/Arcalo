// Git sync, 1.16: a page another computer moved or renamed moves here too (same page, its versions
// stay), and a page deleted here that the other computer edited comes back with a notice. The other
// computer is a clone of the bare repository, changed with git.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let base;
let bare;
let other;
before(async () => {
  app = await launch({ demo: false });
  base = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-302-"));
  bare = path.join(base, "notizen.git");
  other = path.join(base, "anderer-computer");
  execFileSync("git", ["init", "-q", "--bare", bare]);
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const gitOther = (...args) =>
  execFileSync("git", ["-C", other, "-c", "user.name=Laptop", "-c", "user.email=laptop@example.com", ...args], { encoding: "utf8" });
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const pageNamed = async (title) => flat(await app.invoke("workspace_tree")).find((n) => n.title === title);

test("moves and renames from another computer keep the page; a deleted page edited there comes back", async () => {
  const projekt = await app.invoke("page_create", { parentId: null, title: "Projekt", icon: null, content: "Übersicht" });
  const notiz = await app.invoke("page_create", { parentId: null, title: "Notiz", icon: null, content: "Erste Fassung" });
  await app.invoke("page_save", { id: notiz.id, content: "Zweite Fassung" });
  const alt = await app.invoke("page_create", { parentId: null, title: "Alter Titel", icon: null, content: "Text bleibt" });
  const weg = await app.invoke("page_create", { parentId: null, title: "Protokoll", icon: null, content: "Stand vom Montag" });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, git_sync: { ...view.settings.git_sync, enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com" } },
  });
  const first = await app.invoke("git_sync_now");
  const versions = (await app.invoke("page_versions", { pageId: notiz.id })).length;

  // The other computer moves „Notiz“ below „Projekt“, renames „Alter Titel“ and edits „Protokoll“.
  execFileSync("git", ["clone", "-q", "-b", "main", bare, other]);
  const files = gitOther("ls-files");
  assert.match(files, /^Notiz\.md$/m, `${JSON.stringify(first)}\n${files}`);
  fs.mkdirSync(path.join(other, "Projekt"));
  gitOther("mv", "Notiz.md", "Projekt/Notiz.md");
  gitOther("mv", "Alter Titel.md", "Neuer Titel.md");
  fs.writeFileSync(path.join(other, "Protokoll.md"), "Stand vom Montag\n\nErgänzt am Dienstag");
  gitOther("commit", "-q", "-am", "Laptop");
  gitOther("push", "-q", "origin", "HEAD:main");

  // Here the protocol is deleted meanwhile.
  await app.invoke("page_delete", { id: weg.id });
  const out = await app.invoke("git_sync_now");
  assert.match(out.message, /vom Server übernommen/, JSON.stringify(out));

  const moved = await pageNamed("Notiz");
  assert.equal(moved.id, notiz.id, "the same page");
  assert.equal(moved.parent_id, projekt.id);
  assert.equal((await app.invoke("page_versions", { pageId: notiz.id })).length, versions, "its versions stay");
  const renamed = await pageNamed("Neuer Titel");
  assert.equal(renamed?.id, alt.id);
  assert.equal(await pageNamed("Alter Titel"), undefined);
  const back = await app.invoke("page_get", { id: weg.id });
  assert.equal(back.deleted_at, null, "restored from the trash");
  assert.match(back.content, /Ergänzt am Dienstag/);
  const trash = await app.invoke("trash_list");
  assert.equal(trash.length, 0, JSON.stringify(trash));

  // The notice about the page that came back.
  const toast = await app.$(".toast*=Gelöschte Seite zurückgeholt");
  await toast.waitForDisplayed({ timeout: 8000 });
  await app.shot("302-restored-toast");

  // Nothing moves back and forth: the next syncs change nothing on either side.
  await app.invoke("git_sync_now");
  gitOther("pull", "-q", "origin", "main");
  assert.ok(fs.existsSync(path.join(other, "Projekt", "Notiz.md")) && !fs.existsSync(path.join(other, "Notiz.md")));
  assert.match(fs.readFileSync(path.join(other, "Protokoll.md"), "utf8"), /Ergänzt am Dienstag/);
  const last = await app.invoke("git_sync_now");
  assert.equal(last.committed, false, JSON.stringify(last));
});
