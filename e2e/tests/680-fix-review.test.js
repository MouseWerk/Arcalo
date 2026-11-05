// Round 5 review of the round 1 to 4 fixes (docs/quality/q124/r5-fix-review.md): what two fixes
// do together, and the paths a fix did not reach.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launch, guarded, APP } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
const run = promisify(execFile);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

/** Runs the app's program as the command line on the app's workspace. */
const cli = (...args) =>
  run(APP, ["--json", ...args], {
    env: { ...process.env, ARCALO_DATA_DIR: app.dataDir, ARCALO_LOCALE: "de-DE" },
    encoding: "utf8",
    timeout: 30000,
  });

/** A command answered within `ms`, or an error naming it (a hung app never answers). */
const answers = (cmd, ms) =>
  Promise.race([
    app.invoke(cmd),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${cmd} had no answer after ${ms} ms: the app hangs`)), ms)),
  ]);

// R5D-1: a settings write taken over in the background (the command line here, a settings sync
// in the same way) changed a shortcut while holding the settings write lock, and the shortcut is
// registered on the main thread. A settings write from the window waited for that lock on the
// main thread meanwhile: neither went on, and the app hung for good.
test("the app keeps answering when the command line changes a shortcut while the window stores a key", async () => {
  // The window stores keys without a pause (as the AI settings do when a key is pasted and taken
  // back), each on the main thread and as a settings write; none changes the settings, so each
  // shortcut of the command line is taken over.
  await app.browser.execute(() => {
    window.__r5dSaving = true;
    window.__r5dSaves = 0;
    (async () => {
      while (window.__r5dSaving) {
        await window.__TAURI_INTERNALS__.invoke("api_key_set", { key: null }).catch(() => {});
        window.__r5dSaves++;
      }
    })();
  });
  try {
    for (let i = 0; i < 16; i++) {
      const shortcut = i % 2 ? "Ctrl+Shift+Space" : "Ctrl+Alt+Shift+K";
      await cli("settings", "set", "capture_shortcut", shortcut);
      await app.browser.waitUntil(async () => (await answers("settings_get", 15000)).settings.capture_shortcut === shortcut, {
        timeout: 15000,
        timeoutMsg: `round ${i}: the app did not take over the shortcut of the command line`,
      });
    }
  } finally {
    // A hung app runs no script either: the stop is not waited for then.
    await Promise.race([app.browser.execute(() => (window.__r5dSaving = false)), new Promise((r) => setTimeout(r, 3000))]);
  }
  assert.ok((await app.browser.execute(() => window.__r5dSaves)) > 16, "the window stored keys meanwhile");
  assert.equal((await answers("settings_get", 5000)).settings.capture_shortcut, "Ctrl+Shift+Space");
});
