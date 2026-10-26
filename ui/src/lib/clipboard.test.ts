import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const { copyText } = await import("./clipboard");

const notAllowed = () => Object.assign(new Error("The request is not allowed by the user agent"), { name: "NotAllowedError" });
function webClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}
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

  it("is the only place that writes text to the web clipboard", () => {
    const src = path.resolve(__dirname, "..");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "locales" ? [] : walk(path.join(d, e.name))) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(d, e.name)] : []));
    const found = walk(src)
      .filter((f) => !f.endsWith(path.join("lib", "clipboard.ts")))
      .filter((f) => /navigator\.clipboard\??\.writeText\(/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(src, f));
    expect(found).toEqual([]);
  });
});
