// An update waits for running terminal commands (`arcalo pages create --stdin` stands in for a
// long one): the quit with a ready update shows „Das Update wartet auf einen Terminal-Befehl“
// and installs once the command has finished (a test stand-in replaces the installer:
// ARCALO_UPDATE_FAKE_INSTALL). With a command that keeps running, „Jetzt neu starten“ goes on
// after the time limit (ARCALO_UPDATE_WAIT_SECS; on Linux the program file is replaced beside
// the command) and the command is never ended. A lock left behind by a crashed command does
// not hold up the install. While the quit waits, the window stays usable: another quit is ignored,
// and what is typed meanwhile is stored before the install. An update postponed at three quits
// by terminal commands names them at the next start.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded, APP } from "../lib/harness.js";
import { startFeed, throwawayKey } from "../lib/update-feed.js";

const test = guarded(nodeTest, () => app);
let app;
let feed;
const key = throwawayKey();
const dirs = [];
const commands = [];

after(async () => {
  await app?.close();
  await feed?.close();
  // Commands still waiting for their text get it (never killed by the test either).
  for (const c of commands) if (c.exitCode === null) c.stdin.end("");
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, check, timeout = 15000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) if (check()) return;
  assert.fail(`timed out: ${what}`);
};

/** A fresh data folder; the app's local data folder (where the commands' locks are) is in it. */
function dataFolder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-cmdwait-"));
  dirs.push(dir);
  return { dir, locks: path.join(dir, "xdg-data", "de.mousewerk.arcalo", "commands") };
}

async function start(dir, waitSecs) {
  feed ??= await startFeed({ key, version: "1.9.0" });
  // A test that failed before its own close leaves no app behind.
  await app?.close();
  app = await launch({
    dataDir: dir,
    env: {
      ARCALO_UPDATE_PUBKEY: key.pubkey,
      ARCALO_UPDATE_ENDPOINT: feed.url,
      ARCALO_UPDATE_CURRENT: "1.8.5",
      ARCALO_UPDATE_FAKE_INSTALL: "1",
      ARCALO_UPDATE_WAIT_SECS: String(waitSecs),
    },
  });
  assert.equal((await app.invoke("update_check")).version, "1.9.0");
  await app.browser.waitUntil(async () => (await app.invoke("update_status")).ready === "1.9.0", { timeout: 20000, timeoutMsg: "update not ready" });
}

/** `arcalo pages create <title> --stdin` on the app's workspace: runs until its text is sent. */
function longCommand(dir, title) {
  const child = spawn(APP, ["--json", "pages", "create", title, "--stdin"], {
    env: { ...process.env, ARCALO_DATA_DIR: dir, XDG_DATA_HOME: path.join(dir, "xdg-data"), ARCALO_LOCALE: "de-DE" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.output = () => out;
  commands.push(child);
  return child;
}

/** `arcalo pages show <title>` on the app's workspace (after the app has ended). */
function pageText(dir, title) {
  const out = execFileSync(APP, ["--json", "pages", "show", title], {
    env: { ...process.env, ARCALO_DATA_DIR: dir, XDG_DATA_HOME: path.join(dir, "xdg-data"), ARCALO_LOCALE: "de-DE" },
    encoding: "utf8",
  });
  return JSON.parse(out).content;
}

const exited = (child) => new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("exit", (code) => r(code))));
const waitingText = () => app.browser.execute(() => document.querySelector(".update-waiting")?.textContent ?? null);

test("quitting with a ready update waits for a running command, shows it, and installs when it has finished", async () => {
  const { dir, locks } = dataFolder();
  await start(dir, 60);
  // A slow autosave, so a quit right after typing would lose the text without the flush.
  execFileSync(APP, ["--json", "settings", "set", "editor.autosave_ms", "3000"], {
    env: { ...process.env, ARCALO_DATA_DIR: dir, XDG_DATA_HOME: path.join(dir, "xdg-data"), ARCALO_LOCALE: "de-DE" },
    encoding: "utf8",
  });
  await app.browser.waitUntil(async () => (await app.invoke("settings_get")).settings.editor.autosave_ms === 3000, { timeout: 8000, timeoutMsg: "autosave delay not taken over" });
  const page = await app.invoke("page_create", { parentId: null, title: "Während des Wartens", icon: null, content: "Vorher\n" });
  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: false } });
  await app.waitText(".pane > .pane-content:not([hidden]) .ProseMirror", /Vorher/);
  const cmd = longCommand(dir, "Aus dem Terminal");
  const lock = path.join(locks, `${cmd.pid} pages create.lock`);
  await until("the command's lock", () => fs.existsSync(lock));
  // Quits after this call has answered (a quit that wins the race ends the WebDriver session).
  await app.browser.execute(() => {
    setTimeout(() => window.__TAURI_INTERNALS__.invoke("app_quit"), 50);
  });
  await app.browser.waitUntil(async () => /wartet auf einen Terminal-Befehl/.test((await waitingText()) ?? ""), { timeout: 10000, timeoutMsg: "no waiting hint" });
  const text = await waitingText();
  assert.match(text, /arcalo pages create/);
  assert.match(text, /spätestens um \d\d:\d\d\. Der Befehl wird nicht abgebrochen/);
  assert.doesNotMatch(text, /Aus dem Terminal/, "only the command's words, not its arguments");
  await app.shot("376-update-waits-for-command");
  const note = path.join(dir, "updates", "fake-install.json");
  await sleep(1500);
  assert.equal(fs.existsSync(note), false, "nothing installed while the command runs");
  assert.equal(cmd.exitCode, null, "the command still runs");
  // Another quit while the update waits is ignored (it would cut the install off).
  await app.browser.execute(() => window.__TAURI_INTERNALS__.invoke("app_quit"));
  await sleep(1000);
  assert.match((await waitingText()) ?? "", /wartet auf einen Terminal-Befehl/, "the app still runs and waits");
  // The window is usable meanwhile: what is typed now is stored before the install.
  await app.caretToEnd();
  await app.type(" Beim Warten getippt");

  cmd.stdin.end("Vom Agenten geschrieben\n");
  assert.equal(await exited(cmd), 0, cmd.output());
  assert.equal(JSON.parse(cmd.output()).title, "Aus dem Terminal");
  assert.equal(fs.existsSync(lock), false, "the lock goes with the command");
  await until("the install after the command", () => fs.existsSync(note));
  assert.deepEqual(JSON.parse(fs.readFileSync(note, "utf8")), { version: "1.9.0", from: "1.8.5", restart: false });
  assert.ok(fs.existsSync(path.join(dir, "backups", "arcalo-pre-update-1.8.5-1.9.0.db")), "backup after the command's write");
  await app.close();
  app = null;
  assert.match(pageText(dir, "Während des Wartens"), /Beim Warten getippt/, "the text typed during the wait was stored before the install");
});

test("an update postponed at three quits by a terminal command names it at the next start", async () => {
  const { dir } = dataFolder();
  // Three quits on Windows found `arcalo serve` still running (written as the app notes it).
  fs.mkdirSync(path.join(dir, "updates"), { recursive: true });
  fs.writeFileSync(path.join(dir, "updates", "state.json"), JSON.stringify({ postponed: { version: "1.9.0", times: 3, commands: ["arcalo serve"] } }));
  await start(dir, 60);
  assert.deepEqual((await app.invoke("update_status")).postponed, { version: "1.9.0", times: 3, commands: ["arcalo serve"] });
  // The next start of the window says it.
  await app.reload();
  await app.waitText(".toast-title", /Das Update auf 1\.9\.0 wurde schon 3-mal verschoben/);
  const detail = await app.browser.execute(() => [...document.querySelectorAll(".toast")].find((t) => /verschoben/.test(t.textContent))?.textContent ?? "");
  assert.match(detail, /arcalo serve/);
  assert.match(detail, /Beende ihn/);
  await app.close();
  app = null;
});

test("„Jetzt neu starten“ goes on after the time limit without ending the command; a crashed command's lock does not count", async () => {
  const { dir, locks } = dataFolder();
  await start(dir, 3);
  // A command that crashed: its lock file is there but nobody holds it.
  fs.mkdirSync(locks, { recursive: true });
  const stale = path.join(locks, "4000000000 tasks add.lock");
  fs.writeFileSync(stale, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(stale, old, old);
  const cmd = longCommand(dir, "Läuft lange");
  const lock = path.join(locks, `${cmd.pid} pages create.lock`);
  await until("the command's lock", () => fs.existsSync(lock));
  await app.browser.execute(() => {
    setTimeout(() => window.__TAURI_INTERNALS__.invoke("update_restart_now"), 50);
  });
  await app.browser.waitUntil(async () => /wartet auf einen Terminal-Befehl/.test((await waitingText()) ?? ""), { timeout: 10000, timeoutMsg: "no waiting hint" });
  const text = await waitingText();
  assert.doesNotMatch(text, /tasks add/, "the crashed command is not waited for");
  assert.equal(fs.existsSync(stale), false, "its lock is removed");
  const note = path.join(dir, "updates", "fake-install.json");
  await until("the install after the time limit", () => fs.existsSync(note), 15000);
  assert.deepEqual(JSON.parse(fs.readFileSync(note, "utf8")), { version: "1.9.0", from: "1.8.5", restart: true });
  await sleep(500);
  assert.equal(cmd.exitCode, null, "the command was not ended");
  assert.ok(fs.existsSync(lock), "and still holds its lock");
  cmd.stdin.end("Fertig\n");
  assert.equal(await exited(cmd), 0, cmd.output());
  await app.close();
  app = null;
});
