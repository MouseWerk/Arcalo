import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ IS_LINUX: true, IS_MAC: false }));
const scheme = vi.hoisted(() => ({ base: "arcalo-asset://localhost/" }));
vi.mock("./platform", () => platform);
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (name: string) => scheme.base + encodeURIComponent(name),
  invoke: vi.fn(async (cmd: string, args: { name: string }) => {
    if (cmd !== "attachment_read") throw new Error(cmd);
    if (args.name === "fehlt.flac") throw "not found";
    return new Uint8Array([102, 76, 97, 67]).buffer;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { attachmentMedia } from "./api";
import { Editor } from "@tiptap/core";
import { buildExtensions } from "../editor/schema";
import { audioType } from "../editor/fileEmbed";

describe("audio for the player", () => {
  let created: Blob[] = [];
  let revoked: string[] = [];
  beforeEach(() => {
    created = [];
    revoked = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      created.push(b as Blob);
      return `blob:app/${created.length}`;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    vi.mocked(invoke).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    platform.IS_LINUX = true;
    scheme.base = "arcalo-asset://localhost/";
  });

  it("knows the media types of playable audio", () => {
    expect(audioType("Sprachnotiz 2026-10-01 14-30.flac")).toBe("audio/flac");
    expect(audioType("Aufnahme.WAV")).toBe("audio/wav");
    expect(audioType("Musik.mp3")).toBe("audio/mpeg");
    expect(audioType("Angebot.pdf")).toBe("");
  });

  it("plays from a blob on WebKitGTK, whose GStreamer refuses the app's scheme", async () => {
    const m = await attachmentMedia("ordner/Ton 1.flac", "audio/flac");
    expect(m.src).toBe("blob:app/1");
    // Only the plain name goes to the backend, which resolves it inside the attachments folder.
    expect(invoke).toHaveBeenCalledWith("attachment_read", { name: "Ton 1.flac" });
    expect(created[0].type).toBe("audio/flac");
    expect(created[0].size).toBe(4);
    m.release();
    expect(revoked).toEqual(["blob:app/1"]);
  });

  it("uses the scheme's address where the webview plays it", async () => {
    platform.IS_LINUX = false;
    const m = await attachmentMedia("Ton 1.flac", "audio/flac");
    expect(m.src).toBe("arcalo-asset://localhost/Ton%201.flac");
    expect(invoke).not.toHaveBeenCalled();
    // Android (Linux, but an http address) plays it as well.
    platform.IS_LINUX = true;
    scheme.base = "http://arcalo-asset.localhost/";
    expect((await attachmentMedia("Ton 1.flac", "audio/flac")).src).toBe("http://arcalo-asset.localhost/Ton%201.flac");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("the player gets the address, shows the hint when there is none, and frees it", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    try {
      const editor = new Editor({
        element: document.createElement("div"),
        extensions: buildExtensions({ attachmentMedia }),
        content: "![[Ton 1.flac]] und ![[fehlt.flac]]\n",
        contentType: "markdown",
      });
      await vi.waitFor(() => expect(editor.view.dom.querySelector('[data-file="Ton 1.flac"] audio')?.getAttribute("src")).toBe("blob:app/1"));
      await vi.waitFor(() => expect(editor.view.dom.querySelector('[data-file="fehlt.flac"]')?.classList.contains("is-unplayable")).toBe(true));
      expect(editor.view.dom.querySelector('[data-file="Ton 1.flac"]')?.classList.contains("is-unplayable")).toBe(false);
      editor.destroy();
      expect(revoked).toEqual(["blob:app/1"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
