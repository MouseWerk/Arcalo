// Screenshots for the README (not part of the test suite): realistic sample content, no test
// leftovers. Run after building the app, with the output folder of your choice:
//   ANNALO_SHOTS=../docs/screenshots ANNALO_APP=../target/debug/annalo node --test readme-shots.test.js
import { test, before, after } from "node:test";
import { launch } from "./lib/harness.js";

let app;
before(async () => (app = await launch()));
after(async () => app?.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ready = () => app.browser.waitUntil(async () => app.browser.execute(() => document.body.classList.contains("ready")), { timeout: 20000 });
const openTree = async (title) => {
  for (const r of await app.$$(".sidebar .tree-row")) if ((await app.textOf(r)) === title) return r.click();
  throw new Error(`no ${title}`);
};
const panel = (open) =>
  app.browser.execute((o) => {
    if (!!document.querySelector(".app > .panel") !== o) document.querySelector(".workspace > .pane:last-child .tabbar > button:last-of-type").click();
  }, open);
const menuClick = (label) =>
  app.browser.execute((l) => [...document.querySelectorAll(".menu .menu-item")].find((b) => b.innerText.includes(l))?.click(), label);
/** A text cursor in the last heading instead of a selected first block. */
const placeCursor = () => app.click(".pane.active .ProseMirror h2:last-of-type");
/** Shows a page without the cursor blinking in it and without hover states. */
const settle = async () => {
  await app.browser.execute(() => {
    document.activeElement?.blur?.();
    getSelection()?.removeAllRanges();
  });
  await app.browser.performActions([{ type: "pointer", id: "m", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", x: 5, y: 900 }] }]).catch(() => {});
  await sleep(500);
};

const SPRINT = `---
eigenschaften:
  status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Review: gelb, Fertig: grün}}
  aufwand: zahl
  fällig: datum
  wer: person
ansicht:
  typ: board
  gruppierung: status
  karten: [fällig, wer, aufwand]
---
Aufgaben für den Go-Live des Auftragsportals. Status per Drag & Drop ändern.
`;
const TASKS = [
  ["IDoc-Mapping ORDERS05", "Fertig", 6, "2026-09-22", "Anna"],
  ["Delta-Load testen", "Review", 4, "2026-09-25", "Max"],
  ["Fehlerqueue mit Retry", "In Arbeit", 8, "2026-09-29", "Max"],
  ["OpenAPI-Spezifikation", "In Arbeit", 5, "2026-09-30", "Anna"],
  ["Schulung Fachbereich", "Offen", 3, "2026-10-06", "Lea"],
  ["Monitoring-Dashboard", "Offen", 5, "2026-10-08", "Max"],
];

const DECK = `# Statusbericht KW 39

Auftragsportal · Rollout Phase 2

---

## Erreicht

- IDoc-Mapping für Bestellungen abgeschlossen
- Delta-Load läuft stabil (3 Tage ohne Fehler)
- API-Spezifikation mit dem Fachbereich abgestimmt

> [!notiz]
> Anna für das Mapping danken.

---

## Budget

| Vorgang | Plan | Ist |
|---|---|---|
| Systemintegration | 120 h | 96 h |
| Schnittstellen | 80 h | 71 h |
| Test | 60 h | 18 h |

---

## Nächste Schritte

1. Integrationstest mit dem Fachbereich
2. Go-Live-Checkliste freigeben
3. Schulung am 6. Oktober
`;

const BLOCKS = `[TOC]

## Zielbild

Das Auftragsportal übergibt Bestellungen per IDoc an SAP[^1]; Status und Lieferdaten kommen per Delta-Load zurück.

<!-- spalten -->

### Vorteile

- Keine Doppelerfassung
- Status in Echtzeit
- Fehler landen in einer Queue

<!-- spalte -->

### Risiken

- Mapping-Aufwand für Sonderfälle
- Abhängigkeit vom Middleware-Team

<!-- /spalten -->

> [!tip]+ Entscheidung
> Wir starten mit Bestellungen, Retouren folgen in Phase 3.

> [!info]- Technische Details
> Queue: persistente Verarbeitung mit Retry, maximal 5 Versuche.

## Offene Fragen

- [ ] Freigabeprozess für Stammdaten klären due:2026-10-01
- [x] Testsystem bereitstellen

[^1]: Nachrichtentyp ORDERS05, Basistyp ORDERS05, Erweiterung ZORD.
`;

test("README screenshots", async () => {
  // Sample pages next to the demo workspace.
  const sprint = await app.invoke("page_create", { parentId: null, title: "Sprint Go-Live", icon: "folder-kanban", content: SPRINT });
  for (const [title, status, aufwand, faellig, wer] of TASKS) {
    await app.invoke("page_create", {
      parentId: sprint.id,
      title,
      icon: null,
      content: `---\nstatus: ${status}\naufwand: ${aufwand}\nfällig: ${faellig}\nwer: ${wer}\n---\n`,
    });
  }
  // The board uses the whole pane (Volle Breite, next to the star).
  await app.browser.execute((id) => localStorage.setItem("annalo.page-full", JSON.stringify([id])), sprint.id);
  await app.invoke("page_create", { parentId: null, title: "Statusbericht KW 39", icon: "flag", content: DECK });
  await app.invoke("page_create", { parentId: null, title: "Konzept Auftragsportal", icon: "book-open", content: BLOCKS });
  await app.browser.refresh();
  await ready();

  // Board and table, without the side panel so the columns have room.
  await panel(false);
  await openTree("Sprint Go-Live");
  await app.waitFor(".pane.active .coll .board-col");
  await settle();
  await app.shot("board-view");
  await app.browser.execute(() => [...document.querySelectorAll(".pane.active .coll button")].find((b) => b.innerText.trim() === "Tabelle")?.click());
  await app.waitFor(".pane.active .coll-table");
  await settle();
  await app.shot("table-view");

  // Editor blocks: table of contents, columns, callouts, footnotes.
  await openTree("Konzept Auftragsportal");
  await app.waitFor(".pane.active .ProseMirror h2");
  await placeCursor();
  await settle();
  await app.shot("editor-blocks");

  // Presentation.
  await openTree("Statusbericht KW 39");
  await app.waitFor(".pane.active .ProseMirror");
  await app.click('.pane.active .vh [aria-label="Weitere Aktionen"]');
  await menuClick("Präsentieren");
  await app.waitFor(".presentation .present-slide");
  await app.keys(["ArrowRight"]);
  await app.keys(["ArrowRight"]);
  await sleep(3500); // the controls fade out
  await app.shot("presentation");
  await app.keys(["Escape"]);
  await sleep(600);

  // Activity feed with the side panel.
  await panel(true);
  await app.click('.ribbon [aria-label^="Aktivität"]');
  await app.waitFor(".activity-item");
  await settle();
  await app.shot("activity-feed");

  // Theme picker, then the app in a dark theme.
  await app.keys(["Control", ","]);
  await app.click('.settings-nav-item[data-section="appearance"]');
  await app.waitFor(".theme-card");
  await settle();
  await app.shot("theme-picker");
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, theme: "dark", appearance: { ...view.settings.appearance, theme_dark: "tokyo-night" } } });
  await app.browser.refresh();
  await ready();
  await openTree("Konzept Auftragsportal");
  await app.waitFor(".pane.active .ProseMirror h2");
  await placeCursor();
  await settle();
  await app.shot("theme-tokyo-night");
  await app.invoke("settings_save", { settings: view.settings });
});
