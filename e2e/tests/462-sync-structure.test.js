// Git sync with another computer (q124 H2): a title its file name cannot hold („Q3: Ziele“ in
// „Q3- Ziele.md“) arrives as it is, a page deleted there together with its subpage is taken over,
// and so is the first subpage of an empty page. Before, the titles arrived as the file names
// („Q3- Ziele“, links to them found nothing), and the other two stopped every later take-over.
// The other computer is a clone of the bare repository, changed with git.
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
  app = await launch({ demo: false });
  base = fs.mkdtempSync(path.join(os.tmpdir(), "arcalo-e2e-462-"));
  bare = path.join(base, "notizen.git");
  other = path.join(base, "anderer-computer");
  execFileSync("git", ["init", "-q", "--bare", bare]);
});
after(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

const gitOther = (...args) =>
  execFileSync("git", ["-C", other, "-c", "user.name=Laptop", "-c", "user.email=laptop@example.com", ...args], { encoding: "utf8" });
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
const pageNamed = async (title) => flat(await app.invoke("workspace_tree")).find((n) => n.title === title);
const create = (title, content, parentId = null) => app.invoke("page_create", { parentId, title, icon: null, content });

test("titles, a deleted subtree and a first subpage from another computer are taken over", async () => {
  const ziele = await create("Q3: Ziele", "Umsatz halten");
  const eltern = await create("Eltern", "Einleitung");
  await create("Kind", "Unterseite", eltern.id);
  const projekte = await create("Projekte", null);
  // Enough notes that three deletions are no mass deletion (gitsync::mass_deletion).
  for (let i = 1; i <= 14; i++) await create(`Notiz ${i}`, `Text ${i}`);
  const index = await create("Index", "[[Q3: Ziele]] und [[Frage: A]]");
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", {
    settings: { ...view.settings, git_sync: { ...view.settings.git_sync, enabled: true, remote_url: bare, author_name: "E2E", author_email: "e2e@example.com" } },
  });
  await app.invoke("git_sync_now");

  // The repository names the title the file name lost.
  execFileSync("git", ["clone", "-q", "-b", "main", bare, other]);
  const titlesFile = path.join(other, ".arcalo-titles.json");
  const titles = JSON.parse(fs.readFileSync(titlesFile, "utf8")).titles;
  assert.equal(titles["Q3- Ziele.md"], "Q3: Ziele", JSON.stringify(titles));

  // The other computer: a new page „Frage: A“, „Eltern“ deleted with its subpage, a first
  // subpage below the empty „Projekte“.
  fs.writeFileSync(path.join(other, "Frage- A.md"), "Antwort folgt");
  fs.writeFileSync(titlesFile, JSON.stringify({ titles: { ...titles, "Frage- A.md": "Frage: A" } }, null, 2));
  gitOther("rm", "-q", "Eltern.md", "Eltern/Kind.md");
  gitOther("rm", "-q", "Projekte.md");
  fs.mkdirSync(path.join(other, "Projekte"));
  fs.writeFileSync(path.join(other, "Projekte", "Erstes.md"), "Erster Eintrag");
  gitOther("add", "-A");
  gitOther("commit", "-q", "-m", "Laptop");
  gitOther("push", "-q", "origin", "HEAD:main");

  const out = await app.invoke("git_sync_now");
  assert.match(out.message, /vom Server übernommen/, JSON.stringify(out));
  const frage = await pageNamed("Frage: A");
  assert.ok(frage, "the page keeps its title");
  assert.equal((await app.invoke("page_get", { id: frage.id })).content, "Antwort folgt");
  assert.equal(await pageNamed("Frage- A"), undefined);
  // The link to it resolves.
  const saved = await app.invoke("page_save", { id: index.id, content: "[[Q3: Ziele]] und [[Frage: A]]" });
  assert.deepEqual(saved.unresolved_links, []);
  const trash = await app.invoke("trash_list");
  assert.deepEqual(trash.map((e) => [e.title, e.descendants]), [["Eltern", 1]]);
  const erstes = await pageNamed("Erstes");
  assert.equal(erstes?.parent_id, projekte.id, "below the page it was made under");
  assert.equal((await pageNamed("Projekte"))?.id, projekte.id);
  assert.equal((await pageNamed("Q3: Ziele"))?.id, ziele.id);

  // Nothing waits: the next sync is clean and pulls nothing again.
  const again = await app.invoke("git_sync_now");
  assert.doesNotMatch(again.message, /übernommen|zusammenführen/, JSON.stringify(again));
  const status = await app.invoke("git_sync_status");
  assert.ok(!status.last_error, JSON.stringify(status));

  // The tree shows the title.
  await app.waitText(".sidebar .tree-row", /^Frage: A$/, 8000);
  assert.deepEqual(await app.consoleErrors(), []);
});
