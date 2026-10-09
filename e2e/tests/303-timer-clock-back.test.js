// A timer whose start lies ahead of the clock (the computer's clock ran ahead when it started and
// was set back since) can be stopped (1.16): the booking stays without a duration and a notice
// says to enter it. The start is moved ahead in the database, as such a clock leaves it.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
});
after(async () => {
  await app?.close();
});

test("a timer started ahead of the clock stops and keeps its booking", async () => {
  const [np] = (await app.invoke("wbs_tree")).flatMap((p) => p.netzplaene);
  const started = await app.invoke("timer_start", { netzplanId: np.id, vorgangNr: null, leistungsart: null, description: "Uhr lief vor" });
  const ahead = new Date(Date.now() + 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const db = new DatabaseSync(path.join(app.dataDir, "workspace.db"));
  db.prepare("UPDATE time_entries SET start_time = ? WHERE id = ?").run(ahead, started.id);
  db.close();
  await app.browser.execute(() => window.dispatchEvent(new Event("focus")));
  await app.waitFor(".timer-dock");
  await app.click('.timer-dock [aria-label="Timer stoppen"]');
  const toast = await app.$(".toast*=Timer gestoppt, Dauer fehlt");
  await toast.waitForDisplayed({ timeout: 8000 });
  await app.shot("303-clock-back-toast");
  assert.equal(await app.invoke("timer_status"), null, "a new timer can start");
  const rows = await app.invoke("time_entries", { from: null, to: null });
  const kept = rows.find((r) => (r.entry?.id ?? r.id) === started.id);
  assert.ok(kept, "the booking is kept");
  assert.equal(kept.entry?.duration_minutes ?? kept.duration_minutes, 0);
});
