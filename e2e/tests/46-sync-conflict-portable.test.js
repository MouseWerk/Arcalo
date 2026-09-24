// Git sync with a second computer (a clone of a local bare repository): notes the server changed
// are taken over, a note changed on both sides becomes a conflict („Konflikt“) with both versions
// kept, the conflict view merges it block by block and „Übernehmen“ saves and syncs the result.
// Then portable mode: a marker next to the executable keeps the data in `<exe dir>/data`, with
// autostart, moving the data folder and self-installing updates switched off.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
let base;
let bare;
let other;
before(async () => {
  app = await launch();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-conflict-"));
  bare = path.join(base, "notizen.git");
  other = path.join(base, "anderer-rechner");
  execFileSync("git", ["init", "-q", "--bare", bare]);
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=Anderer", "-c", "user.email=anderer@example.com", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const pageId = async (title) => (await app.invoke("page_resolve", { title, create: false })).id;
const content = async (title) => (await app.invoke("page_get", { id: await pageId(title) })).content;
const save = async (title, text) => app.invoke("page_save", { id: await pageId(title), content: text });
const fileOf = (name) => git(bare, "ls-tree", "-r", "--name-only", "main").split("\n").find((f) => path.posix.basename(f) === name);

const BASE = "# Architektur\n\nGemeinsamer Absatz.\n\nZweiter Absatz.\n";

async function openByPalette(text) {
  await app.keys(["Control", "k"]);
  const input = await app.waitFor(".palette input");
  await input.setValue(text);
  await app.waitText(".pal-item.sel", new RegExp(text));
  await app.keys(["Enter"]);
}

test("a note changed here and on the server becomes a conflict; the rest is taken over", async () => {
  await save("Architektur", BASE);
  await save("Jour fixe 22.09.", "Protokoll: alt\n");
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, git_sync: { ...view.settings.git_sync, enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com" } } });
  const first = await app.invoke("git_sync_now");
  assert.equal(first.committed, true, JSON.stringify(first));

  // The other computer edits the same paragraph, adds a paragraph and changes another note.
  git(base, "clone", "-q", "-b", "main", bare, other);
  const arch = fileOf("Architektur.md");
  const jf = fileOf("Jour fixe 22.09.md");
  assert.ok(arch && jf, "notes in the repository");
  fs.writeFileSync(path.join(other, arch), "# Architektur\n\nGemeinsamer Absatz, vom anderen Rechner.\n\nZweiter Absatz.\n\nErgänzung vom anderen Rechner.\n");
  fs.writeFileSync(path.join(other, jf), "Protokoll: vom anderen Rechner\n");
  git(other, "commit", "-q", "-am", "Anderer Rechner");
  git(other, "push", "-q", "origin", "main");

  // Here the same paragraph changes differently.
  await save("Architektur", "# Architektur\n\nGemeinsamer Absatz, hier geändert.\n\nZweiter Absatz.\n");
  const out = await app.invoke("git_sync_now");
  assert.equal(out.fallback, false, JSON.stringify(out));
  assert.match(out.message, /1 Notiz wurde hier und auf dem Server geändert/);

  // Taken over: the note only the server changed. Kept: this computer's version of the conflict.
  await app.browser.waitUntil(async () => (await content("Jour fixe 22.09.")) === "Protokoll: vom anderen Rechner\n", { timeout: 8000, timeoutMsg: "server change not taken over" });
  assert.equal(await content("Architektur"), "# Architektur\n\nGemeinsamer Absatz, hier geändert.\n\nZweiter Absatz.\n");
  const conflicts = await app.invoke("git_conflicts");
  assert.deepEqual(conflicts.map((c) => [c.title, c.path]), [["Architektur", arch]]);
  // Nothing is lost on the server either: it keeps its version until the merge.
  assert.match(git(bare, "show", `main:${arch}`), /vom anderen Rechner/);
  assert.equal(git(bare, "rev-list", "--count", "--merges", "main").trim(), "1");

  // The notice, the mark in the sidebar and the banner on the page.
  await app.waitText(".toast-title", /Konflikt bei der Git-Synchronisierung/);
  await app.waitText(".toast-detail", /„Architektur“ wurde hier und auf einem anderen Rechner geändert/);
  await app.waitFor(`.tree-row[data-id="${await pageId("Architektur")}"] .tree-conflict`);
  await app.dismissToasts();
  await openByPalette("Architektur");
  await app.waitText(".pane.active .cf-banner", /Konflikt/);
  await app.shot("sync-conflict-banner");

  // A second sync before merging leaves the server's version alone.
  const again = await app.invoke("git_sync_now");
  assert.equal(again.fallback, false);
  assert.match(git(bare, "show", `main:${arch}`), /vom anderen Rechner/);
});

test("the conflict view shows both versions by block; „Übernehmen“ saves and syncs the result", async () => {
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .cf-banner button")].find((b) => b.textContent.includes("Zusammenführen")).click());
  await app.waitFor(".cf-view .cf-conflict", 10000);
  await app.waitText(".tab.active .tab-title", /Konflikt: Architektur/);
  assert.equal((await app.$$(".cf-conflict")).length, 1, "one conflicting block");
  await app.waitText(".cf-side-mine .cf-lines", /Gemeinsamer Absatz, hier geändert\./);
  await app.waitText(".cf-side-theirs .cf-lines", /Gemeinsamer Absatz, vom anderen Rechner\./);
  // The server's new paragraph merged by itself; unchanged blocks are shown muted.
  await app.waitText(".cf-auto", /Automatisch vom Server übernommen[\s\S]*Ergänzung vom anderen Rechner/);
  await app.waitText(".cf-progress", /0 von 1 Stelle entschieden/);
  assert.equal(await app.browser.execute(() => document.querySelector(".cf-foot .btn-primary").disabled), true, "undecided: nothing to apply");
  await app.shot("sync-conflict-view");

  // „Beide“, then own text for the block.
  await app.browser.execute(() => [...document.querySelectorAll(".cf-choice")].find((b) => b.textContent.trim() === "Beide").click());
  await app.waitText(".cf-progress", /1 von 1 Stelle entschieden/);
  await app.browser.execute(() => [...document.querySelectorAll(".cf-choice")].find((b) => b.textContent.includes("Bearbeiten")).click());
  const edit = await app.waitFor(".cf-edit");
  assert.equal(await edit.getValue(), "Gemeinsamer Absatz, hier geändert.\n\nGemeinsamer Absatz, vom anderen Rechner.\n\n");
  await edit.setValue("Gemeinsamer Absatz, zusammengeführt.\n\n");
  await app.click(".cf-foot .btn-primary");
  await app.waitText(".toast-title", /Konflikt gelöst/, 15000);

  const merged = "# Architektur\n\nGemeinsamer Absatz, zusammengeführt.\n\nZweiter Absatz.\n\nErgänzung vom anderen Rechner.\n";
  assert.equal(await content("Architektur"), merged);
  assert.deepEqual(await app.invoke("git_conflicts"), []);
  // The sync after „Übernehmen“ brought the result to the server.
  assert.equal(git(bare, "show", `main:${fileOf("Architektur.md")}`), merged);
  // The previous content stays as a version.
  const versions = await app.invoke("page_versions", { pageId: await pageId("Architektur") });
  assert.ok((await Promise.all(versions.map((v) => app.invoke("page_version_content", { versionId: v.id })))).some((c) => c.includes("hier geändert")));
  // The tab shows the page again, without banner or mark.
  await app.waitText(".tab.active .tab-title", /^Architektur$/);
  await app.browser.waitUntil(async () => (await app.$$(".pane.active .cf-banner")).length === 0 && (await app.$$(".tree-conflict")).length === 0, { timeoutMsg: "conflict marks remain" });
  await app.waitText(".pane.active .ProseMirror", /zusammengeführt/);

  // The other computer pulls the merge cleanly.
  git(other, "pull", "-q", "--no-rebase", "origin", "main");
  assert.equal(fs.readFileSync(path.join(other, fileOf("Architektur.md")), "utf8"), merged);
  assert.deepEqual(await app.consoleErrors(), []);
});

test("portable mode: data next to the executable, no autostart, no data move, updates by hand", async () => {
  await app.close();
  app = null;
  const stick = path.join(base, "USB-Stick");
  fs.mkdirSync(stick, { recursive: true });
  fs.writeFileSync(path.join(stick, "annalo-portable"), "");
  // ANNALO_EXE_DIR stands in for the executable's folder; an empty ANNALO_DATA_DIR lets the
  // marker decide (the harness would otherwise pick a throw-away folder).
  app = await launch({ env: { ANNALO_EXE_DIR: stick, ANNALO_DATA_DIR: "" } });
  const data = path.join(stick, "data");
  const info = await app.invoke("app_info");
  assert.equal(info.portable, true);
  assert.equal(info.data_dir, data);
  assert.ok(fs.existsSync(path.join(data, "workspace.db")), "workspace in <exe dir>/data");
  assert.ok(fs.existsSync(path.join(data, "logs")) || fs.readdirSync(data).length > 1, `data folder in use: ${fs.readdirSync(data)}`);
  const status = await app.invoke("data_dir_status");
  assert.equal(status.portable, true);
  await assert.rejects(app.invoke("data_dir_set", { path: path.join(base, "anderswo"), useExisting: false }), /portablen Modus/);
  const desk = await app.invoke("desktop_info");
  assert.equal(desk.portable, true);
  assert.equal(desk.autostart_available, false);
  await assert.rejects(app.invoke("autostart_set", { enabled: true }), /portablen Modus/);
  assert.equal((await app.invoke("update_status")).portable, true);
  await assert.rejects(app.invoke("update_install"), /portablen Modus|nicht eingerichtet/);

  // Settings → Über: „Portabler Modus“ with the data path; moving the data folder is off.
  await app.keys(["Control", ","]);
  await app.waitFor(".settings-nav");
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Über") await el.click();
  await app.waitText(".set-row", /Portabler Modus/);
  await app.browser.waitUntil(() => app.browser.execute((d) => document.querySelector(".data-dir")?.title === d, data), { timeoutMsg: "data path not shown" });
  assert.equal(await app.browser.execute(() => [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Speicherort ändern")).disabled), true);
  await app.shot("portable-about");
  // Settings → Desktop: the autostart switch is off with an explanation.
  for (const el of await app.$$(".settings-nav-item")) if ((await app.textOf(el)) === "Desktop") await el.click();
  await app.waitText(".set-row", /Im portablen Modus aus/);
  assert.equal(await app.browser.execute(() => document.querySelector('[role="switch"][aria-label="Mit Windows starten"]')?.disabled ?? document.querySelector('[role="switch"][aria-label="Bei der Anmeldung starten"]')?.disabled), true);
  assert.deepEqual(await app.consoleErrors(), []);
});
