// „Seite anhängen“ in the chat view: pages by part of their title, the ones starting with it first.

import { describe, expect, it } from "vitest";
import { matchPages } from "./AttachPage";
import { suggestionKeys } from "../../views/ChatView";

const page = (id: number, title: string, deleted_at: string | null = null) => ({ id, title, deleted_at });

describe("matchPages", () => {
  const pages = [page(1, "Projekt Atlas"), page(2, "Atlas Stand"), page(3, "Bravo"), page(4, "Atlas alt", "2026-01-01"), page(5, "Notizen zu atlas")];
  it("finds titles containing the query, starting ones first, then by title, never deleted pages", () => {
    expect(matchPages(pages, "atlas").map((p) => p.id)).toEqual([2, 5, 1]);
    expect(matchPages(pages, "  ")).toEqual([]);
    expect(matchPages(pages, "atlas", 2).map((p) => p.id)).toEqual([2, 5]);
    expect(matchPages(pages, "zzz")).toEqual([]);
  });
});

describe("chat view suggestions", () => {
  it("offers four starting points, one about the notes only when they are on", () => {
    expect(suggestionKeys(false).map((s) => s.label)).toEqual(["chatv.sug.explain", "chatv.sug.improve", "chatv.sug.mail", "chatv.sug.ideas"]);
    expect(suggestionKeys(true).map((s) => s.label)).toContain("chatv.sug.notes");
    expect(suggestionKeys(true)).toHaveLength(4);
  });
});
