// Backend speed (1.4): a save returns only what it derived, batch commands for budgets,
// schedules and suggestion facts give the same answers as the single calls, table/board views
// get the frontmatter only, `time_entries` without a range returns the last year, and window
// calls and reads do not wait for a long save.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("a save returns tags, unresolved links and the time; the panel follows typing", async () => {
  const page = await app.invoke("page_create", { title: "Tempo55", parentId: null, icon: null, content: "Start" });
  const saved = await app.invoke("page_save", { id: page.id, content: "Siehe [[Architektur]] und [[Nirgendwo55]] #schnell" });
  assert.deepEqual(Object.keys(saved).sort(), ["id", "tags", "unresolved_links", "updated_at"]);
  const doc = await app.invoke("page_get", { id: page.id });
  assert.deepEqual(saved.tags, doc.tags);
  assert.deepEqual(saved.unresolved_links, ["Nirgendwo55"]);
  assert.equal(saved.updated_at, doc.updated_at);

  await app.invoke("search_open", { target: { kind: "page", page_id: page.id, new_tab: true } });
  await app.waitText(".pane.active .ProseMirror", /Nirgendwo55/);
  await app.click(".panel-tab:nth-child(3)");
  await app.waitText(".links-panel .link-row.unresolved", /Nirgendwo55/);
  await app.caretToEnd();
  await app.type(" #tempo55 ");
  await app.browser.waitUntil(async () => (await app.invoke("page_get", { id: page.id })).tags.includes("tempo55"), { timeoutMsg: "not saved" });
  await app.waitText(".links-panel .tag-chip", /#tempo55/);
  await app.shot("55-links-after-save");
  await app.click(".panel-tab:nth-child(1)");
});

test("budgets, schedules and suggestion facts in one call match the single calls", async () => {
  const tree = await app.invoke("wbs_tree");
  const ids = tree.flatMap((p) => p.netzplaene.map((n) => n.id));
  assert.ok(ids.length > 1, "demo has Netzpläne");
  const overview = await app.invoke("netzplan_overview");
  assert.deepEqual(overview.map((o) => o.netzplan_id).sort(), [...ids].sort());
  for (const o of overview) {
    assert.deepEqual(o.budget, await app.invoke("budget", { netzplanId: o.netzplan_id }), `budget ${o.netzplan_id}`);
    const schedule = await app.invoke("schedule", { netzplanId: o.netzplan_id }).catch(() => null);
    assert.deepEqual(o.schedule, schedule, `schedule ${o.netzplan_id}`);
  }
  const all = await app.invoke("budgets_all");
  assert.deepEqual(all, overview.flatMap((o) => o.budget));

  // Suggestion facts: the counts of the task list, the most critical budget.
  const withTasks = await app.invoke("page_create", { title: "Aufgaben55", parentId: null, icon: null, content: "- [ ] eins due:2020-01-01\n- [ ] zwei\n- [x] drei" });
  const today = isoDay(new Date());
  const facts = await app.invoke("suggestion_facts", { today, pageId: withTasks.id });
  const open = await app.invoke("tasks_list", { filter: { status: "open" } });
  assert.equal(facts.open_tasks, open.length);
  assert.equal(facts.overdue, open.filter((t) => t.due && t.due < today).length);
  assert.equal(facts.due_today, open.filter((t) => t.due === today).length);
  assert.equal(facts.page_open_tasks, 2);
  const rank = { exceeded: 3, critical: 2, warning: 1, ok: 0 };
  const worst = all.filter((b) => b.level !== "ok").sort((a, b) => rank[b.level] - rank[a.level] || b.consumed - a.consumed)[0];
  assert.equal(facts.worst_budget, worst?.label ?? null);

  // The Projekte view is built from it: budget badges and schedule facts are there.
  await app.click('.ribbon [aria-label="Projekte"]');
  await app.waitText(".vorgaenge td", /kritisch|Puffer/);
  assert.ok((await app.$$(".netzplan")).length >= ids.length);
});

test("table views get the children's frontmatter, not their text", async () => {
  const folder = await app.invoke("page_create", { title: "Ordner55", parentId: null, icon: null, content: "---\nansicht: tabelle\n---\n" });
  const kid = await app.invoke("page_create", { title: "Kind55", parentId: folder.id, icon: null, content: "---\nstatus: Offen\n---\nLanger Inhalt, der nicht mitkommt" });
  await app.invoke("page_create", { title: "Leer55", parentId: folder.id, icon: null, content: "nur Text" });
  const col = await app.invoke("page_collection", { parentId: folder.id });
  assert.deepEqual(col.rows.map((r) => r.title), ["Kind55", "Leer55"]);
  assert.equal(col.rows[0].id, kid.id);
  assert.equal(col.rows[0].frontmatter, "---\nstatus: Offen\n---\n");
  assert.equal(col.rows[1].frontmatter, "");
  const json = JSON.stringify(col);
  assert.ok(!json.includes("Langer Inhalt") && !json.includes("cells"), json);
});

test("time_entries without a range returns the last year; a range still reaches back further", async () => {
  const tree = await app.invoke("wbs_tree");
  const np = tree[0].netzplaene[0];
  const old = new Date(Date.now() - 800 * 86400_000);
  old.setUTCHours(8, 0, 0, 0);
  const out = await app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: null, leistungsart: null, startTime: old.toISOString(), durationMinutes: 30, description: "Alt55" });
  const recent = await app.invoke("time_entries", { from: null, to: null });
  assert.ok(recent.length > 0, "recent entries are there");
  assert.ok(!recent.some((e) => e.id === out.entry.id), "an entry of two years ago is not in the default range");
  const back = await app.invoke("time_entries", { from: new Date(Date.now() - 1000 * 86400_000).toISOString(), to: null });
  assert.ok(back.some((e) => e.id === out.entry.id));
  assert.equal(back.length, recent.length + 1);
});

test("window calls and reads do not wait for a long save", async () => {
  const big = await app.invoke("page_create", { title: "Riesig55", parentId: null, icon: null, content: null });
  const lines = [];
  for (let i = 0; i < 6000; i++) lines.push(`## Abschnitt ${i}\n\nText ${i} mit [[Ziel ${i}]] und #thema${i % 50} und noch etwas mehr Inhalt, damit der Absatz lang wird.\n`);
  const content = lines.join("\n");
  const order = await app.browser.executeAsync(
    (id, text, done) => {
      const inv = window.__TAURI_INTERNALS__.invoke;
      const seen = [];
      const t0 = performance.now();
      const save = inv("page_save", { id, content: text }).then(() => seen.push(["save", Math.round(performance.now() - t0)]));
      setTimeout(async () => {
        await inv("plugin:window|set_title", { label: "main", value: "Annalo" });
        seen.push(["title", Math.round(performance.now() - t0)]);
        await inv("page_get", { id: 1 });
        seen.push(["read", Math.round(performance.now() - t0)]);
        await save;
        done(seen);
      }, 30);
    },
    big.id,
    content,
  );
  const at = Object.fromEntries(order);
  // The save of 6,000 sections takes far longer than a title change or a read of another page.
  assert.ok(at.save > 150, `save too fast to tell: ${JSON.stringify(order)}`);
  assert.ok(at.title < at.save, `set_title waited for the save: ${JSON.stringify(order)}`);
  assert.ok(at.read < at.save, `a read waited for the save: ${JSON.stringify(order)}`);
  assert.equal((await app.invoke("page_get", { id: big.id })).unresolved_links.length, 6000);
});
