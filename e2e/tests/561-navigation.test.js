// q124 R3C-4: a link that is not handled by the app (a link in a page preview, release notes,
// rendered HTML) or a script-free redirect navigated the app's window itself to the web page.
// The page then ran in the app's window, with the app's command interface (every page, every
// setting) next to it. Now the windows stay on the app: other addresses open in the browser.

import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app, server;
const PORT = 4878;
const reports = [];
const hits = [];
const openLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-nav-")), "opened.log");

// The page a link leads to: it tries the app's commands and reports what it got.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Fremd</title><script>
const report = (r) => fetch("/report", { method: "POST", body: JSON.stringify(r) });
const ipc = window.__TAURI_INTERNALS__;
if (!ipc) report({ ipc: false });
else ipc.invoke("settings_get").then((v) => report({ ipc: true, ok: true, keys: Object.keys(v || {}) }), (e) => report({ ipc: true, ok: false, error: String(e) }));
</script><p>Fremde Seite</p>`;

before(async () => {
  server = http.createServer(async (req, res) => {
    hits.push(req.url);
    if (req.url === "/report") {
      let body = "";
      for await (const c of req) body += c;
      reports.push(JSON.parse(body));
      res.writeHead(204, { "access-control-allow-origin": "*" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  app = await launch({ env: { ARCALO_TEST_OPEN_LOG: openLog } });
});
after(async () => {
  await app?.close();
  await new Promise((r) => server?.close(r));
  fs.rmSync(path.dirname(openLog), { recursive: true, force: true });
});

const opened = () => (fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf8") : "");
const onApp = () => app.browser.execute(() => location.protocol !== "http:" || location.hostname.endsWith("localhost") ? document.body.classList.contains("ready") : false);

test("a plain link to a web page opens in the browser, the window stays on the app", async () => {
  const url = `http://127.0.0.1:${PORT}/link.html`;
  await app.browser.execute((u) => {
    const a = document.createElement("a");
    a.href = u;
    a.textContent = "Link";
    document.body.append(a);
    a.click();
  }, url);
  await app.browser.waitUntil(async () => opened().includes(url), { timeout: 10000, timeoutMsg: `not opened in the browser: ${opened()}` });
  assert.equal(await onApp(), true, "the window left the app");
  assert.deepEqual(reports, [], "the web page ran in the app's window");
  assert.deepEqual(hits, [], "the web page was loaded by the app's window");
});

test("a redirect of the window itself is refused as well", async () => {
  const url = `http://127.0.0.1:${PORT}/redirect.html`;
  await app.browser.execute((u) => void (location.href = u), url);
  await app.browser.waitUntil(async () => opened().includes(url), { timeout: 10000, timeoutMsg: `not opened in the browser: ${opened()}` });
  assert.equal(await onApp(), true, "the window left the app");
  assert.deepEqual(reports, [], JSON.stringify(reports));
  assert.deepEqual(await app.consoleErrors(), []);
});
