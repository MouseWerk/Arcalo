// Link and tag suggestions, duplicate hints and PDF highlights (1.10) in English: the same
// flows as 143 with English labels, the English quote marks and page label, and no German
// left in the window while the new panels are shown.
import { test as nodeTest, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guarded } from "../lib/harness.js";
import { launchEnglish, germanLeftovers } from "../lib/english.js";
import { duplicatesFlow, mentionsFlow, pdfFlow, tagsFlow } from "../lib/linking-flows.js";

const test = guarded(nodeTest, () => app);
let app, dataDir;
before(async () => {
  ({ app, dataDir } = await launchEnglish({ width: 1480, height: 920 }));
});
after(async () => {
  await app?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

const L = {
  portal: "Customer Portal",
  portalText: "The portal for customers. Payments go through the Payment Platform.",
  plan: "Release Plan",
  planText: "The Customer Portal lacks a login.\n\nThe customer portal needs tests.\n\n`Customer Portal` in code.",
  planLinked: "The [[Customer Portal]] lacks a login.\n\nThe [[Customer Portal|customer portal]] needs tests.\n\n`Customer Portal` in code.",
  maint: "Maintenance Window",
  maintText: "Next week: CUSTOMER PORTAL maintenance.",
  maintLinked: "Next week: [[Customer Portal|CUSTOMER PORTAL]] maintenance.",
  pay: "Payment Platform",
  mentionsTitle: "Unlinked mentions",
  hintPage: "Hint Note",
  hintText: "Test the payment platform tomorrow.",
  tagA: "Bridge Statics",
  tagAText: "Statics of the bridge, piers and loads to check. #project-bridge",
  tagB: "Bridge Tender",
  tagBText: "Tender for the bridge with piers and statics, see [[Bridge Statics]]. #project-bridge",
  tagPage: "Bridge Kickoff",
  tagPageText: "Kickoff: discuss piers and statics of the bridge, see [[Bridge Statics]].",
  tag: "project-bridge",
  suggestionLabel: "Suggestion:",
  dupA: "Server Move Plan",
  dupB: "Server Move Planning old",
  dupSrc: "Server Move Reference",
  dupText:
    "The move of the servers into the new data center starts in November with the databases, followed by the web servers and finally the backups including a check of all accounts.",
  dupExtra: "Open question: who takes the on-call duty?",
  similarLabel: "Similar page:",
  undo: "Undo",
  pdf: "Study.pdf",
  scan: "Scan.pdf",
  pdfPage1: "First page introduction",
  pdfPage2: "Second page result",
  readPage: "Reading Notes",
  readIntro: "Sources:",
  hlNote: "important",
  q: ["“", "”"],
  pageLabel: "p.",
  summaryHead: "### Highlights from [[Study.pdf]]",
  noText: "no text layer",
};

test("unlinked mentions in English", async () => {
  await mentionsFlow(app, L, "144-mentions-panel-en");
  assert.deepEqual(await germanLeftovers(app), []);
});

test("tag suggestion in English", async () => {
  await tagsFlow(app, L);
});

test("duplicate hint in English", async () => {
  await duplicatesFlow(app, L);
  assert.deepEqual(await germanLeftovers(app), []);
});

test("PDF highlight in English", async () => {
  await pdfFlow(app, L, "144-pdf-highlight-en");
});
