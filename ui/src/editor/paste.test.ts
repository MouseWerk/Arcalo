import { describe, expect, it } from "vitest";
import { classifyPaste, detectTrace, parseHtmlTable, parseTeamsChat, parseTsv, singleUrl } from "./paste";

describe("spreadsheet rows", () => {
  it("reads Excel TSV with a trailing line break and CRLF", () => {
    expect(parseTsv("Name\tStunden\r\nAnna\t2,5\r\nBen\t4\r\n")).toEqual([["Name", "Stunden"], ["Anna", "2,5"], ["Ben", "4"]]);
  });
  it("unquotes cells with line breaks and quotes", () => {
    expect(parseTsv('A\tB\n"Zeile 1\nZeile 2"\t"sagt ""ja"""\n')).toEqual([["A", "B"], ["Zeile 1\nZeile 2", 'sagt "ja"']]);
  });
  it("keeps empty cells, refuses ragged rows, single rows and tab-indented code", () => {
    expect(parseTsv("a\t\tc\nd\te\tf")).toEqual([["a", "", "c"], ["d", "e", "f"]]);
    expect(parseTsv("a\tb\nc")).toBeNull();
    expect(parseTsv("a\tb")).toBeNull();
    expect(parseTsv("\tif (x) {\n\t\ty();")).toBeNull();
    expect(parseTsv("kein Tab\nhier")).toBeNull();
  });
  it("reads an HTML table (Google Sheets, Word), colspans padded", () => {
    const html =
      '<meta charset="utf-8"><google-sheets-html-origin><table><tbody><tr><td>Projekt</td><td>Status</td></tr><tr><td colspan="2">Rollout <b>Phase 2</b></td></tr></tbody></table>';
    expect(parseHtmlTable(html)).toEqual([["Projekt", "Status"], ["Rollout Phase 2", ""]]);
    expect(parseHtmlTable("<table><tr><td><p>a</p><p>b</p></td><td>c</td></tr></table>")).toEqual([["a\nb", "c"]]);
  });
  it("ignores a table inside a longer page selection", () => {
    const html = `<p>${"Viel Text davor. ".repeat(20)}</p><table><tr><td>a</td><td>b</td></tr></table>`;
    expect(parseHtmlTable(html)).toBeNull();
  });
  it("classifies Excel's clipboard (TSV and HTML) as a table", () => {
    expect(classifyPaste("A\tB\n1\t2\n", "<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>")).toEqual({ kind: "table", rows: [["A", "B"], ["1", "2"]] });
    expect(classifyPaste("", "<table><tr><th>A</th><th>B</th></tr></table>")).toEqual({ kind: "table", rows: [["A", "B"]] });
  });
});

describe("Teams chat", () => {
  it("reads the bracket form [time] Name", () => {
    const text = "[10:32] Max Mustermann\nKönnen wir morgen?\nGerne um 9.\n[10:35] Erika Musterfrau (Extern)\nPasst!\n";
    expect(parseTeamsChat(text)).toEqual([
      { name: "Max Mustermann", time: "10:32", lines: ["Können wir morgen?", "Gerne um 9."] },
      { name: "Erika Musterfrau (Extern)", time: "10:35", lines: ["Passt!"] },
    ]);
  });
  it("reads the one-line form with date", () => {
    expect(parseTeamsChat("[24.09.2026 10:32] Mustermann, Max: Build ist grün")).toEqual([{ name: "Mustermann, Max", time: "10:32", lines: ["Build ist grün"] }]);
  });
  it("reads the classic form Name time", () => {
    const text = "Max Mustermann 10:32\nHallo zusammen\nErika Musterfrau Gestern 16:05\nHi\n";
    expect(parseTeamsChat(text)?.map((m) => [m.name, m.time, m.lines])).toEqual([
      ["Max Mustermann", "10:32", ["Hallo zusammen"]],
      ["Erika Musterfrau", "16:05", ["Hi"]],
    ]);
  });
  it("reads the new Teams form (name line, time line)", () => {
    const text = "Max Mustermann\n10:32\nDeploy läuft\n\nErika Musterfrau\n24.09. 10:40\nDanke\n";
    expect(parseTeamsChat(text)?.map((m) => [m.name, m.time, m.lines])).toEqual([
      ["Max Mustermann", "10:32", ["Deploy läuft"]],
      ["Erika Musterfrau", "10:40", ["Danke"]],
    ]);
  });
  it("leaves prose alone", () => {
    expect(parseTeamsChat("Treffen um 10:30\nBitte pünktlich sein.\nPause gegen 12:00\nKantine")).toBeNull();
    expect(parseTeamsChat("Max Mustermann 10:32\nHallo")).toBeNull();
    expect(classifyPaste("Das Meeting beginnt um 10:30.\nWir besprechen den Rollout.\n")).toBeNull();
  });
});

describe("URLs", () => {
  it("accepts one http(s) URL", () => {
    expect(singleUrl("  https://example.com/a?b=1#c \n")).toBe("https://example.com/a?b=1#c");
    expect(singleUrl("http://intranet.firma.local/wiki")).toBe("http://intranet.firma.local/wiki");
  });
  it("refuses other schemes, text with spaces and several URLs", () => {
    for (const t of ["ftp://x.de", "file:///C:/x", "javascript:alert(1)", "siehe https://x.de", "https://a.de https://b.de", "https://"]) expect(singleUrl(t)).toBeNull();
  });
  it("classifies a URL", () => {
    expect(classifyPaste("https://example.com")).toEqual({ kind: "url", url: "https://example.com" });
  });
});

describe("stack traces and logs", () => {
  it("Java", () => {
    const t = `Exception in thread "main" java.lang.NullPointerException: x ist null
\tat com.firma.app.Service.run(Service.java:42)
\tat com.firma.app.Main.main(Main.java:10)
Caused by: java.io.IOException
\t... 3 more`;
    expect(detectTrace(t)).toEqual({ language: "java" });
  });
  it(".NET", () => {
    const t = `System.InvalidOperationException: Sequence contains no elements
   at System.Linq.ThrowHelper.ThrowNoElementsException()
   at Firma.App.Program.Main(String[] args) in C:\\src\\Program.cs:line 12`;
    expect(detectTrace(t)).toEqual({ language: "csharp" });
  });
  it("Python", () => {
    const t = `Traceback (most recent call last):
  File "/app/main.py", line 3, in <module>
    main()
ZeroDivisionError: division by zero`;
    expect(detectTrace(t)).toEqual({ language: "python" });
  });
  it("JavaScript / Node", () => {
    const t = `TypeError: Cannot read properties of undefined (reading 'x')
    at render (webpack://app/./src/App.tsx:12:5)
    at async main (/srv/app/index.js:4:3)`;
    expect(detectTrace(t)).toEqual({ language: "javascript" });
  });
  it("logs with timestamps and levels", () => {
    const t = "2026-09-24 10:32:01,123 INFO  Server gestartet\n2026-09-24 10:32:05,001 ERROR Verbindung verloren\n2026-09-24 10:32:06 WARN Neuer Versuch";
    expect(detectTrace(t)).toEqual({ language: null });
    expect(classifyPaste(t)).toEqual({ kind: "code", code: t, language: null });
  });
  it("prose with 'Error:' or 'at' stays prose", () => {
    expect(detectTrace("Error: das war nichts\nWir treffen uns at home.")).toBeUndefined();
    expect(detectTrace("Wir sind at the office (heute)\nund morgen at home (morgen)")).toBeUndefined();
    expect(classifyPaste("Ein ganz normaler Absatz.\n\nNoch einer mit einer Zeit 10:30 drin.")).toBeNull();
  });
  it("text copied inside the editor is never reclassified", () => {
    expect(classifyPaste("A\tB\n1\t2", '<p data-pm-slice="1 1 []">A</p>')).toBeNull();
  });
});
