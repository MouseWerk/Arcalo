// Start page 1.6 in a large workspace: a board of ten widgets loads its data in one batched
// call and renders within 150 ms of the answer; widgets further down load when scrolled into
// view. Then screenshots of the three presets in light and dark at 1480 and 900 px width.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, guarded } from "../lib/harness.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch();
  await app.browser.setTimeout({ script: 300_000 });
});
after(async () => app?.close());

const reload = async () => {
  await app.browser.execute(() => location.reload());
  await app.browser.pause(300);
  await app.browser.waitUntil(() => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 30000, timeoutMsg: "not ready after reload" });
};
const clickText = async (sel, text) => {
  await app.browser.waitUntil(
    () =>
      app.browser.execute(
        (s, t) => {
          const el = [...document.querySelectorAll(s)].find((b) => b.textContent.trim() === t && !b.disabled);
          el?.click();
          return !!el;
        },
        sel,
        text,
      ),
    { timeoutMsg: `no ${sel} „${text}“` },
  );
  await app.browser.pause(80);
};
const W = (id, kind, x, y, w, h, config = {}) => ({ id, kind, x, y, w, h, config });
const pad = (n) => String(n).padStart(2, "0");

test("a large workspace: ten widgets, one call, rendered within 150 ms of the answer", async () => {
  // 1200 pages (a third with tasks, some with properties), 1500 bookings over the last months.
  const made = await app.browser.executeAsync((done) => {
    const inv = window.__TAURI_INTERNALS__.invoke;
    (async () => {
      const parent = await inv("page_create", { parentId: null, title: "Perf-Liste", icon: null, content: "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, Fertig: grün}}\n---\n" });
      const jobs = [];
      for (let i = 0; i < 1200; i++) {
        const tasks = i % 3 === 0 ? `\n- [ ] Aufgabe ${i} #perf due:2026-0${1 + (i % 9)}-1${i % 9}\n- [x] Erledigt ${i}` : "";
        const props = i % 4 === 0 ? `---\nstatus: ${i % 8 === 0 ? "Offen" : "Fertig"}\n---\n` : "";
        jobs.push(inv("page_create", { parentId: i % 4 === 0 ? parent.id : null, title: `Perf ${i}`, icon: null, content: `${props}# Perf ${i}\n\nText ${i} mit #perf${i % 10}.${tasks}` }));
        if (jobs.length >= 40) await Promise.all(jobs.splice(0));
      }
      await Promise.all(jobs);
      const tree = await inv("wbs_tree");
      const nps = tree.flatMap((p) => p.netzplaene);
      for (let i = 0; i < 1500; i++) {
        const np = nps[i % nps.length];
        const d = new Date(Date.now() - (i % 120) * 86400e3);
        d.setHours(8 + (i % 8), 0, 0, 0);
        jobs.push(inv("time_entry_create", { netzplanId: np.id, vorgangNr: np.vorgaenge[i % Math.max(1, np.vorgaenge.length)]?.vorgang_nr ?? null, leistungsart: null, startTime: d.toISOString(), durationMinutes: 30 + (i % 4) * 15, description: `Perf-Buchung ${i}` }));
        if (jobs.length >= 50) await Promise.all(jobs.splice(0));
      }
      await Promise.all(jobs);
      return { parent: parent.id, np: nps[0].id };
    })().then(done, (e) => done({ error: String(e) }));
  });
  assert.ok(!made.error, made.error);
  const boards = [
    {
      id: "perf",
      name: "Perf",
      widgets: [
        W("today", "today", 0, 0, 8, 12),
        W("agenda", "agenda", 8, 0, 4, 12, { days: 7 }),
        W("week", "week", 0, 12, 6, 7, { mode: "wbs" }),
        W("budget", "budget", 6, 12, 6, 7, { count: 4 }),
        W("tasks", "tasks", 0, 19, 4, 8, { due: "any" }),
        W("query", "query", 4, 19, 4, 8, { display: "bar", query: { source: "entries", range: "month", group: "wbs" } }),
        W("q2", "query", 8, 19, 4, 8, { display: "table", query: { source: "pages", parent_id: made.parent, filters: [{ field: "status", op: "ist", value: "Offen" }], columns: ["status"] } }),
        W("project", "project", 0, 27, 6, 9, { netzplan: made.np }),
        W("activity", "activity", 6, 27, 3, 9),
        W("recent", "recent", 9, 27, 3, 9),
        // Far below: loads only when scrolled into view.
        W("proposal", "proposal", 0, 60, 4, 6),
      ],
    },
  ];
  await app.invoke("dashboard_save", { dashboard: { version: 2, boards, active: "perf", notes: {} } });
  await app.keys(["Control", "t"]);
  await reload();
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .dw[data-widget='q2'] .dw-table", 30000);
  await app.browser.waitUntil(async () => (await app.$$(".pane.active > .pane-content:not([hidden]) .dw:not([data-widget='proposal']) .dw-skel")).length === 0, { timeout: 30000, timeoutMsg: "widgets still loading" });
  const perf = await app.browser.execute(() => window.__arcaloDashPerf ?? []);
  assert.ok(perf.length >= 1, "no timing recorded");
  const first = perf[0];
  // The ten widgets in view need 11 parts („Heute“ also asks for the timer's references),
  // all in the first call; the widget far below is not loaded yet.
  assert.equal(first.parts, 11, JSON.stringify(perf));
  assert.equal(await app.browser.execute(() => !!document.querySelector(".pane.active > .pane-content:not([hidden]) .dw[data-widget='proposal'] .dw-proposal")), false, "off-screen widget loaded early");
  console.log(`dashboard_data: backend ${first.backendMs.toFixed(1)} ms, round trip ${first.roundTripMs.toFixed(1)} ms, commit ${first.commitMs.toFixed(1)} ms, painted ${first.renderMs.toFixed(1)} ms after the answer`);
  assert.ok(first.renderMs < 150, `rendered ${first.renderMs} ms after the data arrived`);
  // Scrolling down loads the rest in another single call.
  await app.browser.execute(() => {
    const el = document.querySelector(".pane.active > .pane-content:not([hidden]) .dw[data-widget='proposal']");
    const home = el.closest(".home");
    home.scrollTop += el.getBoundingClientRect().top - home.getBoundingClientRect().top - 100;
  });
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .dw[data-widget='proposal'] .dw-proposal", 15000);
  const after = await app.browser.execute(() => window.__arcaloDashPerf);
  assert.ok(after.some((p) => p.parts === 1), JSON.stringify(after));
  // A booking elsewhere reloads the widgets showing time entries, in one call.
  const n = after.length;
  await app.invoke("time_entry_create", { netzplanId: made.np, vorgangNr: null, leistungsart: null, startTime: new Date().toISOString(), durationMinutes: 15, description: "Perf live" });
  await app.browser.execute(() => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "data://entries", payload: null }));
  await app.browser.waitUntil(async () => (await app.browser.execute(() => window.__arcaloDashPerf.length)) > n, { timeout: 10000, timeoutMsg: "no reload after data://entries" });
  const live = (await app.browser.execute(() => window.__arcaloDashPerf)).slice(n);
  assert.equal(live.length, 1, JSON.stringify(live));
  console.log(`reload after a booking: ${live[0].parts} parts, backend ${live[0].backendMs.toFixed(1)} ms, painted ${live[0].renderMs.toFixed(1)} ms after the answer`);
  await app.browser.execute(() => document.querySelector(".home").scrollTo(0, 0));
  await app.shot("94-perf-board");
});

const setTheme = async (theme) => {
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme } });
  await app.browser.execute((t) => (document.documentElement.dataset.theme = t), theme);
};

test("screenshots of the presets and the gallery, light and dark, wide and narrow", async () => {
  await app.invoke("dashboard_save", { dashboard: { version: 0, boards: [], active: "", notes: {} } });
  await reload();
  await app.waitFor(".pane.active > .pane-content:not([hidden]) .dw[data-widget='today']");
  // A realistic day: a booking this morning and a note with tasks.
  const now = new Date();
  const tree = await app.invoke("wbs_tree");
  const np = tree[0].netzplaene[0];
  await app.invoke("time_entry_create", { netzplanId: np.id, vorgangNr: np.vorgaenge[0]?.vorgang_nr ?? null, leistungsart: null, startTime: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0).toISOString(), durationMinutes: 150, description: "Konzept" });
  const daily = await app.invoke("daily_note", { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` });
  await app.invoke("page_save", { id: daily.id, content: "# Heute\n\n- [ ] Angebot an Müller schicken !!\n- [ ] Review vorbereiten\n- [ ] Reisekosten einreichen" });
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    for (const preset of [
      ["start", "Tagesstart"],
      ["lead", "Projektleitung"],
      ["minimal", "Minimal"],
    ]) {
      await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Anpassen");
      await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Vorlage");
      await clickText(".menu [role^=menuitem]", preset[1]);
      await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Fertig");
      await app.browser.waitUntil(async () => !(await (await app.$(".pane.active > .pane-content:not([hidden]) .dash.editing")).isExisting()));
      for (const width of [1480, 900]) {
        await app.browser.setWindowSize(width, 1000);
        await app.browser.pause(250);
        await app.browser.waitUntil(async () => (await app.$$(".pane.active > .pane-content:not([hidden]) .dw-skel")).length === 0, { timeout: 15000 });
        await app.browser.execute(() => document.querySelector(".home").scrollTo(0, 0));
        await app.shot(`94-${preset[0]}-${theme}-${width}`);
      }
      await app.browser.setWindowSize(1480, 1000);
    }
    await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Anpassen");
    await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Widget hinzufügen");
    await app.waitFor(".dash-gallery");
    await app.shot(`94-gallery-${theme}`);
    await app.keys(["Escape"]);
    await app.shot(`94-edit-${theme}`);
    await clickText(".pane.active > .pane-content:not([hidden]) .dash-bar button", "Abbrechen");
  }
  await app.browser.setWindowSize(1480, 920);
  assert.deepEqual(await app.consoleErrors(), []);
});
