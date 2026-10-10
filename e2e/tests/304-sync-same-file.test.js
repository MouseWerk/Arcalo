// Git sync, 1.17: two computers attach a different file of the same name. Both files are kept:
// the one the server has first keeps the name, this computer's takes a name with its content's
// hash, and every note shows the file it was written with, here and on the other computer. Nothing
// flips back and forth with later syncs. The other computer is a clone of the bare repository.
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
  base = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-304-"));
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
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};

test("a file of the same name from another computer is kept beside this computer's; each note shows its own", async () => {
  const start = await app.invoke("page_create", { parentId: null, title: "Start", icon: null, content: "Übersicht" });
  assert.ok(start.id);
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, git_sync: { ...view.settings.git_sync, enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com" } },
  });
  await app.invoke("git_sync_now");

  // The other computer attaches its „Bericht.docx“ to a note and syncs first.
  execFileSync("git", ["clone", "-q", "-b", "main", bare, other]);
  fs.mkdirSync(path.join(other, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(other, "attachments", "Bericht.docx"), "PK Bericht vom Laptop");
  fs.writeFileSync(path.join(other, "Vom Laptop.md"), "Der Bericht vom Laptop: ![[Bericht.docx]]");
  gitOther("add", "-A");
  gitOther("commit", "-q", "-m", "Laptop");
  gitOther("push", "-q", "origin", "HEAD:main");

  // Here another file of that name goes into another note.
  const file = path.join(base, "Bericht.docx");
  fs.writeFileSync(file, "PK Bericht von hier");
  const saved = await app.invoke("attachment_import", { path: file });
  assert.equal(saved.name, "Bericht.docx");
  const hier = await app.invoke("page_create", { parentId: null, title: "Von hier", icon: null, content: `Der Bericht von hier: ${saved.markdown}` });
  const out = await app.invoke("git_sync_now");
  assert.match(out.message, /vom Server übernommen/, JSON.stringify(out));

  // Both files here: the server's under the name, this computer's under its new name.
  const files = (await app.invoke("attachments_list")).files.map((f) => f.name).sort();
  const renamed = files.find((n) => /^Bericht-[0-9a-f]{8}\.docx$/.test(n));
  assert.ok(renamed, JSON.stringify(files));
  const attachments = path.join(app.dataDir, "attachments");
  assert.equal(fs.readFileSync(path.join(attachments, "Bericht.docx"), "utf8"), "PK Bericht vom Laptop");
  assert.equal(fs.readFileSync(path.join(attachments, renamed), "utf8"), "PK Bericht von hier");
  // Each note links to its own file.
  assert.equal((await app.invoke("page_get", { id: hier.id })).content, `Der Bericht von hier: ![[${renamed}]]`);
  const laptop = await pageNamed("Vom Laptop");
  assert.equal((await app.invoke("page_get", { id: laptop.id })).content, "Der Bericht vom Laptop: ![[Bericht.docx]]");

  // Each page shows its own file.
  await openTree("Von hier");
  await app.waitText(".pane.active .file-embed .file-embed-name", new RegExp(`^${renamed.replace(".", "\\.")}$`));
  await app.shot("304-own-file-after-sync");
  await openTree("Vom Laptop");
  await app.waitText(".pane.active .file-embed .file-embed-name", /^Bericht\.docx$/);

  // The other computer gets both files and this computer's note with the new link.
  gitOther("pull", "-q", "origin", "main");
  assert.equal(fs.readFileSync(path.join(other, "attachments", "Bericht.docx"), "utf8"), "PK Bericht vom Laptop");
  assert.equal(fs.readFileSync(path.join(other, "attachments", renamed), "utf8"), "PK Bericht von hier");
  assert.equal(fs.readFileSync(path.join(other, "Von hier.md"), "utf8"), `Der Bericht von hier: ![[${renamed}]]`);

  // Nothing moves back and forth.
  const again = await app.invoke("git_sync_now");
  assert.equal(again.committed, false, JSON.stringify(again));
  gitOther("pull", "-q", "origin", "main");
  assert.equal(fs.readFileSync(path.join(other, "attachments", "Bericht.docx"), "utf8"), "PK Bericht vom Laptop");
  assert.deepEqual(await app.consoleErrors(), []);
});
