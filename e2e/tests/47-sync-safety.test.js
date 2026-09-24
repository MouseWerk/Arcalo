// Git sync safety (1.4): the first sync of a new computer merges with what another computer
// pushed (nothing on the server is deleted, its notes appear here), a missing or foreign mirror
// folder is refused with a German message in the UI and the log, and a sync that would delete
// many notes stops until „Löschungen übertragen“ is confirmed in the settings.
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
before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-safety-"));
  bare = path.join(base, "notizen.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  // Computer A has synced its notes already (as the sync writes them).
  const a = path.join(base, "rechner-a");
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(a, file)), { recursive: true });
    fs.writeFileSync(path.join(a, file), text);
  };
  put(".gitattributes", "# Annalo Git-Synchronisierung\n* text=auto\n");
  put("README.txt", "Annalo – Markdown-Kopie\r\n");
  put("Server-Notiz.md", "# Server-Notiz\n\nVom ersten Rechner.\n");
  put("Kunde Nord.md", "Übersicht Kunde Nord\n");
  put("Kunde Nord/Angebot.md", "Angebot 2026 für Kunde Nord\n");
  const g = (...args) => execFileSync("git", ["-c", "user.name=A", "-c", "user.email=a@example.com", "-c", "commit.gpgsign=false", "-C", a, ...args]);
  execFileSync("git", ["init", "-q", "-b", "main", a]);
  g("add", "-A");
  g("commit", "-q", "-m", "Sicherung von Rechner A");
  g("push", "-q", bare, "main");
  app = await launch();
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const serverFiles = () => execFileSync("git", ["-C", bare, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).trim().split("\n");
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const saveSettings = async (patch) => {
  const view = await app.invoke("settings_get");
  return app.invoke("settings_save", { settings: { ...view.settings, ...patch(view.settings) } });
};

test("the first sync of a new computer merges: the server keeps its notes, they appear here", async () => {
  await saveSettings((s) => ({ git_sync: { ...s.git_sync, enabled: true, remote_url: bare, author_name: "B", author_email: "b@example.com" } }));
  const out = await app.invoke("git_sync_now");
  assert.equal(out.fallback, false, JSON.stringify(out));
  const files = serverFiles();
  for (const f of ["Server-Notiz.md", "Kunde Nord.md", "Kunde Nord/Angebot.md"]) assert.ok(files.includes(f), `${f} still on the server: ${files.join(", ")}`);
  assert.ok(files.some((f) => f.endsWith("Architektur.md")), "this computer's notes were added");

  // The server's notes are pages here now, the subpage below its page.
  await app.browser.waitUntil(async () => flat(await app.invoke("workspace_tree")).some((n) => n.title === "Server-Notiz"), { timeoutMsg: "server note not created" });
  const tree = flat(await app.invoke("workspace_tree"));
  const kunde = tree.find((n) => n.title === "Kunde Nord");
  assert.ok(kunde, "Kunde Nord");
  assert.ok((kunde.children ?? []).some((c) => c.title === "Angebot"), "Angebot below Kunde Nord");
  const note = tree.find((n) => n.title === "Server-Notiz");
  assert.match((await app.invoke("page_get", { id: note.id })).content, /Vom ersten Rechner/);
  await app.waitText(".sidebar", /Server-Notiz/);
  await app.dismissToasts();

  // A second sync changes nothing on the server.
  const again = await app.invoke("git_sync_now");
  assert.equal(again.committed, false, JSON.stringify(again));
});

test("a foreign or missing mirror folder is refused with a clear message", async () => {
  const before = serverFiles();
  const foreign = path.join(base, "Dokumente");
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, "Steuer.pdf"), "PDF");
  await saveSettings(() => ({ markdown_mirror_dir: foreign }));
  const err = await app.invoke("git_sync_now").then(
    () => "",
    (e) => String(e).replace(/^Error: /, ""),
  );
  assert.match(err, /keine Markdown-Kopie von Annalo/);
  assert.doesNotMatch(err, /invalid state/);
  await app.waitText(".toast", /keine Markdown-Kopie/);
  assert.ok(fs.existsSync(path.join(foreign, "Steuer.pdf")), "the foreign folder is untouched");
  await app.dismissToasts();

  // A drive that is gone: the folder cannot even be created.
  const blocker = path.join(base, "kein-laufwerk");
  fs.writeFileSync(blocker, "Datei statt Laufwerk");
  await saveSettings(() => ({ markdown_mirror_dir: path.join(blocker, "Markdown") }));
  const err2 = await app.invoke("git_sync_now").then(
    () => "",
    (e) => String(e).replace(/^Error: /, ""),
  );
  assert.ok(err2, "refused");
  assert.doesNotMatch(err2, /invalid state/);
  assert.deepEqual(serverFiles(), before, "nothing pushed");
  const log = await app.invoke("devlog_read", { limit: 200 });
  assert.ok(log.some((e) => /keine Markdown-Kopie/.test(e.message)), "the refusal is in the developer log");
  const status = await app.invoke("git_sync_status");
  assert.ok(status.last_error && !/invalid state/.test(status.last_error), status.last_error);
  await app.dismissToasts();
  await saveSettings(() => ({ markdown_mirror_dir: null }));
});

test("deleting many notes stops the sync until it is confirmed in the settings", async () => {
  const ids = [];
  for (let i = 1; i <= 12; i++) ids.push((await app.invoke("page_create", { title: `Wegwerf ${i}`, parentId: null, icon: null, content: `Notiz ${i}` })).id);
  const synced = await app.invoke("git_sync_now");
  assert.equal(synced.committed, true, JSON.stringify(synced));
  assert.ok(serverFiles().includes("Wegwerf 12.md"));
  for (const id of ids) await app.invoke("page_delete", { id });

  const err = await app.invoke("git_sync_now").then(
    () => "",
    (e) => String(e).replace(/^Error: /, ""),
  );
  assert.match(err, /Zur Sicherheit angehalten/);
  assert.ok(serverFiles().includes("Wegwerf 1.md"), "nothing deleted on the server yet");
  const status = await app.invoke("git_sync_status");
  assert.equal(status.blocked_deletions, 12);
  await app.dismissToasts();

  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Sicherung") await el.click();
  await app.waitText(".set-group-head h2", /^Git-Synchronisierung$/);
  let confirm;
  await app.browser.waitUntil(
    async () => {
      for (const b of await app.$$(".set-group button")) if ((await app.textOf(b)) === "Löschungen übertragen") confirm = b;
      return !!confirm;
    },
    { timeoutMsg: "no „Löschungen übertragen“" },
  );
  await confirm.scrollIntoView({ block: "center" });
  await app.waitText(".set-group", /würde 12 Notizen auf dem Server löschen/);
  await app.shot("47-sync-deletions-held");
  await confirm.click();
  await app.waitFor(".dialog");
  await app.waitText(".dialog", /12 Notizen werden auf dem Server gelöscht/);
  for (const b of await app.$$(".dialog .dialog-foot button")) if ((await app.textOf(b)) === "Löschen und synchronisieren") await b.click();
  await app.browser.waitUntil(async () => !serverFiles().includes("Wegwerf 1.md"), { timeout: 20000, timeoutMsg: "deletions not pushed" });
  const after = await app.invoke("git_sync_status");
  assert.equal(after.last_error, null);
  assert.ok(!after.blocked_deletions);
  assert.ok(serverFiles().includes("Server-Notiz.md"), "the rest stays");
  await app.dismissToasts();
});
