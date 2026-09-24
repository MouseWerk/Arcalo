import { describe, expect, it } from "vitest";
import { elapsedLabel, extractNotes, fitScale, jumpTarget, prepareSlideMarkdown, splitSlides, stripFrontmatter } from "./slides";

describe("splitSlides", () => {
  it("teilt an horizontalen Linien", () => {
    const s = splitSlides("# Start\n\nHallo\n\n---\n\n## Zweite\n\n- a\n- b\n\n***\n\nDritte");
    expect(s.map((x) => x.title)).toEqual(["Start", "Zweite", "Dritte"]);
    expect(s[1].markdown).toBe("## Zweite\n\n- a\n- b");
    expect(s.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it("ignoriert --- in Codeblöcken (auch ~~~ und längere Zäune)", () => {
    const md = "# A\n\n```yaml\n---\nkey: 1\n---\n```\n\n---\n\n# B\n\n````md\n```\n---\n```\n````\n\n~~~\n***\n~~~";
    const s = splitSlides(md);
    expect(s).toHaveLength(2);
    expect(s[0].markdown).toContain("```yaml\n---\nkey: 1\n---\n```");
    expect(s[1].markdown).toContain("````md\n```\n---\n```\n````");
    expect(s[1].markdown).toContain("~~~\n***\n~~~");
  });

  it("--- direkt unter Text ist eine Überschrift, keine Trennlinie", () => {
    expect(splitSlides("Titel\n---\n\nText")).toHaveLength(1);
    expect(splitSlides("Text\n***\nmehr")).toHaveLength(2);
    expect(splitSlides("## Kopf\n---\nText")).toHaveLength(2);
  });

  it("überspringt Frontmatter und leere Folien", () => {
    const s = splitSlides("---\ntags: [a]\nvorgang: NP-1/10\n---\n---\n\nEins\n\n---\n\n---\n\nZwei\n\n---\n");
    expect(s.map((x) => x.markdown)).toEqual(["Eins", "Zwei"]);
  });

  it("ohne Trennlinien wird an H1 geteilt, sonst eine Folie", () => {
    expect(splitSlides("Intro\n\n# Eins\n\nx\n\n# Zwei\n\ny").map((x) => x.title)).toEqual(["Intro", "Eins", "Zwei"]);
    expect(splitSlides("# Eins\n\nx\n\n## Unter\n\n```\n# kein H1\n```").map((x) => x.title)).toEqual(["Eins"]);
    expect(splitSlides("")).toEqual([]);
  });

  it("Titel ohne Überschrift: erste Zeile ohne Markup", () => {
    expect(splitSlides("- [ ] **Wichtig**: [[Kunde X|Kunde]] anrufen")[0].title).toBe("Wichtig: Kunde anrufen");
    expect(splitSlides("![[bild.png]]")[0].title).toBe("Folie 1");
  });
});

describe("Sprechernotizen", () => {
  it("Callout [!notiz] mit allen >-Zeilen wird zur Notiz", () => {
    const r = extractNotes("# Folie\n\n> [!notiz] Begrüßung\n> Namen nennen\n> - Agenda zeigen\n\nText");
    expect(r.markdown).toBe("# Folie\n\nText");
    expect(r.notes).toBe("Begrüßung\nNamen nennen\n- Agenda zeigen");
  });

  it("Absatz mit Notiz: wird zur Notiz, andere Callouts bleiben", () => {
    const r = extractNotes("Inhalt\n\nNotiz: langsam sprechen\nund lächeln\n\n> [!warning] Achtung\n> bleibt");
    expect(r.notes).toBe("langsam sprechen\nund lächeln");
    expect(r.markdown).toBe("Inhalt\n\n> [!warning] Achtung\n> bleibt");
  });

  it("Notiz: mitten im Absatz, in Listen oder in Code bleibt Inhalt", () => {
    const md = "Satz\nNotiz: kein Anfang\n\n- Notiz: Listenpunkt\n\n```\nNotiz: im Code\n> [!notiz] auch\n```";
    const r = extractNotes(md);
    expect(r.notes).toBe("");
    expect(r.markdown).toBe(md);
  });

  it("mehrere Notizen einer Folie werden verbunden; [!speaker] geht auch", () => {
    const s = splitSlides("A\n\n> [!speaker]\n> eins\n\nNotiz: zwei\n\n---\n\nB");
    expect(s[0].notes).toBe("eins\n\nzwei");
    expect(s[0].markdown).toBe("A");
    expect(s[1].notes).toBe("");
  });
});

describe("prepareSlideMarkdown", () => {
  it("macht aus Einbettungen Platzhalter, außer in Code", () => {
    const out = prepareSlideMarkdown('![[bild.png|300]] und ![[Plan.excalidraw]]\n```\n![[nicht.png]]\n```');
    expect(out).toContain('<span class="slide-embed" data-embed="bild.png" data-width="300"></span>');
    expect(out).toContain('data-embed="Plan.excalidraw"></span>');
    expect(out).toContain("```\n![[nicht.png]]\n```");
  });

  it("gebuchte Zeit zeigt ihren Text", () => {
    expect(prepareSlideMarkdown('<time-entry id="3" hours="1,5" target="NP-1">Review</time-entry>')).toBe('<span class="slide-zeit">1,5 h · Review</span>');
  });

  it("Markierung ==x== wird <mark>, nicht in Code", () => {
    expect(prepareSlideMarkdown("Das ist ==wichtig== und `a==b==c`")).toBe("Das ist <mark>wichtig</mark> und `a==b==c`");
    expect(prepareSlideMarkdown("```\n==bleibt==\n```")).toBe("```\n==bleibt==\n```");
  });

  it("Spalten werden ein Raster mit Markdown in jeder Spalte", () => {
    const out = prepareSlideMarkdown("<!-- spalten -->\n- links\n<!-- spalte -->\n**rechts**\n<!-- /spalten -->");
    expect(out).toBe(['', '<div class="slide-columns"><div class="slide-column">', "", "- links", "", '</div><div class="slide-column">', "", "**rechts**", "", "</div></div>", ""].join("\n"));
  });

  it("[TOC] zeigt die anderen Folien, ohne Liste verschwindet es", () => {
    expect(prepareSlideMarkdown("# Agenda\n[TOC]", { toc: ["Start", "A & B"] })).toContain('<ol class="slide-toc"><li>Start</li><li>A &amp; B</li></ol>');
    expect(prepareSlideMarkdown("# Agenda\n[TOC]")).toBe("# Agenda");
  });
});

describe("Folien mit Editor-Blöcken", () => {
  const md = "# Agenda\n\n[TOC]\n\n---\n\n# Eins\n\nText[^b] und ==neu==\n\n---\n\n# Zwei\n\nMehr[^a] und wieder[^b]\n\n```\n[^c] im Code\n```\n\n---\n\n[^a]: Quelle A\n[^b]: Quelle **B**\n    zweite Zeile";

  it("Fußnoten: über die Notiz nummeriert, Definitionen an jeder Folie, keine Folie nur aus Definitionen", () => {
    const s = splitSlides(md);
    expect(s.map((x) => x.title)).toEqual(["Agenda", "Eins", "Zwei"]);
    expect(s[1].footnotes).toEqual([{ n: 1, label: "b", text: "Quelle **B**\nzweite Zeile" }]);
    expect(s[2].footnotes).toEqual([
      { n: 2, label: "a", text: "Quelle A" },
      { n: 1, label: "b", text: "Quelle **B**\nzweite Zeile" },
    ]);
    const out = prepareSlideMarkdown(s[2].markdown, s[2]);
    expect(out).toContain('Mehr<sup class="slide-fn">2</sup> und wieder<sup class="slide-fn">1</sup>');
    expect(out).toContain("```\n[^c] im Code\n```");
    expect(out).toContain('<div class="slide-footnotes">\n\n<sup class="slide-fn">2</sup> Quelle A\n\n<sup class="slide-fn">1</sup> Quelle **B** zweite Zeile\n\n</div>');
    expect(out).not.toMatch(/\[\^[ab]\]/);
  });

  it("[TOC] listet die übrigen Folien", () => {
    const s = splitSlides(md);
    expect(s[0].toc).toEqual(["Eins", "Zwei"]);
    expect(splitSlides("# Ende[^w]\n\n[^w]: Danke")[0].title).toBe("Ende");
    expect(s[1].toc).toBeUndefined();
    expect(splitSlides("[TOC]\n\n---\n\n# A")[0].title).toBe("Inhalt");
  });
});

describe("Hilfen", () => {
  it("Sprung per Nummer", () => {
    expect(jumpTarget("3", 10)).toBe(2);
    expect(jumpTarget("99", 10)).toBe(9);
    expect(jumpTarget("0", 10)).toBe(0);
    expect(jumpTarget("", 10)).toBeNull();
  });
  it("Zeit und Einpassen", () => {
    expect(elapsedLabel(65_000)).toBe("01:05");
    expect(elapsedLabel(3_725_000)).toBe("1:02:05");
    expect(fitScale({ width: 1000, height: 2000 }, { width: 1000, height: 1000 })).toBe(0.5);
    expect(fitScale({ width: 500, height: 500 }, { width: 1000, height: 1000 })).toBe(1);
  });
  it("Frontmatter nur mit Schlüssel", () => {
    expect(stripFrontmatter("---\na: 1\n---\nText")).toBe("Text");
    expect(stripFrontmatter("---\n\nText")).toBe("---\n\nText");
  });
});
