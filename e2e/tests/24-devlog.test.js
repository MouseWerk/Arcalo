// Developer log: command and UI errors land in logs/annalo.log; Settings → Protokoll lists,
// filters and clears them; the About page links to it.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const openSection = async (id) => {
  await app.dismissToasts();
  const onSettings = await app.browser.execute(() => !!document.querySelector(".settings-nav"));
  if (!onSettings) await app.keys(["Control", ","]);
  await app.click(`.settings-nav-item[data-section="${id}"]`);
};
const clickText = async (sel, text) => {
  for (const el of await app.$$(sel)) if ((await app.textOf(el)) === text) return el.click();
  throw new Error(`no ${sel} with text ${text}`);
};
const levels = () => app.browser.execute(() => [...document.querySelectorAll(".devlog-entry .badge")].map((b) => b.textContent));

test("errors from commands and the UI are written to the log, credentials redacted", async () => {
  const entries = await app.invoke("devlog_read", { limit: 50 });
  assert.ok(entries.some((e) => e.level === "INFO" && e.source === "core" && /started/.test(e.message)), "startup line");
  // A failing command is logged centrally.
  await assert.rejects(app.invoke("git_sync_now"));
  await app.invoke("devlog_write", { level: "ERROR", source: "ui", message: "E2E Testfehler 4711 token=geheim123" });
  await app.invoke("devlog_write", { level: "WARN", source: "ui", message: "E2E Warnung 4712" });
  // console.error in the page is forwarded (throttled, asynchronous).
  await app.browser.execute(() => console.error("E2E Konsole 4713"));
  await app.browser.waitUntil(async () => (await app.invoke("devlog_read", { limit: 50 })).some((e) => /E2E Konsole 4713/.test(e.message)), {
    timeoutMsg: "console.error not forwarded",
  });
  const after = await app.invoke("devlog_read", { limit: 50 });
  assert.ok(after.some((e) => e.level === "ERROR" && e.source === "core" && /Remote-URL/.test(e.message)), "command error");
  const mine = after.find((e) => /4711/.test(e.message));
  assert.equal(mine.message, "E2E Testfehler 4711 token=***");
  assert.equal(after[0].message.includes("4713"), true, "newest first");
  // The same text again within 10 s is not repeated.
  await app.invoke("devlog_write", { level: "WARN", source: "ui", message: "E2E Warnung 4712" });
  assert.equal((await app.invoke("devlog_read", { limit: 50 })).filter((e) => /4712/.test(e.message)).length, 1);
  const file = fs.readFileSync(path.join(app.dataDir, "logs", "annalo.log"), "utf8");
  assert.ok(!file.includes("geheim123"));
  assert.match(file, /^\S+T\S+ ERROR \[ui\] E2E Testfehler 4711/m);
});

test("Settings → Protokoll lists, filters and refreshes the entries", async () => {
  await openSection("logs");
  await app.waitText(".settings-head h1", /Protokoll/);
  await app.waitText(".devlog-message", /E2E Testfehler 4711/);
  assert.ok((await levels()).includes("WARN"));
  // Fehler
  await app.click('.devlog-toolbar .segmented [role="radio"]:nth-child(2)');
  await app.browser.waitUntil(async () => (await levels()).every((l) => l === "ERROR") && (await levels()).length > 0, { timeoutMsg: "error filter" });
  await app.shot("settings-devlog");
  // Warnungen
  await app.click('.devlog-toolbar .segmented [role="radio"]:nth-child(3)');
  await app.browser.waitUntil(async () => (await levels()).length > 0 && (await levels()).every((l) => l === "WARN"), { timeoutMsg: "warning filter" });
  await app.waitText(".devlog-message", /E2E Warnung 4712/);
  // Alle, after a new entry and „Aktualisieren“.
  await app.click('.devlog-toolbar .segmented [role="radio"]:nth-child(1)');
  await app.invoke("devlog_write", { level: "INFO", source: "ui", message: "E2E Nachtrag 4714" });
  await clickText(".devlog-actions .btn", "Aktualisieren");
  await app.waitText(".devlog-message", /E2E Nachtrag 4714/);
  // Long messages wrap inside the pane.
  const overflow = await app.browser.execute(() => {
    const s = document.querySelector(".settings-scroll");
    return s.scrollWidth - s.clientWidth;
  });
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}`);
  // Narrow pane (~350 px): toolbar and entries wrap instead of overflowing.
  await app.browser.setWindowSize(1160, 920);
  await app.browser.pause(300);
  const narrow = await app.browser.execute(() => {
    const s = document.querySelector(".settings-scroll");
    // The body's implicit grid column grows with its widest content; pinned here so only
    // this section's own content counts.
    document.querySelector(".settings-body").style.gridTemplateColumns = "minmax(0, 1fr)";
    const right = s.getBoundingClientRect().right;
    // The widest offenders, for the failure message.
    const wide = [...s.querySelectorAll("*")]
      .filter((e) => e.getBoundingClientRect().right > right + 1)
      .slice(0, 6)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join(".")} ${Math.round(e.getBoundingClientRect().width)}`);
    return { width: s.clientWidth, overflow: s.scrollWidth - s.clientWidth, wide };
  });
  await app.shot("settings-devlog-narrow");
  await app.browser.execute(() => (document.querySelector(".settings-body").style.gridTemplateColumns = ""));
  await app.browser.setWindowSize(1480, 920);
  assert.ok(narrow.overflow <= 1, `narrow overflow ${narrow.overflow} at ${narrow.width}px: ${narrow.wide.join(", ")}`);
});

test("About shows the error count and opens the log section", async () => {
  await openSection("about");
  await app.waitText(".set-row-label", /Entwicklerprotokoll/);
  await app.waitText(".devlog-about .badge", /\d+ Fehler in 7 Tagen/);
  await clickText(".devlog-about .btn", "Protokoll anzeigen");
  await app.waitText(".settings-head h1", /Protokoll/);
  await app.waitText(".devlog-message", /E2E Testfehler 4711/);
});

test("clearing asks first and leaves an empty state", async () => {
  await openSection("logs");
  await app.waitFor(".devlog-list");
  await clickText(".devlog-actions .btn", "Leeren");
  await app.waitFor(".dialog");
  await app.click(".dialog .btn-danger");
  await app.waitText(".devlog-empty", /Keine Einträge/);
  assert.deepEqual(await app.invoke("devlog_read", { limit: 10 }), []);
  assert.ok(!fs.existsSync(path.join(app.dataDir, "logs", "annalo.log")));
});
