// Two processes on one workspace would overwrite each other's edits. The single-instance plugin
// needs a session bus on Linux; without one the lock on a file in the data folder stops the
// second start (1.16). The app runs as installed (no ARCALO_DATA_DIR), without WebDriver.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP, appEnv, homeDataDir } from "../lib/harness.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-301-home-"));
const data = homeDataDir(home);
const running = [];

const killApp = () => {
  try {
    execSync(`pkill -f "${APP}"`, { stdio: "ignore" });
  } catch {
    /* none running */
  }
};

/** Starts the app as installed for `home`, without a session bus. */
function start() {
  const env = { ...appEnv(data, { demo: false, home }), ARCALO_TEST_NO_DIALOG: "1", ARCALO_BACKUP_DELAY_SECS: "3600" };
  // No reachable session bus: the single-instance plugin cannot see the first process.
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(home, "no-bus")}`;
  const child = spawn(APP, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const proc = { child, output: () => out, exited: null };
  child.on("exit", (code) => (proc.exited = code ?? -1));
  running.push(proc);
  return proc;
}

async function until(what, fn, timeout = 40000) {
  const begun = Date.now();
  while (Date.now() - begun < timeout) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error(`timed out: ${what}`);
}

after(() => {
  for (const p of running) if (p.exited === null) p.child.kill("SIGKILL");
  killApp();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test("a second start on the same data folder ends without a session bus; the first keeps running", async () => {
  killApp();
  await sleep(500);
  const first = start();
  await until("the first process opened its workspace", () => fs.existsSync(path.join(data, "workspace.db")) && fs.existsSync(path.join(data, ".arcalo.lock")));
  await sleep(1500);
  assert.equal(first.exited, null, first.output());

  const second = start();
  await until("the second process ended", () => second.exited !== null, 30000);
  assert.equal(second.exited, 0);
  assert.match(second.output(), /läuft bereits mit dem Datenordner/);
  await sleep(1000);
  assert.equal(first.exited, null, "the first one still runs");

  // Once the first has ended, the next start runs.
  first.child.kill("SIGTERM");
  await until("the first process ended", () => first.exited !== null, 15000);
  const third = start();
  await sleep(6000);
  assert.equal(third.exited, null, third.output());
  third.child.kill("SIGTERM");
  await until("the third process ended", () => third.exited !== null, 15000);
});
