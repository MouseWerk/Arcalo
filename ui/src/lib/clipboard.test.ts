import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const { copyHtml, copyImage, copyText } = await import("./clipboard");

const notAllowed = () => Object.assign(new Error("The request is not allowed by the user agent"), { name: "NotAllowedError" });
function webClipboard(writeText: (t: string) => Promise<void>, write: (items: unknown[]) => Promise<void> = () => Promise.reject(notAllowed())) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText, write }, configurable: true });
}
// happy-dom has no ClipboardItem: a stand-in that keeps what it was given.
(globalThis as { ClipboardItem?: unknown }).ClipboardItem ??= class {
  constructor(readonly items: Record<string, Blob>) {}
  get types() {
    return Object.keys(this.items);
  }
};
afterEach(() => invoke.mockReset());

describe("copyText", () => {
  it("writes with the web clipboard when it may", async () => {
    const written: string[] = [];
    webClipboard(async (t) => void written.push(t));
    await copyText("/data/arcalo");
    expect(written).toEqual(["/data/arcalo"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("goes through the app when WebKit refuses a click without user activation (NotAllowedError)", async () => {
    webClipboard(() => Promise.reject(notAllowed()));
    invoke.mockResolvedValue(undefined);
    await copyText("/data/arcalo");
    expect(invoke).toHaveBeenCalledWith("clipboard_write", { text: "/data/arcalo" });
  });

  it("rejects with the web clipboard's error when the app cannot copy either (phones)", async () => {
    webClipboard(() => Promise.reject(notAllowed()));
    invoke.mockRejectedValue("unknown command");
    await expect(copyText("x")).rejects.toMatchObject({ name: "NotAllowedError" });
  });

  it("formatted text: the web clipboard with HTML and plain text, else the app with both", async () => {
    const written: unknown[] = [];
    webClipboard(() => Promise.reject(new Error("not used")), async (items) => void written.push(...items));
    await copyHtml("<p><b>Hi</b></p>", "Hi");
    expect((written[0] as ClipboardItem).types).toEqual(["text/html", "text/plain"]);
    expect(invoke).not.toHaveBeenCalled();
    webClipboard(() => Promise.reject(new Error("not used")));
    invoke.mockResolvedValue(undefined);
    await copyHtml("<p><b>Hi</b></p>", "Hi");
    expect(invoke).toHaveBeenCalledWith("clipboard_write", { text: "Hi", html: "<p><b>Hi</b></p>" });
    invoke.mockRejectedValue("unknown command");
    await expect(copyHtml("<p>x</p>", "x")).rejects.toMatchObject({ name: "NotAllowedError" });
  });

  it("an image: refused by the web clipboard, the app gets its pixels and size", async () => {
    webClipboard(() => Promise.reject(new Error("not used")));
    const pixels = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({ width: 2, height: 1 });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: () => {}, getImageData: () => ({ data: pixels }) } as unknown as CanvasRenderingContext2D);
    invoke.mockResolvedValue(undefined);
    await copyImage(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    const [cmd, body, opts] = invoke.mock.calls[0];
    expect(cmd).toBe("clipboard_write_image");
    expect([...(body as Uint8Array)]).toEqual([...pixels]);
    expect(opts).toEqual({ headers: { "x-arcalo-width": "2", "x-arcalo-height": "1" } });
    invoke.mockRejectedValue("unknown command");
    await expect(copyImage(new Blob([], { type: "image/png" }))).rejects.toMatchObject({ name: "NotAllowedError" });
    getContext.mockRestore();
  });

  it("is the only place that writes to the web clipboard (text, formatted text, images)", () => {
    const src = path.resolve(__dirname, "..");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "locales" ? [] : walk(path.join(d, e.name))) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(d, e.name)] : []));
    const found = walk(src)
      .filter((f) => !f.endsWith(path.join("lib", "clipboard.ts")))
      .filter((f) => /navigator\.clipboard\??\.write(Text)?\b/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f));
    expect(found).toEqual([]);
  });
});
