import { describe, expect, it } from "vitest";
import { outgoingLinks } from "./links";

describe("outgoingLinks", () => {
  it("splits page links from file embeds", () => {
    const md = "[[Architektur]] und [[architektur|A]] ![[Bild.png|300]] ![[Skizze.excalidraw]] ![[Angebot.pdf]] ![[Notiz]] [[Version 1.2]] [[Seite#Teil]]";
    expect(outgoingLinks(md)).toEqual({
      pages: ["Architektur", "Notiz", "Version 1.2", "Seite"],
      files: ["Bild.png", "Skizze.excalidraw", "Angebot.pdf"],
    });
  });
});
