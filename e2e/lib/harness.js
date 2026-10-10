// Starts the real Arcalo desktop binary under tauri-driver and returns a
// WebdriverIO session. Each call uses a fresh, isolated data directory.

import { spawn, execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { remote } from "webdriverio";

const ROOT = path.resolve(import.meta.dirname, "../..");
// Resolved, so `pkill -f APP` also matches an app that restarted itself (it runs as its real path).
export const APP = path.resolve(process.env.ARCALO_APP ?? path.join(ROOT, "target/debug/arcalo"));
export const SHOTS = process.env.ARCALO_SHOTS ?? path.join(ROOT, "e2e/screenshots");
const DISPLAY = process.env.DISPLAY ?? ":99";

function ensureXvfb() {
  try {
    execSync(`xdpyinfo -display ${DISPLAY}`, { stdio: "ignore" });
  } catch {
    const x = spawn("Xvfb", [DISPLAY, "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], { stdio: "ignore", detached: true });
    x.unref();
    execSync("sleep 1");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A session bus of this test run's own, with no services on it. Without one the app reaches
 * whatever the machine has: on CI a user bus whose desktop portal cannot start held every start
 * for 30 s (GTK waits 25 s for the portal, the window's theme lookup 5 s more, and again for each
 * further window, which froze the app for 5 s right after it got ready), elsewhere a bus that
 * X11 autolaunches. The tests expect a desktop without keyring, portal or notification service,
 * as on a machine without a session bus. "" when there is no dbus-daemon.
 */
let busAddress = null;
function sessionBus() {
  if (busAddress !== null) return busAddress;
  busAddress = "";
  const conf = path.join(os.tmpdir(), `arcalo-e2e-bus-${process.pid}.conf`);
  try {
    fs.writeFileSync(
      conf,
      `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:tmpdir=${os.tmpdir()}</listen>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>`,
    );
    const out = execFileSync("dbus-daemon", ["--config-file", conf, "--fork", "--print-address=1", "--print-pid=1"], { encoding: "utf8", timeout: 5000 });
    const [address, pid] = out.trim().split("\n");
    process.on("exit", () => {
      try {
        process.kill(Number(pid));
      } catch {
        /* gone */
      }
    });
    busAddress = address;
  } catch {
    /* no dbus-daemon: the machine's bus, if any */
  } finally {
    fs.rmSync(conf, { force: true });
  }
  return busAddress;
}

/**
 * Programs the app would open (a web page, a folder, a file in its default program) are not
 * started: `xdg-open` is a script that appends its arguments to $ARCALO_E2E_OPENED. On CI a
 * ribbon link opened Chrome on the test display, which ran until the end of the job.
 */
let shimDir = null;
function openerShim() {
  if (shimDir) return shimDir;
  shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-open-"));
  fs.writeFileSync(path.join(shimDir, "xdg-open"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "${ARCALO_E2E_OPENED:-/dev/null}"\n', { mode: 0o755 });
  process.on("exit", () => fs.rmSync(shimDir, { recursive: true, force: true }));
  return shimDir;
}
let launches = 0;

/** Whether nothing listens on `port` (another test run's driver may share the machine). */
const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

/** A random port for tauri-driver whose native port (+1000) is free as well. */
async function driverPort() {
  for (let i = 0; i < 50; i++) {
    const port = 4444 + Math.floor(Math.random() * 500);
    if ((await portFree(port)) && (await portFree(port + 1000))) return port;
  }
  throw new Error("no free port for tauri-driver");
}

async function waitForPort(port, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/status`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`port ${port} did not open`);
}

/**
 * A timing budget in ms for the minimum of several runs: `local` on a developer machine, `ci` on CI
 * (`CI` set; the runners are slower and shared), by default 1.6 times as much.
 */
export const budget = (local, ci = Math.round(local * 1.6)) => (process.env.CI ? ci : local);

/** Wraps node:test's `test` so a failing test leaves a screenshot and the editor DOM behind. */
export function guarded(test, getApp) {
  return (name, fn) =>
    test(name, async (t) => {
      try {
        await fn(t);
      } catch (e) {
        const app = getApp();
        const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
        await app?.browser.saveScreenshot(path.join(SHOTS, `FAIL-${slug}.png`)).catch(() => {});
        const dom = await app?.browser.execute(() => document.querySelector(".ProseMirror")?.innerHTML ?? "").catch(() => "");
        if (dom) fs.writeFileSync(path.join(SHOTS, `FAIL-${slug}.html`), dom);
        throw e;
      }
    });
}

/**
 * Runs this test file (and the apps it starts) in a time zone where it is now about `hour` in the
 * morning, so meetings placed "later today" are in the future and on today's date at any hour the
 * run happens. Call before computing any local date or time.
 */
export function daytimeZone(hour = 9) {
  let offset = (((hour - new Date().getUTCHours()) % 24) + 24) % 24;
  if (offset > 14) offset -= 24;
  // Etc/GMT zones count the other way round: Etc/GMT-3 is three hours ahead of UTC.
  process.env.TZ = offset === 0 ? "Etc/UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
  return process.env.TZ;
}

/** The folder the app uses as its data folder under `home` (Linux: `$XDG_DATA_HOME/<identifier>`). */
export const homeDataDir = (home) => path.join(home, ".local", "share", "de.mousewerk.arcalo");

/**
 * The environment the app runs with on `dataDir` (also for starting it without WebDriver). With
 * `home`, the app runs as installed for a user whose home folder is `home` (no ARCALO_DATA_DIR:
 * the data, config and WebView folders are the identifier's below `home`); `dataDir` is then
 * where the app keeps its data there.
 */
export function appEnv(dataDir, { demo = true, onboarding = false, env: extraEnv = {}, home = null } = {}) {
  ensureXvfb();
  const bus = sessionBus();
  const shim = openerShim();
  return {
    ...process.env,
    DISPLAY,
    ...(bus ? { DBUS_SESSION_BUS_ADDRESS: bus } : {}),
    PATH: `${shim}${path.delimiter}${process.env.PATH ?? ""}`,
    BROWSER: path.join(shim, "xdg-open"),
    // Debug builds log when each start phase was reached (printed by `launch` when a start is slow).
    ARCALO_STARTUP_TIMING: "1",
    ...(home
      ? {
          HOME: home,
          XDG_DATA_HOME: path.join(home, ".local", "share"),
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_CACHE_HOME: path.join(home, ".cache"),
        }
      : {
          ARCALO_DATA_DIR: dataDir,
          // Isolate WebView storage (localStorage, caches) per run.
          XDG_DATA_HOME: path.join(dataDir, "xdg-data"),
          XDG_CACHE_HOME: path.join(dataDir, "xdg-cache"),
        }),
    ARCALO_STARTUP: JSON.stringify({ demo }),
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    GDK_BACKEND: "x11",
    NO_AT_BRIDGE: "1",
    // The system language the app sees (ARCALO_LOCALE stands in for it): German, as the tests expect,
    // whatever the machine running them is set to. English runs pass their own.
    ARCALO_LOCALE: "de-DE",
    // The first-run intro and the 1.6 hint only where a test asks for them (debug builds honor it).
    ...(onboarding ? {} : { ARCALO_SKIP_ONBOARDING: "1" }),
    // Extra variables of one test (e.g. ARCALO_EXE_DIR for portable mode).
    ...extraEnv,
  };
}

/**
 * Starts the app under WebDriver. `dataDir`: an existing data folder to use (kept on close),
 * else a fresh one that is removed on close. `home`: run as installed for a user with this home
 * folder (see `appEnv`); kept on close.
 */
export async function launch({ demo = true, onboarding = false, width = 1480, height = 920, env: extraEnv = {}, dataDir: chosen = null, home = null } = {}) {
  // A home folder is kept on close like a chosen data folder.
  const given = chosen ?? (home ? homeDataDir(home) : null);
  fs.mkdirSync(SHOTS, { recursive: true });
  const dataDir = given ?? fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-"));
  const port = await driverPort();
  const opened = path.join(os.tmpdir(), `arcalo-e2e-opened-${process.pid}-${++launches}.log`);
  const env = { ...appEnv(dataDir, { demo, onboarding, env: extraEnv, home }), ARCALO_E2E_OPENED: opened };
  const started = Date.now();
  const driver = spawn("tauri-driver", ["--port", String(port), "--native-port", String(port + 1000)], { env, stdio: ["ignore", "ignore", "pipe"] });
  let driverErr = "";
  driver.stderr.on("data", (d) => (driverErr += d));
  await waitForPort(port);

  const browser = await remote({
    hostname: "127.0.0.1",
    port,
    logLevel: "error",
    capabilities: { "wdio:enforceWebDriverClassic": true, "tauri:options": { application: APP } },
  });
  await browser.setWindowSize(width, height).catch(() => {});
  // Wait for the UI to be ready.
  await browser.waitUntil(async () => (await browser.execute(() => document.body.classList.contains("ready"))) === true, {
    timeout: 20000,
    timeoutMsg: "app did not become ready",
  });
  // A slow start says where the time went (the app's start-up timing in its log).
  const took = Date.now() - started;
  if (took > 10000) {
    const file = path.join(dataDir, "logs", "arcalo.log");
    const log = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
    console.log(`[e2e] the app took ${took} ms to start:\n${log.filter((l) => l.includes("[startup]")).join("\n")}`);
  }

  const app = {
    browser,
    dataDir,
    async shot(name) {
      await sleep(250);
      await browser.saveScreenshot(path.join(SHOTS, `${name}.png`));
    },
    $: (sel) => browser.$(sel),
    $$: (sel) => browser.$$(sel),
    /** Closes open toasts so they cannot cover a target. */
    async dismissToasts() {
      await browser.execute(() => document.querySelectorAll(".toast [aria-label='Schließen'], .toast [aria-label='Close']").forEach((b) => b.click()));
      await browser.pause(150);
    },
    async click(sel) {
      const el = await browser.$(sel);
      await el.waitForClickable({ timeout: 8000 });
      try {
        await el.click();
      } catch (e) {
        if (!/intercepted/.test(String(e))) throw e;
        // A toast sits over the target (as it would for a user for a few seconds): close toasts and retry.
        await browser.execute(() => document.querySelectorAll(".toast [aria-label='Schließen'], .toast [aria-label='Close']").forEach((b) => b.click()));
        await browser.pause(150);
        await el.click();
      }
      return el;
    },
    async text(sel) {
      return app.textOf(await browser.$(sel));
    },
    /** innerText via script (WebKit's getText() is empty under user-select: none). */
    async textOf(el) {
      return (await browser.execute((e) => e.innerText, el)).trim();
    },
    async keys(k) {
      await browser.keys(k);
    },
    async type(text) {
      for (const ch of text) await browser.keys(ch);
    },
    /** Invokes a Tauri command directly (for setup and assertions). */
    async invoke(cmd, args = {}) {
      return browser.executeAsync(
        (c, a, done) => window.__TAURI_INTERNALS__.invoke(c, a).then((r) => done({ ok: r }), (e) => done({ err: String(e) })),
        cmd,
        args,
      ).then((r) => {
        if (r.err) throw new Error(r.err);
        return r.ok;
      });
    },
    /** Puts the caret on a fresh empty line at the end of the open note. */
    async caretToEnd() {
      const pm = await app.waitFor(".ProseMirror");
      await pm.click();
      await browser.execute(() => {
        const el = document.querySelector(".ProseMirror");
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el.lastElementChild ?? el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      });
      await browser.pause(60);
      await browser.keys(["End"]);
    },
    /**
     * Chooses `value` in a dropdown (components/Select.tsx) like a user: clicks the combobox,
     * then the option in the list it opened, and waits until the combobox shows the value.
     */
    async select(sel, value) {
      const trigger = await browser.$(sel);
      await trigger.waitForClickable({ timeout: 8000 });
      await trigger.click();
      const list = await browser.waitUntil(async () => browser.execute((s) => document.querySelector(s)?.getAttribute("aria-controls"), sel), {
        timeout: 4000,
        timeoutMsg: `${sel} did not open`,
      });
      // Options that load later (templates, server models) appear in the open list.
      const option = await browser.$(`#${list} [role="option"][data-value="${value}"]`);
      if (!(await option.waitForExist({ timeout: 4000 }).catch(() => false))) {
        await browser.keys(["Escape"]);
        throw new Error(`cannot select ${value} in ${sel}`);
      }
      // Long lists scroll inside the popup; WebDriver does not scroll it by itself.
      await browser.execute((el) => el.scrollIntoView({ block: "nearest" }), option);
      await option.click();
      await browser.waitUntil(async () => (await browser.execute((s) => document.querySelector(s)?.dataset.value, sel)) === value, {
        timeout: 4000,
        timeoutMsg: `${sel} does not show ${value}`,
      });
    },
    async waitFor(sel, timeout = 8000) {
      // A view that re-renders can replace the element between the lookup and the check; look it up again then.
      await browser.waitUntil(
        async () => {
          try {
            return await (await browser.$(sel)).isDisplayed();
          } catch (e) {
            if (/stale element/i.test(String(e?.message ?? e))) return false;
            throw e;
          }
        },
        { timeout, timeoutMsg: `${sel} not displayed after ${timeout}ms` },
      );
      return browser.$(sel);
    },
    async waitText(sel, pattern, timeout = 8000) {
      await browser.waitUntil(async () => {
        const els = await browser.$$(sel);
        for (const e of els) if (pattern.test(await app.textOf(e))) return true;
        return false;
      }, { timeout, timeoutMsg: `no ${sel} matching ${pattern}` });
    },
    /** What the app handed to `xdg-open` so far (links, files and folders it would open elsewhere). */
    opened() {
      return fs.existsSync(opened) ? fs.readFileSync(opened, "utf8").split("\n").filter(Boolean) : [];
    },
    async consoleErrors() {
      return browser.execute(() => window.__arcaloErrors ?? []);
    },
    async close() {
      await browser.deleteSession().catch(() => {});
      driver.kill("SIGTERM");
      await sleep(300);
      try {
        execSync(`pkill -f "${APP}"`, { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      // Helpers the app started (xdg-open, WebKit caches) may still write for a moment.
      if (!given) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      const handed = app.opened();
      if (handed.length) console.log(`[e2e] handed to xdg-open, not started: ${handed.join(", ")}`);
      fs.rmSync(opened, { force: true });
      if (driverErr.includes("panicked")) throw new Error(driverErr);
    },
  };
  return app;
}
