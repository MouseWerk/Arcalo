// The app gets the test run's own session bus also when TMPDIR is a deep folder (36-settings-layout
// starts the app below one, as deep as a real data folder). A unix socket path has at most 107
// bytes: with the bus socket below such a TMPDIR, dbus-daemon did not start, and the app went to
// the machine's bus. On CI that is a user bus whose desktop portal cannot start: the app took 25 s
// to start and froze for seconds later on, so a click on a copy button showed no feedback in time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appEnv } from "../lib/harness.js";

test("the app's session bus starts below a deep TMPDIR and answers", () => {
  const deep = path.join(os.tmpdir(), "arcalo-e2e-long", "Benutzer", "maurice.kleindienst", "AppData", "Roaming", "de.mousewerk.arcalo");
  fs.mkdirSync(deep, { recursive: true });
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = deep;
  let env;
  try {
    env = appEnv(fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-bus-")));
  } finally {
    if (tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = tmp;
  }
  const bus = env.DBUS_SESSION_BUS_ADDRESS ?? "";
  assert.ok(bus && bus !== process.env.DBUS_SESSION_BUS_ADDRESS, `no bus of its own: "${bus}"`);
  // The bus answers, and nothing but the bus itself is on it (no portal, keyring or notifications).
  const names = execFileSync("dbus-send", [`--bus=${bus}`, "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames"], { encoding: "utf8", timeout: 5000 });
  assert.match(names, /org\.freedesktop\.DBus/);
  assert.doesNotMatch(names, /portal|secrets|Notifications/);
});
