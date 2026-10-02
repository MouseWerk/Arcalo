// Link and tag suggestions, duplicate hints and PDF highlights (1.10), German: unlinked mentions
// in the links panel (link one, link all of a page, link from the open page, inline hint), a
// tag suggestion accepted into the frontmatter, a duplicate hint with compare, merge and undo,
// and a PDF passage highlighted, taken into the note, whose link opens the PDF on its page.
import { test as nodeTest, before, after } from "node:test";
import { launch, guarded } from "../lib/harness.js";
import { duplicatesFlow, mentionsFlow, pdfFlow, tagsFlow } from "../lib/linking-flows.js";

const test = guarded(nodeTest, () => app);
let app;
before(async () => {
  app = await launch({ width: 1480, height: 920 });
});
after(async () => app?.close());

const L = {
  portal: "Kundenportal",
  portalText: "Das Portal für Kunden. Bezahlt wird über die Zahlungsplattform.",
  plan: "Release Plan",
  planText: "Im Kundenportal fehlt der Login.\n\nDas kundenportal braucht Tests.\n\n`Kundenportal` im Code.",
  planLinked: "Im [[Kundenportal]] fehlt der Login.\n\nDas [[Kundenportal|kundenportal]] braucht Tests.\n\n`Kundenportal` im Code.",
  maint: "Wartungsfenster",
  maintText: "Nächste Woche: Kundenportals Wartung.",
  maintLinked: "Nächste Woche: [[Kundenportal|Kundenportals]] Wartung.",
  pay: "Zahlungsplattform",
  mentionsTitle: "Nicht verlinkte Erwähnungen",
  hintPage: "Hinweis Notiz",
  hintText: "Morgen die Zahlungsplattform testen.",
  tagA: "Statik Brückenbau",
  tagAText: "Statik der Brücke, Pfeiler und Lasten prüfen. #projekt-bruecke",
  tagB: "Ausschreibung Brückenbau",
  tagBText: "Ausschreibung zum Brückenbau mit Pfeiler und Statik, siehe [[Statik Brückenbau]]. #projekt-bruecke",
  tagPage: "Kickoff Brückenbau",
  tagPageText: "Kickoff: Pfeiler und Statik der Brücke besprechen, siehe [[Statik Brückenbau]].",
  tag: "projekt-bruecke",
  suggestionLabel: "Vorschlag:",
  dupA: "Serverumzug Plan",
  dupB: "Serverumzug Planung alt",
  dupSrc: "Serverumzug Verweis",
  dupText:
    "Der Umzug der Server in das neue Rechenzentrum beginnt im November mit den Datenbanken, danach folgen die Webserver und zuletzt die Backups samt Prüfung der Zugänge.",
  dupExtra: "Offene Frage: wer übernimmt die Rufbereitschaft?",
  similarLabel: "Ähnliche Seite:",
  undo: "Rückgängig",
  pdf: "Studie.pdf",
  scan: "Scan.pdf",
  pdfPage1: "Erste Seite Einleitung",
  pdfPage2: "Zweite Seite Ergebnis",
  readPage: "Lesenotizen",
  readIntro: "Quellen:",
  hlNote: "wichtig",
  q: ["„", "“"],
  pageLabel: "S.",
  summaryHead: "### Markierungen aus [[Studie.pdf]]",
  noText: "keine Textebene",
};

test("unlinked mentions: link one, all, from the open page and the inline hint", async () => {
  await mentionsFlow(app, L, "143-mentions-panel");
});

test("a tag suggestion is accepted", async () => {
  await tagsFlow(app, L);
});

test("duplicate hint: compare, merge and undo", async () => {
  await duplicatesFlow(app, L, "143-duplicate-compare");
});

test("PDF highlight into the note, the link opens the page", async () => {
  await pdfFlow(app, L, "143-pdf-highlight");
});
