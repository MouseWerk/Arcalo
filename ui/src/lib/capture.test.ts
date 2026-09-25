import { describe, expect, it } from "vitest";
import {
  DAILY,
  captureHint,
  captureKind,
  cycleTarget,
  firstDue,
  fuzzyScore,
  inboxChoice,
  insertBlock,
  markdownLink,
  newPageTitle,
  normalizeCapture,
  normalizeLine,
  parseDue,
  pastedUrl,
  quickTargets,
  rankPages,
  tagToken,
  targetPhrase,
  wikiToken,
} from "./capture";
import type { Page } from "./types";

// Wednesday, 23 September 2026, 14:30.
const now = new Date(2026, 8, 23, 14, 30);

describe("captureKind", () => {
  it("recognises bookings, tasks and notes", () => {
    expect(captureKind("/zeit NP-8801 1h")).toBe("zeit");
    expect(captureKind("  /ZEIT NP-8801 1h")).toBe("zeit");
    expect(captureKind("- [ ] Angebot")).toBe("task");
    expect(captureKind("* [ ] Angebot")).toBe("task");
    expect(captureKind("todo Angebot")).toBe("task");
    expect(captureKind("TODO: Angebot")).toBe("task");
    expect(captureKind("todos aufräumen")).toBe("note");
    expect(captureKind("todo")).toBe("note");
    expect(captureKind("Idee")).toBe("note");
  });

  it("names the target in the hint", () => {
    expect(captureHint("task")).toMatch(/Aufgabe in der heutigen Tagesnotiz/);
    expect(captureHint("note", targetPhrase({ target: { kind: "page", page_id: 3 }, label: "Kunde X" }))).toBe("Enter speichert die Notiz in „Kunde X“");
    expect(targetPhrase({ target: { kind: "meeting", key: "k" }, label: "Jour fixe" })).toMatch(/Besprechungsnotiz/);
  });
});

describe("targets", () => {
  const meeting = { target: { kind: "meeting" as const, key: "outlook|jf|" }, label: "Jour fixe" };
  const page = { target: { kind: "page" as const, page_id: 7 }, label: "Kunde X" };

  it("cycles daily note, current meeting, last page and inbox", () => {
    const list = quickTargets({ inbox: "Posteingang", meeting, last: page });
    expect(list.map((c) => c.label)).toEqual(["Tagesnotiz", "Jour fixe", "Kunde X", "Posteingang"]);
    expect(cycleTarget(list, { kind: "daily" }).label).toBe("Jour fixe");
    expect(cycleTarget(list, { kind: "inbox" }).label).toBe("Tagesnotiz");
    expect(cycleTarget(list, { kind: "daily" }, -1).label).toBe("Posteingang");
    // A target outside the list (a new page) starts over with the daily note.
    expect(cycleTarget(list, { kind: "new_page", title: "X" })).toBe(DAILY);
  });

  it("leaves out what is missing or already listed", () => {
    expect(quickTargets({ inbox: "" }).map((c) => c.label)).toEqual(["Tagesnotiz", "Posteingang"]);
    expect(quickTargets({ inbox: "Inbox", last: inboxChoice("Inbox") }).length).toBe(2);
    expect(quickTargets({ inbox: "Inbox", meeting, last: meeting }).length).toBe(3);
  });
});

describe("page picker", () => {
  const page = (id: number, title: string, updated = "2026-09-01T00:00:00Z"): Page => ({ id, title, parent_id: null, icon: null, position: 0, updated_at: updated, favorite: false, daily_date: null });

  it("scores exact, prefix, word, contained and fuzzy matches", () => {
    const s = (q: string, t: string) => fuzzyScore(q, t);
    expect(s("kunde x", "Kunde X")).toBe(1000);
    expect(s("kun", "Kunde X")!).toBeGreaterThan(s("x", "Kunde X")!);
    expect(s("x", "Kunde X")!).toBeGreaterThan(s("nde", "Kunde X")!);
    expect(s("jfk", "Jour fixe Kunde")!).toBeGreaterThan(0);
    expect(s("ubersicht", "Übersicht")).toBe(1000);
    expect(s("zzz", "Kunde X")).toBeNull();
    expect(s("", "egal")).toBe(0);
  });

  it("ranks recent pages first among equal matches and skips trashed ones", () => {
    const pages = [page(1, "Projekt Alpha"), page(2, "Projekt Beta", "2026-09-20T00:00:00Z"), page(3, "Protokoll"), { ...page(4, "Projekt Gamma"), deleted_at: "2026-09-01" }];
    expect(rankPages("", pages, [3, 1]).map((p) => p.id)).toEqual([3, 1, 2]);
    expect(rankPages("projekt", pages, [1]).map((p) => p.id)).toEqual([1, 2]);
    expect(rankPages("prjbt", pages, []).map((p) => p.id)).toEqual([2]);
    expect(rankPages("", pages, [], 1).length).toBe(1);
  });

  it("reads „Neue Seite: Titel“", () => {
    expect(newPageTitle("Neue Seite: Ideen Q4")).toBe("Ideen Q4");
    expect(newPageTitle("neue seite:Ideen")).toBe("Ideen");
    expect(newPageTitle("Neue Seite:  ")).toBeNull();
    expect(newPageTitle("Ideen")).toBeNull();
  });
});

describe("due dates", () => {
  it("understands words, weekdays, offsets and dates", () => {
    expect(parseDue("heute", now)).toBe("2026-09-23");
    expect(parseDue("morgen", now)).toBe("2026-09-24");
    expect(parseDue("Übermorgen", now)).toBe("2026-09-25");
    expect(parseDue("Fr", now)).toBe("2026-09-25");
    expect(parseDue("freitag", now)).toBe("2026-09-25");
    expect(parseDue("Mo", now)).toBe("2026-09-28");
    // Today's weekday means next week.
    expect(parseDue("Mi", now)).toBe("2026-09-30");
    expect(parseDue("+3", now)).toBe("2026-09-26");
    expect(parseDue("+2w", now)).toBe("2026-10-07");
    expect(parseDue("3.10.", now)).toBe("2026-10-03");
    expect(parseDue("2026-12-01", now)).toBe("2026-12-01");
    expect(parseDue("bald", now)).toBeNull();
    expect(parseDue("31.2.", now)).toBeNull();
  });

  it("turns due words and trailing days of tasks into the task format", () => {
    expect(normalizeLine("todo Angebot senden due:fr", now)).toBe("todo Angebot senden due:2026-09-25");
    expect(normalizeLine("- [ ] Angebot due:morgen !!", now)).toBe("- [ ] Angebot due:2026-09-24 !!");
    expect(normalizeLine("todo Angebot senden bis Fr", now)).toBe("todo Angebot senden due:2026-09-25");
    expect(normalizeLine("todo Anruf Kunde X morgen", now)).toBe("todo Anruf Kunde X due:2026-09-24");
    expect(normalizeLine("- [ ] Review am 1.10.", now)).toBe("- [ ] Review due:2026-10-01");
    expect(normalizeLine("todo Rechnung bis so", now)).toBe("todo Rechnung due:2026-09-27");
    // Not a due date: a note, a lower-case „so“ without „bis“, a task that is only a day, an unknown word.
    expect(normalizeLine("Treffen morgen", now)).toBe("Treffen morgen");
    expect(normalizeLine("todo mach das so", now)).toBe("todo mach das so");
    expect(normalizeLine("todo Fr", now)).toBe("todo Fr");
    expect(normalizeLine("todo x due:irgendwann", now)).toBe("todo x due:irgendwann");
    expect(normalizeLine("todo x due:2026-10-01 morgen", now)).toBe("todo x due:2026-10-01 morgen");
    expect(normalizeLine("/zeit NP-8801 1h due:morgen", now)).toBe("/zeit NP-8801 1h due:morgen");
  });

  it("keeps multi-line text and code blocks", () => {
    const text = "Notiz\ntodo A bis Fr\n```\ntodo B morgen\n```\n  - [ ] C due:heute";
    expect(normalizeCapture(text, now)).toBe("Notiz\ntodo A due:2026-09-25\n```\ntodo B morgen\n```\n  - [ ] C due:2026-09-23");
    expect(firstDue(text, now)).toBe("2026-09-25");
    expect(firstDue("Notiz", now)).toBeNull();
  });
});

describe("tags, links and paste", () => {
  it("finds the [[ and # being typed", () => {
    expect(wikiToken("Siehe [[Kun")).toEqual({ from: 6, query: "Kun" });
    expect(wikiToken("Siehe [[Kunde X]] und")).toBeNull();
    expect(wikiToken("ohne")).toBeNull();
    expect(tagToken("Idee #ver")).toEqual({ from: 5, query: "ver" });
    expect(tagToken("#idee")).toEqual({ from: 0, query: "idee" });
    expect(tagToken("Preis #")).toBeNull();
    expect(tagToken("C#")).toBeNull();
    expect(tagToken("# Überschrift")).toBeNull();
  });

  it("turns a pasted address into a Markdown link", () => {
    expect(pastedUrl(" https://example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(pastedUrl("siehe https://example.com")).toBeNull();
    expect(pastedUrl("ftp://x")).toBeNull();
    expect(markdownLink("Beispiel [Test]", "https://example.com/(x)")).toBe("[Beispiel \\[Test\\]](https://example.com/(x%29)");
    expect(markdownLink("  ", "https://e.com")).toBe("https://e.com");
    expect(markdownLink("https://e.com", "https://e.com")).toBe("https://e.com");
  });

  it("puts images and files on a line of their own", () => {
    expect(insertBlock("", 0, "![[a.png]]")).toEqual({ text: "![[a.png]]", caret: 10 });
    expect(insertBlock("Text", 4, "![[a.png]]")).toEqual({ text: "Text\n![[a.png]]", caret: 15 });
    expect(insertBlock("vorher nachher", 6, "![[a.png]]")).toEqual({ text: "vorher\n![[a.png]]\n nachher", caret: 17 });
  });
});
