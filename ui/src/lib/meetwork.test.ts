import { describe, expect, it } from "vitest";
import { REPORT_SECTIONS, clipForMailto, mailRoute, mailtoUrl, markdownFileName, newRequest, periodValid, requestOf, scopeKey, scopeList, stripFrontMatter, toggleSection } from "./meetwork";

const scope = { kind: "jira" as const, id: "PORT", label: "PORT Portal" };

describe("status report requests", () => {
  it("starts with this week, every section and AI as asked", () => {
    const r = newRequest(scope, true);
    expect(r.period).toEqual({ kind: "this_week", from: null, to: null });
    expect(r.sections).toEqual([...REPORT_SECTIONS]);
    expect(r.ai).toBe(true);
  });

  it("takes a template's scope, period kind and sections", () => {
    const r = requestOf({ id: "t1", name: "Portal", scope, period: "last_month", sections: ["risks", "hours"], ai: false });
    expect(r.period.kind).toBe("last_month");
    expect(r.sections).toEqual(["risks", "hours"]);
  });

  it("checks a custom period", () => {
    expect(periodValid({ kind: "this_week", from: null, to: null })).toBe(true);
    expect(periodValid({ kind: "custom", from: "2026-10-01", to: null })).toBe(false);
    expect(periodValid({ kind: "custom", from: "2026-10-05", to: "2026-10-01" })).toBe(false);
    expect(periodValid({ kind: "custom", from: "2026-10-01", to: "2026-10-01" })).toBe(true);
  });

  it("toggles sections in the default order", () => {
    expect(toggleSection(["risks", "summary"], "hours", true)).toEqual(["summary", "hours", "risks"]);
    expect(toggleSection(["summary", "hours"], "summary", false)).toEqual(["hours"]);
  });

  it("lists scopes in the order Netzplan, Jira, folders, tags", () => {
    const list = scopeList({
      netzplaene: [{ kind: "netzplan", id: "1", label: "NP-8801" }],
      jira: [scope],
      folders: [{ kind: "folder", id: "7", label: "Portal" }],
      tags: [{ kind: "tag", id: "portal", label: "#portal" }],
    });
    expect(list.map(scopeKey)).toEqual(["netzplan:1", "jira:PORT", "folder:7", "tag:portal"]);
  });
});

describe("follow-up mail without Outlook", () => {
  it("falls back to the mail program", () => {
    expect(mailRoute({ outlook: true })).toBe("outlook");
    expect(mailRoute({ outlook: false })).toBe("mailto");
  });

  it("encodes mailto links and keeps only addresses", () => {
    const url = mailtoUrl(["anna@example.com", "Weiß, Jörg"], "Zusammenfassung: Jour fixe (02.10.2026)", "Grüße\nAnna");
    expect(url).toBe("mailto:anna%40example.com?subject=Zusammenfassung%3A%20Jour%20fixe%20(02.10.2026)&body=Gr%C3%BC%C3%9Fe%0D%0AAnna");
  });

  it("shortens long text at a line end with a hint", () => {
    const text = Array.from({ length: 100 }, (_, i) => `Zeile ${i}`).join("\n");
    const out = clipForMailto(text, 200, "[gekürzt]");
    expect(out.cut).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(200);
    expect(out.text.endsWith("\n\n[gekürzt]")).toBe(true);
    expect(clipForMailto("kurz", 200, "x")).toEqual({ text: "kurz", cut: false });
  });

  it("drops the front matter and makes a file name", () => {
    expect(stripFrontMatter("---\ndatum: 2026-10-02\n---\n# Titel\n")).toBe("# Titel\n");
    expect(markdownFileName("Statusbericht Portal KW 40/2026")).toBe("Statusbericht Portal KW 40-2026.md");
  });
});
