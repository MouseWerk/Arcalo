import { describe, expect, it } from "vitest";
import { cleanTitleChars, outgoingLinks } from "./links";

describe("outgoingLinks", () => {
  it("splits page links from file embeds", () => {
    const md = "[[Architektur]] und [[architektur|A]] ![[Bild.png|300]] ![[Skizze.excalidraw]] ![[Angebot.pdf]] ![[Notiz]] [[Version 1.2]] [[Seite#Teil]]";
    expect(outgoingLinks(md)).toEqual({
      pages: ["Architektur", "Notiz", "Version 1.2", "Seite"],
      files: ["Bild.png", "Skizze.excalidraw", "Angebot.pdf"],
    });
  });
});

describe("cleanTitleChars", () => {
  it("replaces the characters links use, like the core", () => {
    expect(cleanTitleChars("C# Grundlagen [Teil|1]^")).toBe("C\uFF03 Grundlagen (Teil\uFF5C1)\uFF3E");
    expect(cleanTitleChars("Ganz normal ")).toBe("Ganz normal ");
  });
});
