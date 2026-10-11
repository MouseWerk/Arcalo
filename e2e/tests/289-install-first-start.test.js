// The first start after an installation, as installed (no ARCALO_DATA_DIR, a home folder of its
// own): an empty profile gets the intro and the setup once, the folders of the identifier and
// nothing else; the next start goes straight to the app. A home folder that does not exist yet is
// created; one where the data folder cannot be created ends with the recovery dialog (answered
// by the test) and exit code 1, not a crash. Folders of other programs next to Arcalo's, also
// ones named like Annalo, stay as they are (the 1.17 cleanup only takes the old identifier's).
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, appEnv, launch, guarded, homeDataDir } from "../lib/harness.js";

let app;
const test = guarded(nodeTest, () => app);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dirs = [];
const tmp = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `arcalo-e2e-289-${name}-`));
  dirs.push(d);
  return d;
};
const ID = "de.mousewerk.arcalo";
// The cleanup of the old identifier's folders runs a second after the start (default: 10 s).
const ENV = { ARCALO_SECRET_STORE: "file", ARCALO_BACKUP_DELAY_SECS: "3600", ARCALO_CLEANUP_DELAY_SECS: "1" };
const killApp = () => {
  try {
    execSync(`pkill -f "${APP}"`, { stdio: "ignore" });
  } catch {
    /* none running */
  }
};
const overlay = () => app.browser.execute(() => !!document.querySelector(".fr-overlay"));
/** Every file and folder below `dir` (relative), sorted. */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      out.push(e.isDirectory() ? `${r}/` : `${r} ${fs.readFileSync(path.join(d, e.name), "utf8")}`);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, "");
  return out.sort();
}

after(async () => {
  await app?.close();
  killApp();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// A home folder with other programs' folders next to where Arcalo's go.
const home = tmp("home");
const share = path.join(home, ".local", "share");
const config = path.join(home, ".config");
const neighbors = [
  [share, "Annalo/notes.md", "eigene Notizen"],
  [share, "annalo/keep.txt", "fremd"],
  [share, "app.annalo.desktop-backup/workspace.db", "keine Datenbank"],
  [share, "de.mousewerk.other/data.txt", "anderes Programm"],
  [config, "annalo/settings.json", "{}"],
  [config, "Arcalo-Vorlagen/vorlage.md", "# Vorlage"],
];
for (const [base, rel, text] of neighbors) {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), text);
}
const before = { share: tree(share), config: tree(config) };

test("an empty profile: the intro and the setup, then the app", async () => {
  app = await launch({ demo: false, onboarding: true, home, env: ENV });
  await app.waitFor(".fr-intro", 10000);
  await app.keys(["Escape"]);
  await app.browser.waitUntil(overlay, { timeout: 8000, timeoutMsg: "setup not shown after the intro" });
  await app.click('.fr-rail-item[data-step="workspace"]');
  await app.click('[data-choice="empty"]');
  await app.browser.waitUntil(async () => (await app.invoke("onboarding_needed")) === false, { timeoutMsg: "the start choice not saved" });
  await app.click('.fr-rail-item[data-step="done"]');
  await app.click(".fr-next");
  await app.browser.waitUntil(async () => !(await overlay()), { timeoutMsg: "setup still open" });
  // The data and config folders of the identifier, under this home folder.
  assert.ok(fs.existsSync(path.join(homeDataDir(home), "workspace.db")), "workspace.db in the data folder");
  assert.ok(fs.existsSync(path.join(config, ID)), "config folder");
  assert.deepEqual(await app.consoleErrors(), []);
});

test("the next start goes straight to the app; the neighbors' folders are untouched", async () => {
  await app.close();
  app = await launch({ onboarding: true, home, env: ENV });
  await app.browser.pause(1500);
  assert.equal(await overlay(), false, "setup shown again");
  assert.equal(await app.browser.execute(() => !!document.querySelector(".fr-intro")), false, "intro shown again");
  assert.equal(await app.invoke("onboarding_needed"), false);
  // Past the cleanup's delay: nothing of the old identifier was there, nothing else goes.
  await sleep(2500);
  const isOurs = (e) => e.startsWith(`${ID}/`) || e.startsWith(`${ID} `);
  assert.deepEqual(tree(share).filter((e) => !isOurs(e)), before.share);
  assert.deepEqual(tree(config).filter((e) => !isOurs(e)), before.config);
  for (const base of [share, config, path.join(home, ".cache")]) {
    assert.equal(fs.existsSync(path.join(base, "app.annalo.desktop")), false, `no folder of the old identifier in ${base}`);
  }
});

test("a home folder that does not exist yet is created", async () => {
  await app.close();
  app = null;
  const fresh = path.join(tmp("missing"), "noch", "nicht", "da");
  app = await launch({ demo: false, home: fresh, env: ENV });
  assert.ok(fs.existsSync(path.join(homeDataDir(fresh), "workspace.db")));
  await app.close();
  app = null;
});

test("a data folder that cannot be created: the recovery dialog, exit code 1, no crash", async () => {
  const blocked = tmp("blocked");
  // `.local` is a file: no folder can be made below it (root ignores permissions, files it cannot).
  fs.writeFileSync(path.join(blocked, ".local"), "kein Ordner");
  const env = appEnv(homeDataDir(blocked), { demo: false, home: blocked, env: { ...ENV, ARCALO_TEST_RECOVERY_CHOICE: "quit" } });
  let stderr = "";
  const child = spawn(APP, [], { env, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (d) => (stderr += d));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 30000);
    child.on("exit", (c, signal) => {
      clearTimeout(timer);
      resolve(c ?? signal);
    });
  });
  if (code === "timeout") child.kill();
  assert.equal(code, 1, `exit code (stderr: ${stderr.slice(-1500)})`);
  assert.doesNotMatch(stderr, /panicked/);
  // The log cannot be written there: what it says goes to stderr.
  assert.match(stderr, /recovery dialog answered by the test: Quit/);
  assert.equal(fs.readFileSync(path.join(blocked, ".local"), "utf8"), "kein Ordner");
});
