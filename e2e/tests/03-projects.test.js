import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const setField = async (placeholder, value) => {
  const el = await app.$(`.dialog input[placeholder="${placeholder}"]`);
  await el.setValue(value);
};

test("projects view shows budget and schedule facts", async () => {
  await app.click(".ribbon [aria-label=\"Projekte\"]");
  await app.waitText(".view-header h1", /Projekte/);
  await app.waitText(".vorgaenge :is(td, th)", /kritisch/);
  await app.waitText(".vorgaenge :is(td, th)", /Puffer 1 T/);
  await app.shot("projects");
});

test("create a project with Netzplan and Vorgang", async () => {
  await app.click(".view-actions .btn-primary");
  await setField("PRJ-2026-X", "PRJ-2027-A");
  await setField("Rollout Kunde X", "Wartungsvertrag");
  await app.click(".dialog .btn-primary");
  await app.waitText(".project-head h2", /Wartungsvertrag/);

  const heads = await app.$$(".project-head");
  let head;
  for (const h of heads) if (/Wartungsvertrag/.test(await app.textOf(h))) head = h;
  await (await head.$(".btn-ghost")).click();
  await setField("NP-8801", "NP-9100");
  await setField("Systemintegration", "Support Q1");
  await setField("120", "80");
  await app.click(".dialog .btn-primary");
  await app.waitText(".netzplan-title", /NP-9100/);

  const nps = await app.$$(".netzplan");
  let np;
  for (const n of nps) if (/NP-9100/.test(await app.textOf(n))) np = n;
  await (await np.$('button[aria-label="Vorgang hinzufügen"]')).click();
  await setField("1070", "0010");
  await setField("Hypercare", "Ticketbearbeitung");
  const inputs = await app.$$(".dialog .input");
  await inputs[3].setValue("40");
  await app.shot("vorgang-dialog");
  await app.click(".dialog .btn-primary");
  await app.waitText(".vorgaenge :is(td, th)", /0010 Ticketbearbeitung/);

  const tree = await app.invoke("wbs_tree");
  const p = tree.find((x) => x.project_code === "PRJ-2027-A");
  assert.equal(p.netzplaene[0].netzplan_nr, "NP-9100");
  assert.equal(p.netzplaene[0].planned_hours, 80);
  assert.equal(p.netzplaene[0].vorgaenge[0].planned_hours, 40);
});

test("new WBS is bookable right away", async () => {
  const out = await app.invoke("log_time", { line: "/zeit NP-9100/0010 2h #PM Tickets" });
  assert.equal(out.entry.duration_minutes, 120);
});

test("deleting a Netzplan with booked time is refused with a clear message", async () => {
  const nps = await app.$$(".netzplan");
  let np;
  for (const n of nps) if (/NP-9100/.test(await app.textOf(n))) np = n;
  await (await np.$('button[aria-label="Netzplanaktionen"]')).click();
  await app.click(".menu-item.danger");
  await app.click(".dialog .btn-danger");
  await app.waitText(".toast-detail", /gebuchte Zeiten/);
});

test("timer can be started from a Vorgang row", async () => {
  const rows = await app.$$(".vorgaenge tbody tr");
  await (await rows[0].$('button[aria-label="Timer starten"]')).click();
  await app.waitText(".toast-title", /Timer gestartet/);
  await app.waitFor(".timer-dock");
  await app.invoke("timer_discard");
});

test("sample data can be removed from settings", async () => {
  await app.keys(["Control", ","]);
  await app.click(".settings-nav-item[data-section=\"notes\"]");
  const rows = await app.$$(".set-row");
  for (const r of rows)
    if (/Beispieldaten entfernen/.test(await app.textOf(r))) {
      await app.dismissToasts();
      await (await r.$(".btn-danger")).click();
      break;
    }
  await app.waitFor(".dialog");
  await app.shot("confirm-demo-removal");
  await app.click(".dialog .btn-danger");
  await app.waitText(".toast-title", /Beispieldaten entfernt/);
  const tree = await app.invoke("wbs_tree");
  assert.deepEqual(tree.map((p) => p.project_code), ["PRJ-2027-A"], "own project stays");
  assert.equal(await app.invoke("page_resolve", { title: "SAP CATS Leitfaden", create: false }), null);
});

test("no console errors", async () => {
  assert.deepEqual(await app.consoleErrors(), []);
});
