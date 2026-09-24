// Starts the real Annalo desktop binary under tauri-driver and returns a
// WebdriverIO session. Each call uses a fresh, isolated data directory.

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { remote } from "webdriverio";

const ROOT = path.resolve(import.meta.dirname, "../..");
export const APP = process.env.ANNALO_APP ?? path.join(ROOT, "target/debug/annalo");
export const SHOTS = process.env.ANNALO_SHOTS ?? path.join(ROOT, "e2e/screenshots");
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

export async function launch({ demo = true, width = 1480, height = 920, env: extraEnv = {} } = {}) {
  ensureXvfb();
  fs.mkdirSync(SHOTS, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-"));
  const port = 4444 + Math.floor(Math.random() * 500);
  const env = {
    ...process.env,
    DISPLAY,
    ANNALO_DATA_DIR: dataDir,
    // Isolate WebView storage (localStorage, caches) per run.
    XDG_DATA_HOME: path.join(dataDir, "xdg-data"),
    XDG_CACHE_HOME: path.join(dataDir, "xdg-cache"),
    ANNALO_STARTUP: JSON.stringify({ demo }),
    WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    GDK_BACKEND: "x11",
    NO_AT_BRIDGE: "1",
    // Extra variables of one test (e.g. ANNALO_EXE_DIR for portable mode).
    ...extraEnv,
  };
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
      await browser.execute(() => document.querySelectorAll(".toast [aria-label='Schließen']").forEach((b) => b.click()));
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
        await browser.execute(() => document.querySelectorAll(".toast [aria-label='Schließen']").forEach((b) => b.click()));
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
      const el = await browser.$(sel);
      await el.waitForDisplayed({ timeout });
      return el;
    },
    async waitText(sel, pattern, timeout = 8000) {
      await browser.waitUntil(async () => {
        const els = await browser.$$(sel);
        for (const e of els) if (pattern.test(await app.textOf(e))) return true;
        return false;
      }, { timeout, timeoutMsg: `no ${sel} matching ${pattern}` });
    },
    async consoleErrors() {
      return browser.execute(() => window.__annaloErrors ?? []);
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
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      if (driverErr.includes("panicked")) throw new Error(driverErr);
    },
  };
  return app;
}
