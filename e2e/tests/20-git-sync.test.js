// Git sync of the Markdown copy to a local bare repository: commit after a backup, status,
// token round trip (never exposed), connection test, failure toast and restore as a vault import.
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
  app = await launch();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-git-"));
  bare = path.join(base, "notizen.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const git = (...args) => execFileSync("git", ["-C", bare, ...args], { encoding: "utf8" });
const TOKEN = "ghp_e2eGeheimerToken4711";

const saveGitSettings = async (patch) => {
  const view = await app.invoke("settings_get");
  const settings = { ...view.settings, git_sync: { ...view.settings.git_sync, ...patch } };
  return app.invoke("settings_save", { settings });
};

test("git sync is off by default and backwards compatible", async () => {
  const view = await app.invoke("settings_get");
  assert.equal(view.settings.git_sync.enabled, false);
  assert.equal(view.settings.git_sync.branch, "main");
  assert.equal(view.settings.git_sync.mode, "with_backup");
  const status = await app.invoke("git_sync_status");
  assert.equal(status.last_at, null);
  assert.equal(status.token_set, false);
});

test("a backup commits the notes to the remote; a second sync without changes adds no commit", async () => {
  const saved = await saveGitSettings({ enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com" });
  assert.equal(saved.settings.git_sync.remote_url, bare);

  await app.invoke("backup_now");
  const log = git("log", "--format=%an|%s", "main").trim().split("\n");
  assert.equal(log.length, 1, log.join("\n"));
  assert.match(log[0], /^E2E\|Sicherung \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} – \d+ Dateien geändert$/);

  const files = git("ls-tree", "-r", "--name-only", "main").trim().split("\n");
  const arch = files.find((f) => path.posix.basename(f) === "Architektur.md");
  assert.ok(arch, `Architektur.md in ${files.join(", ")}`);
  assert.match(git("show", `main:${arch}`), /Middleware/i);
  assert.ok(files.includes("README.md") && files.includes(".gitattributes"), "sync's own files");
  assert.ok(files.some((f) => f.startsWith("Zeiterfassung/") && f.endsWith(".csv")), "time entries as CSV");
  assert.ok(!files.includes("annalo-workspace.db"), "database only when enabled");

  const out = await app.invoke("git_sync_now");
  assert.equal(out.committed, false);
  assert.equal(out.fallback, false);
  assert.equal(git("rev-list", "--count", "main").trim(), "1");

  const status = await app.invoke("git_sync_status");
  assert.equal(status.last_error, null);
  assert.equal(status.last_commit, git("rev-parse", "--short", "main").trim());
  assert.equal(status.last_branch, "main");
  assert.equal(status.pending_changes, 0);
  assert.ok(status.last_at);
  assert.equal(status.repo_path, path.join(app.dataDir, "git-sync"));
});

test("a changed note leads to a new commit with the note", async () => {
  const tree = await app.invoke("workspace_tree");
  const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
  const page = flat(tree).find((n) => n.title === "Architektur");
  assert.ok(page, "demo page Architektur");
  const doc = await app.invoke("page_get", { id: page.id });
  await app.invoke("page_save", { id: page.id, content: `${doc.content}\n\nGit-Sync-Test ok` });
  const status = await app.invoke("git_sync_status");
  // The mirror is refreshed with the sync itself, so nothing is pending in the old mirror yet.
  assert.equal(typeof status.pending_changes, "number");

  const out = await app.invoke("git_sync_now");
  assert.equal(out.committed, true, JSON.stringify(out));
  assert.ok(out.changed_files >= 1);
  assert.equal(git("rev-list", "--count", "main").trim(), "2");
  const arch = git("ls-tree", "-r", "--name-only", "main").split("\n").find((f) => f.endsWith("Architektur.md"));
  assert.match(git("show", `main:${arch}`), /Git-Sync-Test ok/);
  assert.match(git("log", "-1", "--format=%s", "main"), /– \d+ Datei(en)? geändert/);
});

test("the token is stored and removed but never exposed", async () => {
  let status = await app.invoke("git_token_set", { token: `  ${TOKEN}  ` });
  assert.equal(status.token_set, true);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  status = await app.invoke("git_sync_status");
  assert.equal(status.token_set, true);
  assert.ok(!JSON.stringify(status).includes(TOKEN));
  const view = await app.invoke("settings_get");
  assert.ok(!JSON.stringify(view).includes(TOKEN), "not in the settings");

  // Syncing with a token set never writes it into the repository configuration.
  await app.invoke("git_sync_now");
  const config = fs.readFileSync(path.join(app.dataDir, "git-sync", ".git", "config"), "utf8");
  assert.ok(!config.includes(TOKEN));
  assert.ok(!git("config", "--list").includes(TOKEN));

  status = await app.invoke("git_token_set", { token: null });
  assert.equal(status.token_set, false);
});

test("connection test, failure toast and settings UI", async () => {
  const ok = await app.invoke("git_sync_test", { url: bare, token: null });
  assert.equal(ok.ok, true, ok.error);
  assert.deepEqual(ok.branches, ["main"]);
  const bad = await app.invoke("git_sync_test", { url: path.join(base, "fehlt.git"), token: null });
  assert.equal(bad.ok, false);
  assert.ok(bad.error);

  // A broken remote: the command fails, the UI shows a toast, the status keeps the error.
  await saveGitSettings({ remote_url: path.join(base, "fehlt.git") });
  await assert.rejects(app.invoke("git_sync_now"));
  await app.waitText(".toast-title", /Git-Synchronisierung fehlgeschlagen/);
  const failed = await app.invoke("git_sync_status");
  assert.ok(failed.last_error, "error recorded");
  await app.dismissToasts();

  // The settings UI (its store still holds the startup settings): remote URL, switch, sync button.
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Sicherung") await el.click();
  await app.waitText(".set-group-head h2", /^Git-Synchronisierung$/);
  const url = await app.waitFor('input[aria-label="Remote-URL"]');
  await url.scrollIntoView();
  await url.click();
  await url.clearValue();
  await url.setValue(bare);
  await app.keys(["Enter"]);
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.git_sync.remote_url === bare, { timeoutMsg: "remote URL not saved" });
  const sw = '[role="switch"][aria-label="Git-Synchronisierung"]';
  if ((await (await app.$(sw)).getAttribute("aria-checked")) !== "true") await app.click(sw);
  await app.waitFor(`${sw}[aria-checked="true"]`);
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.git_sync.enabled === true, { timeoutMsg: "switch not saved" });
  await app.dismissToasts();

  let syncButton;
  for (const b of await app.$$(".set-group button")) if ((await app.textOf(b)) === "Jetzt synchronisieren") syncButton = b;
  assert.ok(syncButton, "sync button");
  await syncButton.click();
  await app.waitText(".git-status", new RegExp(`Commit ${git("rev-parse", "--short", "main").trim()}`), 20000);
  assert.equal((await app.invoke("git_sync_status")).last_error, null);
  await app.waitText(".toast-title", /Synchronisiert|Git ist aktuell/);
  await app.dismissToasts();
  await url.scrollIntoView();
  await app.shot("settings-git-sync");
});

test("restore imports the repository as a new page „Git-Import <Datum>“", async () => {
  const report = await app.invoke("git_restore_import", { url: bare });
  assert.ok(report.pages > 3, JSON.stringify(report));
  const tree = await app.invoke("workspace_tree");
  const root = tree.find((n) => n.id === report.root_page_id);
  assert.ok(root, "top-level page");
  assert.match(root.title, /^Git-Import \d{2}\.\d{2}\.\d{4}$/);
  const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
  const arch = flat(root.children ?? []).find((n) => n.title === "Architektur");
  assert.ok(arch, "notes imported");
  assert.match((await app.invoke("page_get", { id: arch.id })).content, /Git-Sync-Test ok/);
  assert.ok(!flat(root.children ?? []).some((n) => n.title === "README"), "the sync's README is not imported");
});
