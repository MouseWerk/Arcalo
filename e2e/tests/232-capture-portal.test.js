// Quick capture on a Linux desktop whose desktop portal hangs (1.12): creating a window reads the
// color scheme from the portal on the main thread. The capture window used to be created 1.5 s
// after the start and froze the app right when it got ready; now the portal is asked first, off
// the main thread, and the window waits for idle time or its first use. On a normal desktop it is
// still prepared at the start (68 measures that open), created on first use it takes longer.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";
import { captureVisible, openCapture } from "../lib/capture.js";

let app;
const test = guarded(nodeTest, () => app);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-portal-"));
let busPid = null;

/** A session bus whose desktop portal is activatable but never starts (activation gives up after 1.5 s). */
function hangingPortalBus() {
  const services = path.join(root, "services");
  fs.mkdirSync(services);
  fs.writeFileSync(path.join(services, "portal.service"), "[D-BUS Service]\nName=org.freedesktop.portal.Desktop\nExec=/bin/sleep 20\n");
  const conf = path.join(root, "bus.conf");
  fs.writeFileSync(
    conf,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:tmpdir=${root}</listen><servicedir>${services}</servicedir>
<limit name="service_start_timeout">1500</limit>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>`,
  );
  const out = execFileSync("dbus-daemon", ["--config-file", conf, "--fork", "--print-address=1", "--print-pid=1"], { encoding: "utf8", timeout: 5000 });
  const [address, pid] = out.trim().split("\n");
  busPid = Number(pid);
  return address;
}

after(async () => {
  await app?.close();
  if (busPid) {
    try {
      process.kill(busPid);
    } catch {
      /* gone */
    }
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const log = () => fs.readFileSync(path.join(app.dataDir, "logs", "arcalo.log"), "utf8");

test("with a hanging portal the app does not freeze after the start; capture opens on first use", async () => {
  app = await launch({ env: { DBUS_SESSION_BUS_ADDRESS: hangingPortalBus() } });
  // The first seconds after the start, when the capture window used to be built: the main
  // thread answers (a synchronous command runs there).
  const waits = [];
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const t0 = Date.now();
    await app.invoke("desktop_info");
    waits.push(Date.now() - t0);
    await app.browser.pause(100);
  }
  console.log(`main thread answers after the start (ms): max ${Math.max(...waits)} of ${waits.length}`);
  assert.ok(Math.max(...waits) < 1000, `the main thread was blocked for ${Math.max(...waits)} ms`);
  assert.match(log(), /desktop portal does not answer: quick capture window prepared when idle/);

  // Asked for before the idle time: created now, it opens all the same.
  const w = await openCapture(app);
  assert.equal(await captureVisible(app), true);
  await app.browser.waitUntil(async () => (await app.invoke("desktop_info")).capture_open_ms != null, { timeoutMsg: "no open time" });
  console.log(`first capture open with a hanging portal (ms): ${(await app.invoke("desktop_info")).capture_open_ms}`);
  await app.keys(["Escape"]);
  await w.toMain();
});

test("on a desktop without that problem the window is prepared; created on first use it takes longer", async () => {
  await app.close();
  app = await launch();
  // Right after the start, before it is prepared: created on demand.
  await openCapture(app).then((w) => w.toMain());
  await app.browser.waitUntil(async () => (await app.invoke("desktop_info")).capture_open_ms != null, { timeoutMsg: "no open time" });
  const lazy = (await app.invoke("desktop_info")).capture_open_ms;
  console.log(`capture created on first use (ms): ${lazy}`);
  assert.doesNotMatch(log(), /desktop portal does not answer/);
});
